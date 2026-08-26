-- 0042 — Las tareas automáticas dejan de ahogar la agenda: cupo de 5 por día
-- por persona, y limpieza de lo que ya se acumuló.
--
-- QUÉ PASABA (medido el 26/8, en la reunión con Juan y Rocío):
--   · 627 tareas pendientes, 617 vencidas. Juan 581, Rocío 46.
--   · De las 46 de Rocío, 38 las inventó el CRM (36 de "sin contacto en 30 días")
--     y solo 8 son las que Pancho le asignó a mano el 23/8.
--   · 579 de las 627 salen de una sola regla, `prospecto_sin_seguimiento`.
--   · pg_cron corre evaluate_automations() cada hora (minuto 10) y cada regla
--     puede crear hasta 25 por vuelta: 281 tareas el 23/8, 330 el 24/8. El 23/8
--     se habían cancelado 373 a mano y al día siguiente ya estaban de vuelta.
--
-- LA DECISIÓN (Pancho, 26/8): "hacé una limpieza y poné tope 5 por día para que
-- sean reales".
--
-- CÓMO. Un trigger antes del insert, no un parche en cada rama de
-- evaluate_automations(): así el cupo vale para las cuatro reglas que crean
-- tareas (`caso_atrasado`, `sin_contacto`, `acreditado_no_activado`,
-- `prospecto_sin_seguimiento`) y para cualquiera que se agregue después. Las
-- tareas creadas a mano NO pasan por el cupo: `automation_rule_id is null`.
--
-- Tres frenos, todos sobre tareas automáticas:
--   1. máximo 5 creadas por persona por día (día de México)
--   2. máximo 5 abiertas por persona a la vez — si no las hace, no le llegan más
--   3. nada de resucitar: si la misma regla ya tuvo una tarea para ese doctor
--      cancelada o completada en los últimos 30 días, no se vuelve a crear
--
-- Los doctores que quedan fuera del cupo NO se pierden: siguen priorizados y
-- visibles en /hoy, /pipeline y /prospeccion. Lo único que dejan de hacer es
-- ensuciar la agenda.
--
-- Rollback: supabase/rollbacks/0042_tareas_cupo_rollback.sql

-- ---------------------------------------------------------------------------
-- 1) Limpieza: cancelar las automáticas pendientes que nadie tocó nunca.
--    `outcome is null` = ninguna persona la trabajó. Las creadas a mano
--    (automation_rule_id is null) no se tocan.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  perform set_config('app.system', 'on', true);
  perform set_config('app.source', 'migracion_0042', true);

  update tasks
     set status = 'cancelada'
   where status = 'pendiente'
     and outcome is null
     and automation_rule_id is not null;
  get diagnostics n = row_count;
  raise notice '0042 limpieza: % tareas automáticas pendientes canceladas', n;
end $$;

-- ---------------------------------------------------------------------------
-- 2) El cupo
-- ---------------------------------------------------------------------------
create or replace function tasks_cupo_automatico() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cupo_diario  constant int := 5;
  cupo_abierto constant int := 5;
  hoy_mx date := (now() at time zone 'America/Mexico_City')::date;
  creadas_hoy int;
  abiertas int;
begin
  -- las tareas cargadas por una persona no tienen cupo
  if new.automation_rule_id is null then
    return new;
  end if;
  -- sin dueño no hay a quién contarle el cupo: que entre y la vea el manager
  if new.assigned_to is null then
    return new;
  end if;

  -- freno 3: no resucitar lo que ya se cerró o se descartó hace poco
  if new.doctor_id is not null and exists (
    select 1 from tasks t
     where t.doctor_id = new.doctor_id
       and t.automation_rule_id = new.automation_rule_id
       and t.status in ('cancelada', 'completada')
       and t.updated_at > now() - interval '30 days'
  ) then
    return null;
  end if;

  -- freno 1: cupo del día
  select count(*) into creadas_hoy
    from tasks t
   where t.assigned_to = new.assigned_to
     and t.automation_rule_id is not null
     and (t.created_at at time zone 'America/Mexico_City')::date = hoy_mx;
  if creadas_hoy >= cupo_diario then
    return null;
  end if;

  -- freno 2: si tiene 5 automáticas abiertas, no le mandamos más
  select count(*) into abiertas
    from tasks t
   where t.assigned_to = new.assigned_to
     and t.automation_rule_id is not null
     and t.status = 'pendiente';
  if abiertas >= cupo_abierto then
    return null;
  end if;

  return new;
end $$;

comment on function tasks_cupo_automatico() is
  'Cupo de tareas automáticas: 5 creadas por día y 5 abiertas por persona, sin resucitar lo cancelado en los últimos 30 días. Las tareas cargadas a mano no pasan por acá.';

-- El nombre arranca con "tasks_z" A PROPÓSITO: en Postgres los triggers BEFORE
-- de una misma tabla corren en orden alfabético, y este necesita que
-- tasks_default_owner_trg (0021) ya haya resuelto `assigned_to`.
drop trigger if exists tasks_z_cupo_automatico_trg on tasks;
create trigger tasks_z_cupo_automatico_trg
  before insert on tasks
  for each row execute function tasks_cupo_automatico();

revoke all on function tasks_cupo_automatico() from public, anon;

-- ---------------------------------------------------------------------------
-- 3) Bajar el tope por corrida de las reglas: con el cupo del trigger, pedir 25
--    por vuelta es tirar 20 al piso cada hora. 5 alcanza y deja el log honesto.
-- ---------------------------------------------------------------------------
update automation_rules
   set params = jsonb_set(coalesce(params, '{}'::jsonb), '{max_per_run}', '5'::jsonb),
       descripcion = 'Prospecto calificado (interés 3+, 2+ casos/mes estimados, o con reunión) sin contacto en 14 días. Tope de 5 por corrida y cupo global de 5 por persona por día (0042).'
 where key = 'prospecto_sin_seguimiento';

do $$
declare pend int; auto int;
begin
  select count(*) into pend from tasks where status = 'pendiente' and not is_demo;
  select count(*) into auto from tasks where status = 'pendiente' and not is_demo and automation_rule_id is not null;
  raise notice '0042 OK: quedan % tareas pendientes, % automáticas. Cupo 5/día y 5 abiertas por persona.', pend, auto;
end $$;

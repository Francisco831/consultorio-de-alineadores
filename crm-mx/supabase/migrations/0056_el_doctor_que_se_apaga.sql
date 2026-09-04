-- 0056 — El doctor que se apaga.
--
-- Sobre el eje que instaló 0055, la única llamada que hoy no se está haciendo:
-- 16 doctores acreditados mandan etapas posteriores todos los meses y hace
-- entre 3 y 12 meses que no traen un paciente nuevo. Trabajan con nosotros, nos
-- deben trabajo, y nadie les preguntó qué pasó. Son la conversación más fácil
-- de la cartera y la más rentable: recuperar a uno que ya está adentro cuesta
-- menos que acreditar a uno nuevo.
--
-- El piso de 91 días sale de los silencios que SÍ se rompieron: sobre 405
-- huecos entre primeras etapas de acreditados, el 79% se cerró antes de los 100
-- días y el 86% antes de los 150. Pasando los 90, el doctor ya salió del
-- comportamiento de cuatro de cada cinco retornos: dejó de ser su ritmo normal.
--
-- El techo de 365 saca a otros 10 que también mandan etapas posteriores pero
-- cuyo último paciente nuevo fue hace más de un año: 10 de ellos no tienen ni
-- owner asignado y su priority_score promedio es 2 sobre 100. El sistema ya los
-- soltó y meterlos en la cola diaria la haría ilegible. Son una revisión
-- trimestral, no una tarea.
--
-- Quedan afuera también 5 doctores del segmento que no tienen NINGÚN I_1
-- registrado: su primer caso es anterior al 12/9/2024, que es donde arranca el
-- espejo de casos. No se les puede medir "hace cuánto que no trae un paciente"
-- porque nunca vimos el primero. Se ven igual con el chip y el badge de la
-- lista; lo que no reciben es la tarea, porque el texto de la tarea sería falso.
--
-- LA REGLA NACE APAGADA. Crea tareas asignadas a una persona: encenderla es una
-- decisión de operación, no de sistema. Se prende con un click en /ajustes.
-- Cuando se prenda, el cupo de 0042 la modera sola: 5 tareas por día y 5
-- abiertas por persona, así que los 16 entran en tres o cuatro días, no de
-- golpe. El freno 3 (no resucitar lo cancelado en 30 días) no la afecta: mira
-- por automation_rule_id y esta regla es nueva.
--
-- POR QUÉ NO VA ADENTRO DE evaluate_automations(). Mismo motivo que 0054: no
-- necesita nada de las otras ramas y entrar a esa cadena de 354 líneas para
-- agregar una es el cambio más caro de la propuesta. Va como función propia con
-- su cron y su fila en automation_rules, así que el botón de /ajustes, los
-- params y last_run_at funcionan igual que con el resto.
--
-- Rollback: supabase/rollbacks/0056_el_doctor_que_se_apaga_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. La regla
-- ---------------------------------------------------------------------------
insert into automation_rules (key, nombre, descripcion, enabled, params, creates_task, task_type)
values ('se_apaga', 'Doctor que se apaga',
  'Manda segundas, terceras o cuartas etapas pero hace entre 91 y 365 días que no trae un paciente nuevo. Alerta + tarea de llamada al owner.',
  false, '{"dias_min": 91, "dias_max": 365}', true, 'llamada')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. El evaluador
-- ---------------------------------------------------------------------------
create or replace function evaluar_se_apaga() returns int
language plpgsql security definer set search_path = public as $fn$
declare
  rule record;
  v_previo text;
  v_min int;
  v_max int;
  v_count int := 0;
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede ejecutar las automatizaciones';
  end if;

  select * into rule from automation_rules where key = 'se_apaga';
  if not found or not rule.enabled then
    return 0;
  end if;

  v_previo := coalesce(current_setting('app.system', true), '');
  perform set_config('app.system', 'on', true);
  perform set_config('app.source', 'automation', true);

  v_min := coalesce((rule.params->>'dias_min')::int, 91);
  v_max := coalesce((rule.params->>'dias_max')::int, 365);

  -- 2.a) primero cerrar: el que volvió a traer un paciente ya no se está
  -- apagando. Sin esta parte el índice de dedupe (0002:218) deja la alerta
  -- abierta para siempre y el bloque de /hoy sólo crece.
  update alerts a
     set status = 'resuelta', resolved_at = now()
   where a.rule_key = 'se_apaga'
     and a.status = 'abierta'
     and not exists (
       select 1 from doctors d
        where d.id = a.doctor_id
          and d.actividad_90d = 'solo_termina'
          and d.last_new_case_at between ai_mx_today() - v_max and ai_mx_today() - v_min
     );

  -- 2.b) después abrir
  with candidatos as (
    select d.* from doctors d
     where d.is_accredited and not d.is_demo
       and d.actividad_90d = 'solo_termina'
       and d.last_new_case_at between ai_mx_today() - v_max and ai_mx_today() - v_min
  ), ins as (
    insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
    select rule.key, c.id, 'alta',
      format('%s se está apagando', c.nombre),
      format('Mandó %s etapa(s) en 90 días pero hace %s días que no trae un paciente nuevo. Sigue trabajando con nosotros.',
        c.posteriores_90d + c.servicio_90d,
        ai_mx_today() - c.last_new_case_at),
      c.is_demo
      from candidatos c
     where not exists (select 1 from alerts a
       where a.rule_key = rule.key and a.doctor_id = c.id and a.status = 'abierta')
    returning 1
  )
  select count(*) into v_count from ins;

  -- 2.c) y la tarea, que es lo que hace que pase algo. El patrón es el de
  -- acreditado_no_activado (0047:155-169): insert separado del CTE de alertas,
  -- guardado por creates_task y con anti-duplicado por regla + doctor.
  insert into tasks (doctor_id, type, title, due_date, assigned_to,
                     automation_rule_id, is_demo)
  select c.id, coalesce(rule.task_type, 'llamada'),
    format('Llamar a %s: sigue mandando casos pero dejó de traer pacientes', c.nombre),
    ai_mx_today(), c.owner_id, rule.id, c.is_demo
    from doctors c
   where rule.creates_task
     and c.is_accredited and not c.is_demo
     and c.actividad_90d = 'solo_termina'
     and c.last_new_case_at between ai_mx_today() - v_max and ai_mx_today() - v_min
     and not exists (select 1 from tasks t
       where t.doctor_id = c.id and t.status = 'pendiente'
         and t.automation_rule_id = rule.id);

  update automation_rules set last_run_at = now(),
    run_stats = jsonb_build_object('last_created', v_count)
   where id = rule.id;

  perform set_config('app.system', v_previo, true);
  return v_count;
end $fn$;

comment on function evaluar_se_apaga() is
  'Alerta y tarea para el doctor que manda etapas posteriores pero dejó de traer pacientes nuevos. Respeta el interruptor de automation_rules y cierra sola la alerta del que vuelve.';

revoke all on function evaluar_se_apaga() from public, anon;
grant execute on function evaluar_se_apaga() to authenticated, service_role;

-- minuto 30: después del evaluador (10) y de la limpieza de huérfanas (15), y
-- después del recálculo del eje de las 11:20, del que depende.
do $$
begin
  perform cron.schedule('crm-se-apaga', '30 * * * *', 'select evaluar_se_apaga()');
exception when others then
  raise notice 'pg_cron no disponible (%). Programar evaluar_se_apaga() manualmente.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Verificación (en seco: la regla nace apagada, así que no crea nada)
-- ---------------------------------------------------------------------------
do $$
declare v_cand int; v_afuera_365 int; v_afuera_sin_i1 int; v_creadas int;
begin
  select count(*) filter (where last_new_case_at between ai_mx_today()-365 and ai_mx_today()-91),
         count(*) filter (where last_new_case_at < ai_mx_today()-365),
         count(*) filter (where last_new_case_at is null)
    into v_cand, v_afuera_365, v_afuera_sin_i1
    from doctors where is_accredited and not is_demo and actividad_90d = 'solo_termina';
  v_creadas := evaluar_se_apaga();
  raise notice '0056 OK: % candidatos cuando se encienda (% quedan afuera por más de un año, % por no tener ningún I_1 registrado). Creadas ahora: % — la regla nace apagada.',
    v_cand, v_afuera_365, v_afuera_sin_i1, v_creadas;
end $$;

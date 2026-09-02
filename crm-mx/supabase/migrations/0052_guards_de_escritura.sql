-- 0052 — Las cuatro puertas por las que un error se lleva datos puestos.
--
-- Ninguna de estas es una puerta a internet: hay que tener cuenta en el CRM para
-- empujarlas, y las tres cuentas que existen son de gente que ya ve todos estos
-- datos. Pero la app confía en RLS para decidir QUIÉN escribe y no tiene nada
-- que decida QUÉ se escribe: `can_write()` deja tocar cualquier columna de
-- doctors, tasks y opportunities. Eso significa que un PATCH mal armado —o una
-- pantalla futura escrita apurada— puede hacer cosas que ninguna pantalla de hoy
-- ofrece, y algunas no tienen vuelta atrás.
--
-- Las cuatro, en orden de qué tan caro sale:
--
--  1. `is_demo` lo escribe cualquiera. El botón "Borrar datos demo" de Ajustes
--     llama a purge_demo(), que BORRA esas filas, y el borrado de un doctor
--     arrastra en cascada sus actividades, tareas, alertas, oportunidades y
--     recomendaciones. Marcar un doctor real como demo y apretar ese botón es
--     una pérdida definitiva de historia, sin confirmación de por medio.
--  2. `lifecycle_stage` y `last_contact_at` son columnas CALCULADAS (las escribe
--     recompute_doctor a partir de casos, pagos y actividades). Escribirlas a
--     mano no las "corrige": las desincroniza hasta el próximo recálculo, y
--     mientras tanto el doctor entra o sale de los motores de /hoy por un dato
--     que no salió de ningún hecho.
--  3. En `tasks` se puede borrar `automation_rule_id`, que es la marca de "esta
--     tarea la creó el sistema" y lo que hace cumplir el cupo de 5 por día de
--     0042 — el freno que bajó la cola de 627 tareas a 11. Sin esa marca, la
--     tarea deja de contar para el cupo y el flood puede volver.
--  4. `DELETE` de eventos está abierto a cualquiera. Peor que abierto: como RLS
--     rechaza devolviendo cero filas en vez de un error, el botón "Borrar
--     evento" de otra persona hoy dice que borró y no borra nada.
--
-- EL PATRÓN es el que dejó 0030 y repitió 0051: lista blanca + diff jsonb. Se
-- declara lo que SÍ se puede tocar, y todo lo demás —incluida la columna que
-- alguien agregue el año que viene— nace protegido. Al revés (lista negra) hay
-- que acordarse de sumar cada columna nueva, y eso ya falló acá: el guard de
-- `activities` de 0024 era lista negra de tres columnas y no protegía nada de lo
-- que 0051 tuvo que venir a cerrar.
--
-- QUÉ NO CIERRA. Nada de esto le saca visibilidad a nadie: la regla de lectura
-- sigue siendo que todos ven todo (decisión de producto del 8/8). Y el service
-- role sigue escribiendo sin red — es lo que corre los imports y los crons, y
-- `is_system()` los deja pasar a propósito.
--
-- Rollback: supabase/rollbacks/0052_guards_de_escritura_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. doctors: is_demo, y las dos columnas que calcula el motor
-- ---------------------------------------------------------------------------
-- Se suman a la lista que ya protegía los scores. `lifecycle_stage` es seguro
-- protegerlo acá aunque el journey lo escriba: `doctors_guard_trg` corre ANTES
-- que `doctors_journey_trg` (orden alfabético, deliberado desde 0015), así que
-- el guard compara lo que mandó la sesión y recién después el journey deriva la
-- etapa. Y `recompute_doctor()` se declara sistema en su primera línea
-- (0019: `set_config('app.system','on')`), así que sale por el `is_system()` de
-- arriba de todo, igual que ya lo hace para escribir los scores.

create or replace function doctors_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then return new; end if;
  if tg_op = 'INSERT' then
    new.health_score := null;          new.health_factors := null;
    new.health_confidence := null;     new.potential_computed := null;
    new.priority_score := null;        new.priority_reasons := null;
    new.priority_bucket := null;       new.recommended_action := null;
    new.avg_interval_days := null;     new.expected_next_case_at := null;
    new.case_count := 0;               new.new_case_count := 0;
    new.first_case_at := null;         new.last_case_at := null;
    new.last_new_case_at := null;      new.last_contact_at := null;
    new.first_paid_case_at := null;    new.last_paid_case_at := null;
    new.days_to_first_case := null;    new.first_contact_at := null;
    new.first_meeting_at := null;
    new.is_accredited := false;        new.accredited_at := null;
    new.activated_by := null;          new.noloco_id := null;
    -- Un doctor cargado por una persona NUNCA nace demo. El seed sintético
    -- corre con service role, que no pasa por acá.
    new.is_demo := false;
    if not is_manager() then
      new.potential_override := null;
    end if;
    return new;
  end if;
  if new.health_score          is distinct from old.health_score
  or new.health_factors        is distinct from old.health_factors
  or new.health_confidence     is distinct from old.health_confidence
  or new.potential_computed    is distinct from old.potential_computed
  or new.priority_score        is distinct from old.priority_score
  or new.priority_reasons      is distinct from old.priority_reasons
  or new.priority_bucket       is distinct from old.priority_bucket
  or new.recommended_action    is distinct from old.recommended_action
  or new.avg_interval_days     is distinct from old.avg_interval_days
  or new.expected_next_case_at is distinct from old.expected_next_case_at
  or new.case_count            is distinct from old.case_count
  or new.new_case_count        is distinct from old.new_case_count
  or new.first_case_at         is distinct from old.first_case_at
  or new.last_case_at          is distinct from old.last_case_at
  or new.last_new_case_at      is distinct from old.last_new_case_at
  or new.first_paid_case_at    is distinct from old.first_paid_case_at
  or new.last_paid_case_at     is distinct from old.last_paid_case_at
  or new.days_to_first_case    is distinct from old.days_to_first_case
  or new.first_contact_at      is distinct from old.first_contact_at
  or new.first_meeting_at      is distinct from old.first_meeting_at
  -- nuevas en 0052: las dos las deriva recompute_doctor de hechos registrados
  or new.lifecycle_stage       is distinct from old.lifecycle_stage
  or new.last_contact_at       is distinct from old.last_contact_at
  then
    raise exception 'Esas columnas las calcula el sistema a partir de casos, pagos y actividades: se cambian registrando el hecho, no editando el número';
  end if;
  -- ---- el UNIVERSO del doctor: lo mueve el trigger de journey, no el usuario ----
  if new.is_accredited is distinct from old.is_accredited
  or new.accredited_at is distinct from old.accredited_at
  or new.activated_by is distinct from old.activated_by
  or new.noloco_id    is distinct from old.noloco_id
  then
    raise exception 'La acreditación se registra moviendo al doctor a "Acreditado" en el pipeline, no editando el campo';
  end if;
  -- ---- demo: lo marca el seed, y de ahí no se vuelve ----
  -- purge_demo() borra en cascada. Que una sesión pueda marcar un doctor real
  -- como demo es la diferencia entre un click equivocado y perder su historia.
  if new.is_demo is distinct from old.is_demo then
    raise exception 'Marcar o desmarcar un doctor como demo no se hace desde la app: "Borrar datos demo" lo eliminaría con toda su historia';
  end if;
  if not is_manager() then
    if new.owner_id           is distinct from old.owner_id
    or new.clinical_owner_id  is distinct from old.clinical_owner_id
    or new.categoria          is distinct from old.categoria
    or new.potential_override is distinct from old.potential_override
    then
      raise exception 'Solo un manager puede cambiar owner, categoría o potential override';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 2. tasks: se edita el TRABAJO, no la procedencia
-- ---------------------------------------------------------------------------
-- La lista blanca es generosa a propósito: reprogramar, reasignar, cambiar el
-- título o el tipo son cosas que una persona hace todos los días y que la
-- pantalla va a ofrecer (hoy no se puede ni reasignar, y es un pendiente). Lo
-- que queda cerrado es de dónde salió la tarea y a quién pertenece:
--   · `automation_rule_id` — la marca de tarea automática. Es lo que hace
--     cumplir el cupo de 0042; borrarla saltea el freno del flood.
--   · `created_by` — quién la creó. La alarma de asistencia de las 17:30 mide
--     con esto: si se puede reescribir, mide cualquier cosa.
--   · `doctor_id` / `opportunity_id` — mover una tarea de doctor en silencio.
--   · `is_demo` — mismo motivo que en doctors: purge_demo() la borraría.

create or replace function tasks_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  editable text[] := array[
    -- el trabajo en sí
    'status', 'outcome', 'completed_at', 'due_date', 'assigned_to', 'title', 'type',
    -- la pisa set_updated_at() después de este trigger
    'updated_at'
  ];
begin
  if is_system() then return new; end if;
  if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
    raise exception 'De una tarea se cambia qué hay que hacer, para cuándo y de quién es: de dónde salió queda como se creó';
  end if;
  return new;
end $$;

drop trigger if exists tasks_guard_trg on tasks;
-- BEFORE UPDATE y antes que tasks_transition_trg por orden alfabético: el guard
-- juzga lo que mandó la sesión, no lo que después deriva el trigger de estado.
create trigger tasks_guard_trg
  before update on tasks
  for each row execute function tasks_guard();

-- ---------------------------------------------------------------------------
-- 3. opportunities: igual criterio
-- ---------------------------------------------------------------------------
-- Editable todo lo que mueve el pipeline y el ciclo de viabilidad (que es lo que
-- hacen /pipeline y /seguimiento). Cerrado: de qué doctor es, de qué caso salió,
-- la clave del import y la marca de demo.

create or replace function opportunities_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  editable text[] := array[
    'stage', 'stage_entered_at', 'patient_name', 'amount_mxn', 'probability',
    'forecast_category', 'expected_close_date', 'owner_id', 'lost_reason', 'closed_at',
    -- el ciclo de viabilidad (0022), que carga /seguimiento a mano
    'viability_status', 'viability_result', 'viability_requested_at',
    'viability_submitted_at', 'viability_completed_at', 'viability_follow_up_date',
    'viability_clinical_owner',
    'updated_at'
  ];
begin
  if is_system() then return new; end if;
  if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
    raise exception 'De una oportunidad se mueve la etapa, el monto y la viabilidad: de qué doctor y de qué caso salió, no';
  end if;
  return new;
end $$;

drop trigger if exists opportunities_guard_trg on opportunities;
create trigger opportunities_guard_trg
  before update on opportunities
  for each row execute function opportunities_guard();

-- ---------------------------------------------------------------------------
-- 4. Borrar un evento: el que lo cargó, o un manager
-- ---------------------------------------------------------------------------
-- 0051 cerró el UPDATE de events al autor y se olvidó del DELETE, que es el más
-- caro de los dos: borrar el evento se lleva la lista de asistentes en cascada,
-- que es lo más trabajoso de cargar de todo el formulario.
--
-- Un evento sin `created_by` (importado) solo lo borra un manager: no es de
-- nadie, y "de nadie" no puede significar "de cualquiera".

drop policy if exists events_delete on events;
create policy events_delete on events for delete to authenticated
  using ((created_by = auth.uid() or is_manager()) and can_write());

drop policy if exists event_attendees_delete on event_attendees;
create policy event_attendees_delete on event_attendees for delete to authenticated
  using (
    can_write() and exists (
      select 1 from events e
      where e.id = event_attendees.event_id
        and (e.created_by = auth.uid() or is_manager())
    )
  );

-- ---------------------------------------------------------------------------
-- 5. calendar_events: es un espejo, no una tabla que se edite
-- ---------------------------------------------------------------------------
-- 0046 le dejó policies de escritura "para que un día se pueda corregir un
-- vínculo desde la app". Ese día no llegó, y mientras tanto son tres puertas
-- abiertas a una tabla que reescribe entera el sync de Google cada mañana:
-- cualquier cosa que se corrija a mano se pierde en la próxima corrida. El sync
-- escribe con service role y no necesita ninguna de las tres.

drop policy if exists calendar_events_insert on calendar_events;
drop policy if exists calendar_events_update on calendar_events;
drop policy if exists calendar_events_delete on calendar_events;

-- ---------------------------------------------------------------------------
-- 6. Grants de las funciones nuevas
-- ---------------------------------------------------------------------------
-- Una función nace con EXECUTE para PUBLIC y `anon` hereda de PUBLIC. Son de
-- trigger (devuelven `trigger`, PostgREST no las puede invocar), pero el
-- chequeo 1 de scripts/security-checks.ts las contaría igual y pasaría a FALLA.
-- Convención de 0027, y la lección que costó la migración 0033 entera.

revoke execute on function tasks_guard() from public, anon, authenticated;
revoke execute on function opportunities_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Verificación
-- ---------------------------------------------------------------------------
-- Prueba los guards de verdad, haciéndose pasar por un usuario real dentro de
-- una transacción que se revierte. Una migración de permisos que no se prueba a
-- sí misma es una hipótesis: la de 0043 pasó en verde y dejó rota
-- evaluate_automations() hasta que 0044 vino a arreglarla.

do $$
declare
  v_user uuid;
  v_doctor uuid;
  v_task uuid;
  v_opp uuid;
  v_task_auto uuid;
  v_err text;
begin
  if not exists (select 1 from pg_trigger where tgname = 'tasks_guard_trg') then
    raise exception '0052: el guard de tasks no quedó montado';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'opportunities_guard_trg') then
    raise exception '0052: el guard de opportunities no quedó montado';
  end if;
  if exists (
    select 1 from pg_policies
     where tablename = 'calendar_events' and cmd in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception '0052: calendar_events quedó con policies de escritura';
  end if;
  if not exists (
    select 1 from pg_policies
     where tablename = 'events' and policyname = 'events_delete' and qual like '%auth.uid()%'
  ) then
    raise exception '0052: events_delete no quedó acotada al autor';
  end if;

  select id into v_user from profiles where rol <> 'VIEWER' and activo order by created_at limit 1;
  if v_user is null then
    raise notice '0052: sin perfiles no-VIEWER, se saltean las pruebas de comportamiento';
    return;
  end if;
  select id into v_doctor from doctors where not is_demo order by created_at limit 1;
  select id into v_task   from tasks         order by created_at desc limit 1;
  select id into v_opp    from opportunities order by created_at desc limit 1;

  -- Hacerse pasar por esa persona. Sin esto corre como `postgres`, para el que
  -- `is_system()` da true: probaría exactamente lo contrario de lo que dice.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  perform set_config('app.system', 'off', true);

  -- Todo lo que sigue va adentro de un bloque que SIEMPRE se revierte: probar
  -- los guards no puede dejar ni un updated_at movido en la base.
  begin
    -- ---- lo que tiene que frenar ----
    begin
      update doctors set is_demo = true where id = v_doctor;
      v_err := '(no falló)';
    exception when others then v_err := sqlerrm;
    end;
    if position('Borrar datos demo' in v_err) = 0 then
      raise exception '0052: marcar un doctor como demo no lo frenó el guard. Resultado: %', v_err;
    end if;

    begin
      -- un valor GARANTIZADO distinto del actual: si por casualidad el doctor ya
      -- estuviera en esa etapa, el update no sería un cambio, el guard no tendría
      -- nada que frenar, y la prueba pasaría sin haber probado nada
      update doctors
         set lifecycle_stage = (case when lifecycle_stage = 'growth' then 'dormido' else 'growth' end)::lifecycle_stage
       where id = v_doctor;
      v_err := '(no falló)';
    exception when others then v_err := sqlerrm;
    end;
    if position('calcula el sistema' in v_err) = 0 then
      raise exception '0052: reescribir el lifecycle no lo frenó el guard. Resultado: %', v_err;
    end if;

    begin
      update doctors set last_contact_at = now() where id = v_doctor;
      v_err := '(no falló)';
    exception when others then v_err := sqlerrm;
    end;
    if position('calcula el sistema' in v_err) = 0 then
      raise exception '0052: escribir last_contact_at a mano no lo frenó el guard. Resultado: %', v_err;
    end if;

    -- `not is_demo` SIEMPRE es un cambio, tenga el valor que tenga la fila. Es la
    -- diferencia entre probar el guard y probar que la fila que me tocó ya estaba
    -- como yo esperaba: la primera versión de esto ponía `automation_rule_id =
    -- null` sobre la tarea más nueva, y en producción esa tarea era manual y ya
    -- lo tenía en null. El update no cambiaba nada, el guard no tenía qué frenar
    -- y la prueba habría pasado sin haber probado nada. Falló acá, que es donde
    -- tenía que fallar.
    if v_task is not null then
      begin
        update tasks set is_demo = not is_demo where id = v_task;
        v_err := '(no falló)';
      exception when others then v_err := sqlerrm;
      end;
      if position('de dónde salió' in v_err) = 0 then
        raise exception '0052: marcar una tarea como demo no lo frenó el guard. Resultado: %', v_err;
      end if;
    end if;

    -- y la marca de tarea automática, sobre una tarea que de verdad la tenga
    select id into v_task_auto from tasks where automation_rule_id is not null
     order by created_at desc limit 1;
    if v_task_auto is not null then
      begin
        update tasks set automation_rule_id = null where id = v_task_auto;
        v_err := '(no falló)';
      exception when others then v_err := sqlerrm;
      end;
      if position('de dónde salió' in v_err) = 0 then
        raise exception '0052: borrar la marca de tarea automática no lo frenó el guard. Resultado: %', v_err;
      end if;
    else
      raise notice '0052: no hay ninguna tarea automática en esta base, se saltea esa prueba';
    end if;

    if v_opp is not null then
      begin
        update opportunities set is_demo = not is_demo where id = v_opp;
        v_err := '(no falló)';
      exception when others then v_err := sqlerrm;
      end;
      if position('de qué doctor' in v_err) = 0 then
        raise exception '0052: marcar una oportunidad como demo no lo frenó el guard. Resultado: %', v_err;
      end if;
    end if;

    -- ---- y lo que la app hace todos los días tiene que seguir pasando ----
    -- Si alguna de estas falla, el guard es más estrecho que el producto y el
    -- equipo se queda sin poder trabajar. Es la mitad que suele faltar.
    update doctors set city = city, observaciones = observaciones where id = v_doctor;
    update doctors set acquisition_stage = acquisition_stage where id = v_doctor;
    if v_task is not null then
      update tasks set due_date = due_date, outcome = outcome, status = status,
                       assigned_to = assigned_to, title = title
       where id = v_task;
    end if;
    if v_opp is not null then
      update opportunities set amount_mxn = amount_mxn, stage = stage,
                               viability_status = viability_status
       where id = v_opp;
    end if;

    raise exception 'revertir_las_pruebas';
  exception when others then
    if sqlerrm <> 'revertir_las_pruebas' then raise; end if;
  end;

  raise notice '0052 OK: las cuatro puertas cerradas, y lo que la app hace todos los días sigue pasando.';
end $$;

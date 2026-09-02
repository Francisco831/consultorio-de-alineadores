-- 0053 — El recálculo devuelve la llave cuando termina.
--
-- LO QUE APARECIÓ. Todos los guards del CRM empiezan igual: `if is_system()
-- then return new; end if`. Y `is_system()` es "no hay sesión, O la variable
-- `app.system` está en on". Esa variable la prende `recompute_doctor()` en su
-- primera línea, porque necesita escribir las columnas que él mismo calcula y
-- que el guard protege.
--
-- El problema es que la prende con alcance de TRANSACCIÓN y no la vuelve a
-- apagar. O sea: desde que se dispara un recálculo, y hasta que esa transacción
-- termina, `is_system()` devuelve true para TODO lo que venga después. Los
-- guards de doctors, tasks, opportunities, alerts, activities y
-- ai_recommendations quedan todos abiertos.
--
-- Medido contra producción el 2/9, haciéndose pasar por una persona del equipo:
--
--     marcar un doctor como demo, solo                → FRENADO ✓
--     registrar una actividad y después marcarlo demo → PASÓ, app.system = "on"
--
-- Viene de 0019 y no de los guards nuevos: hasta hoy afectaba igual a las
-- columnas de score. No es explotable desde la app —cada server action habla con
-- PostgREST en su propia transacción, así que no se pueden encadenar dos
-- escrituras— pero deja a todos los guards valiendo bastante menos de lo que
-- dicen valer, y cualquier función o script que haga dos cosas seguidas ya está
-- del otro lado.
--
-- EL ARREGLO, donde cuesta menos. La llave se pide en tres lugares:
-- `recompute_doctor()`, `recompute_all()` y `evaluate_automations()`. Los dos
-- últimos son RPC con candado de manager, y una llamada RPC es una transacción
-- entera: cuando devuelven, la variable muere con la transacción y no hay nada
-- que se filtre. El único camino por el que una sesión de usuario común entra a
-- todo esto es el trigger — registrar una actividad, mover una tarea, cerrar una
-- oportunidad—, y ese trigger es este envoltorio de quince líneas.
--
-- Así que se arregla acá y no adentro de `recompute_doctor()`, que son 600
-- líneas con varios `return` en el medio: reescribirla entera para agregar dos
-- líneas es mucho más riesgo que el que se viene a sacar.
--
-- Rollback: supabase/rollbacks/0053_el_recompute_devuelve_la_llave_rollback.sql

create or replace function recompute_doctor_trigger() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_doctor uuid;
  -- Cómo estaba la llave ANTES de entrar. Casi siempre vacío (una persona
  -- registrando algo), pero no siempre: cuando el que dispara el trigger es el
  -- import o el cron, ya viene en 'on' y hay que devolverla en 'on' — si la
  -- apagáramos, el resto de ESE proceso empezaría a chocar contra los guards.
  v_previo text;
begin
  if tg_op = 'DELETE' then
    v_doctor := old.doctor_id;
  else
    v_doctor := new.doctor_id;
  end if;
  if v_doctor is not null then
    v_previo := coalesce(current_setting('app.system', true), '');
    perform recompute_doctor(v_doctor);
    -- Devolver la llave, pase lo que pase. Sin esto, quien registró la actividad
    -- se queda con permisos de sistema hasta el final de su transacción.
    perform set_config('app.system', v_previo, true);
  end if;
  return null;
end $fn$;

revoke execute on function recompute_doctor_trigger() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Verificación: la prueba que encontró esto, ahora del lado correcto
-- ---------------------------------------------------------------------------

do $$
declare
  v_user uuid;
  v_doctor uuid;
  v_err text;
  v_flag text;
begin
  select id into v_user from profiles where rol <> 'VIEWER' and activo order by created_at limit 1;
  select id into v_doctor from doctors where not is_demo order by created_at limit 1;
  if v_user is null or v_doctor is null then
    raise notice '0053: sin perfiles o sin doctores, se saltea la prueba';
    return;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  perform set_config('app.system', '', true);

  begin
    -- el escenario exacto: registrar una actividad (que dispara el recálculo) y
    -- después intentar algo que el guard tiene que frenar
    insert into activities (doctor_id, type, occurred_at, summary, created_by)
    values (v_doctor, 'llamada', now(), 'verificación 0053', v_user);

    v_flag := coalesce(current_setting('app.system', true), '');
    if v_flag = 'on' then
      raise exception '0053: el recálculo dejó app.system en "on" — la llave no se devolvió';
    end if;

    begin
      update doctors set is_demo = true where id = v_doctor;
      v_err := '(no falló)';
    exception when others then v_err := sqlerrm;
    end;
    if position('Borrar datos demo' in v_err) = 0 then
      raise exception '0053: después de registrar una actividad el guard sigue abierto. Resultado: %', v_err;
    end if;

    raise exception 'revertir_las_pruebas';
  exception when others then
    if sqlerrm <> 'revertir_las_pruebas' then raise; end if;
  end;

  raise notice '0053 OK: registrar una actividad ya no deja los guards abiertos por el resto de la transacción.';
end $$;

-- 0055 — Hay dos maneras de estar activo, y el CRM sólo sabía contar una.
--
-- LO QUE APARECIÓ. Un caso del CRM no es un paciente: es una ETAPA de un
-- tratamiento. `is_new_case` vale true sólo cuando la etapa es 'I_1'
-- (lib/noloco-sync.ts:440), o sea el primer alineador de un paciente nuevo. Todo
-- el motor —el ritmo, el health, el lifecycle, las alertas— mide con esa sola
-- señal. Y en los últimos 90 días entraron 142 casos: 74 primeras etapas y 68
-- segundas, terceras y cuartas. El 48% del trabajo que entra no existe en
-- ninguna pantalla.
--
-- La consecuencia se ve en los doctores: de los 212 acreditados, 42 trajeron un
-- paciente nuevo en 90 días, 31 no trajeron ninguno pero siguen mandando etapas
-- posteriores, y 139 no mandaron nada. **De esos 31, 22 están marcados dormido
-- o perdido.** El CRM le dice a Rocío que no llame a un doctor que le mandó
-- trabajo el mes pasado.
--
-- Y hay un dato que cambia la lectura: las etapas posteriores llegan, en
-- mediana, un año después del I_1 que las originó. O sea que son un indicador
-- rezagado de doce meses: cuando un doctor deja de traer pacientes, el trabajo
-- sigue entrando un año más. Ese año es exactamente la ventana en la que se lo
-- puede recuperar, y hoy la usamos para darlo por muerto.
--
-- LO QUE ESTA MIGRACIÓN NO HACE, a propósito:
--
--   · No toca `is_new_case`. Es el KPI que Juan reporta afuera y está declarado
--     como verdad en cinco lugares del repo. Sumarle etapas posteriores infla el
--     número del trimestre un 92% (142 contra 74) sobre trabajo ya cobrado.
--   · No toca `recompute_doctor()`. Son 600 líneas con varios return en el
--     medio; 0053 ya dejó escrito por qué no se la abre para agregar dos líneas.
--   · No mueve el lifecycle de nadie. Un doctor que hoy dice 'dormido' va a
--     seguir diciendo 'dormido', con un segundo badge al lado que dice qué está
--     pasando de verdad. El eje nuevo es OTRO eje, no un reemplazo.
--
-- Verificado antes de escribirla: el UPDATE de abajo no dispara nada. Los tres
-- triggers de doctors son doctors_guard_trg (pasa por is_system()),
-- doctors_journey_trg (0015:154 hace `if is_system() then return new`) y
-- doctors_cruce_recompute_trg (0032:44, WHEN sobre is_accredited, que no cambia).
--
-- LA ETAPA NULA. 29 casos no tienen etapa y `needs_review` los marca para
-- revisar (noloco-sync.ts:441). Cuentan como actividad —el trabajo entró, es un
-- hecho— pero como etapa posterior, no como paciente nuevo: llamarlos I_1 sin
-- saberlo sería inventar un paciente. Hoy eso mueve exactamente a un doctor.
--
-- Rollback: supabase/rollbacks/0055_dos_maneras_de_estar_activo_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Las columnas
-- ---------------------------------------------------------------------------
alter table doctors
  add column if not exists actividad_90d text
    check (actividad_90d in ('trae_nuevos','solo_termina','sin_actividad')),
  add column if not exists nuevos_90d int not null default 0,
  add column if not exists posteriores_90d int not null default 0,
  add column if not exists servicio_90d int not null default 0,
  add column if not exists ultimo_caso_posterior_at date;

comment on column doctors.actividad_90d is
  'Eje de actividad de los últimos 90 días, al lado del lifecycle y sin reemplazarlo: trae_nuevos (mandó al menos un I_1) / solo_termina (sólo etapas posteriores o servicio) / sin_actividad (ningún caso). Null en los no acreditados: el eje mide producción y ellos todavía no producen.';
comment on column doctors.servicio_90d is
  'Casos de CONTENCION, PASIVAS y SUPERPOSICION en 90 días. Van contados aparte porque no recorren producción (0 de 60 tienen fecha de documentación, video ni impresión) y todavía no está confirmado si se cobran.';

-- la lista y el dashboard filtran siempre por los dos juntos
create index if not exists doctors_actividad_idx
  on doctors (is_accredited, actividad_90d);

-- ---------------------------------------------------------------------------
-- 2. El cálculo
-- ---------------------------------------------------------------------------
-- ai_mx_today() y no current_date: el borde del día se corre seis horas y el
-- repo ya tiene la función justamente por eso (0023:45).
create or replace function recompute_actividad() returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_previo text;
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede recalcular la actividad';
  end if;
  v_previo := coalesce(current_setting('app.system', true), '');
  perform set_config('app.system', 'on', true);

  update doctors d set
    nuevos_90d               = s.nuevos,
    posteriores_90d          = s.posteriores,
    servicio_90d             = s.servicio,
    ultimo_caso_posterior_at = s.ultimo_posterior,
    actividad_90d = case
      when s.nuevos > 0                      then 'trae_nuevos'
      when s.posteriores + s.servicio > 0    then 'solo_termina'
      else                                        'sin_actividad' end
  from (
    select dd.id,
           coalesce(x.nuevos, 0)      as nuevos,
           coalesce(x.posteriores, 0) as posteriores,
           coalesce(x.servicio, 0)    as servicio,
           x.ultimo_posterior
      from doctors dd
      left join (
        select doctor_id,
               count(*) filter (where is_new_case) as nuevos,
               count(*) filter (where etapa in ('CONTENCION','PASIVAS','SUPERPOSICION')) as servicio,
               count(*) filter (
                 where not is_new_case
                   and (etapa is null
                        or etapa not in ('CONTENCION','PASIVAS','SUPERPOSICION'))) as posteriores,
               max(fecha_ingreso) filter (where not is_new_case)::date as ultimo_posterior
          from cases
         where not is_demo
           and fecha_ingreso >= ai_mx_today() - 90
         group by doctor_id
      ) x on x.doctor_id = dd.id
     where dd.is_accredited and not dd.is_demo
  ) s
  where d.id = s.id;

  perform set_config('app.system', v_previo, true);
end $fn$;

comment on function recompute_actividad() is
  'Recalcula el eje de actividad de 90 días de los acreditados. Un solo UPDATE, no toca lifecycle ni scores.';

revoke all on function recompute_actividad() from public, anon;
grant execute on function recompute_actividad() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. El guard: las columnas nuevas las calcula el sistema
-- ---------------------------------------------------------------------------
-- Se re-declara entera la versión de 0052 con las cinco columnas sumadas a los
-- dos bloques. Sin esto, un PATCH desde la app las escribe a mano y mienten.
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
    -- nuevas en 0055: el eje de actividad
    new.actividad_90d := null;         new.nuevos_90d := 0;
    new.posteriores_90d := 0;          new.servicio_90d := 0;
    new.ultimo_caso_posterior_at := null;
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
  -- nuevas en 0055: el eje sale de los casos, no de la ficha
  or new.actividad_90d            is distinct from old.actividad_90d
  or new.nuevos_90d               is distinct from old.nuevos_90d
  or new.posteriores_90d          is distinct from old.posteriores_90d
  or new.servicio_90d             is distinct from old.servicio_90d
  or new.ultimo_caso_posterior_at is distinct from old.ultimo_caso_posterior_at
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
-- 4. Cuándo se recalcula
-- ---------------------------------------------------------------------------
-- El sync de Noloco lo llama al final, junto con recompute_all (es cuando
-- llegan los casos, cada 2 h). El cron nocturno es la red: si un día el sync
-- falla, el eje igual se mueve solo cuando pasan los 90 días de alguien.
do $$
begin
  perform cron.schedule('crm-actividad-nightly', '20 11 * * *',
                        'select recompute_actividad()');
exception when others then
  raise notice 'pg_cron no disponible (%). Programar recompute_actividad() manualmente.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Primera corrida y verificación
-- ---------------------------------------------------------------------------
do $$
declare v_trae int; v_solo int; v_sin int; v_i1 int; v_post int; v_contradice int;
begin
  perform recompute_actividad();
  select count(*) filter (where actividad_90d = 'trae_nuevos'),
         count(*) filter (where actividad_90d = 'solo_termina'),
         count(*) filter (where actividad_90d = 'sin_actividad'),
         count(*) filter (where actividad_90d = 'solo_termina'
                            and lifecycle_stage in ('dormido','perdido'))
    into v_trae, v_solo, v_sin, v_contradice
    from doctors where is_accredited and not is_demo;
  select count(*) filter (where is_new_case), count(*) filter (where not is_new_case)
    into v_i1, v_post
    from cases where not is_demo and fecha_ingreso >= ai_mx_today() - 90;
  raise notice '0055 OK: % traen pacientes, % solo terminan, % sin actividad. Casos 90d: % primeras etapas y % posteriores. % de los que solo terminan siguen marcados dormido o perdido.',
    v_trae, v_solo, v_sin, v_i1, v_post, v_contradice;
end $$;

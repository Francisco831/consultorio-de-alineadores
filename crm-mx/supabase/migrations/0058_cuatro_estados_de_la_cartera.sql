-- 0058 — Los cuatro estados de la cartera: Activo, Lapsed, Beginner, Inactivo.
--
-- EL PEDIDO (Pancho, 8/9/2026). La columna "Estado" de la lista de doctores
-- mostraba el lifecycle_stage: catorce etapas del motor (activo, growth,
-- en_riesgo, dormido, reactivado, perdido…) que el equipo comercial no usa para
-- decidir qué hacer con un doctor. El Plan Comercial 2026 segmenta la cartera
-- con una matriz de Potencial × Afinidad de cuatro casillas, cada una con su
-- acción, y es la misma que la capa AI ya tiene escrita en su cerebro
-- (lib/ai/brain/sections.ts). Desde hoy "Estado" es esa matriz:
--
--   activo    alto potencial + alta afinidad   caso aprobado hace ≤90 días   → Defender
--   lapsed    alto potencial + baja afinidad   caso aprobado hace >90 días   → Conquistar
--   beginner  bajo potencial + alta afinidad   acreditado hace ≤90 días y
--                                              todavía sin caso aprobado     → Construir
--   inactivo  bajo potencial + baja afinidad   sin casos aprobados nunca     → Observar
--
-- Se calcula, nadie lo carga: sale de dos fechas —la del último caso que el
-- doctor aprobó y la de su acreditación— y lo protege el guard como a todo lo
-- que calcula el sistema. La acción no se guarda: es una función fija de la
-- casilla y vive en el código (lib/types.ts).
--
-- QUÉ ES "CASO APROBADO", medido contra los 1.069 casos de la base (8/9/2026).
-- Hay dos fechas de aprobación en cases y no son la misma cosa:
--
--   · fecha_aprobacion llega 1,6 días después del ingreso y 0,1 después de la
--     documentación (medianas): es el visto bueno interno para arrancar la
--     edición. La tienen 61 de los 61 casos que hoy esperan al doctor y 41 de
--     los 65 que el doctor RECHAZÓ. No dice nada de lo que decidió el doctor.
--   · fecha_aprobacion_video llega 3,9 días después del video y 4 antes de la
--     impresión: es el doctor aprobando la propuesta, el momento en que el caso
--     existe comercialmente. Cero de los 61 en espera y 4 de los 65 rechazados.
--
-- El estado usa la segunda. Con la primera cambiarían 5 doctores, todos hacia
-- un lado más optimista del que les corresponde.
--
-- Cuenta cualquier etapa (I_1, I_2, bis…): aprobar una segunda etapa es aprobar
-- un caso, y 0055 ya dejó escrito por qué el trabajo posterior es actividad.
-- Contención, pasivas y superposición no tienen aprobación de propuesta (0 de
-- 60), así que no mueven el estado: son servicio, no un caso aprobado.
--
-- LO QUE NO SE PUEDE MEDIR. 87 de los 213 acreditados no tienen fecha de
-- acreditación: entraron por el import de Noloco, que no la trae. Ninguno puede
-- ser beginner —no hay desde cuándo contar los 90 días— y sin caso aprobado caen
-- a inactivo, que para un doctor con años de acreditado y sin casos es la
-- lectura correcta. NO se usa created_at como reemplazo: es la fecha del import
-- (agosto 2026) y convertiría en beginner a unos 40 doctores viejos.
--
-- Los casos del espejo empiezan el 12/9/2024, así que "sin casos aprobados
-- nunca" quiere decir "nunca desde que hay espejo". Un doctor que aprobó su
-- último caso en 2023 figura inactivo, no lapsed. Es la misma frontera que 0055
-- y 0056 declaran para los I_1.
--
-- CÓMO QUEDA LA CARTERA (213 acreditados, 8/9/2026): 63 activos, 100 lapsed,
-- 3 beginners, 47 inactivos. Contra el lifecycle: 25 doctores que el motor tiene
-- en dormido o perdido aprobaron un caso en los últimos 90 días (los mismos que
-- 0055 encontró mandando etapas posteriores) y 36 que figuran "activado" no
-- aprobaron ningún caso en dos años.
--
-- LO QUE NO TOCA. lifecycle_stage sigue existiendo y moviéndose igual: lo usan
-- el score, las automatizaciones, /hoy, el dashboard y la capa AI. Esta
-- migración no cambia una regla del motor: le cambia la cara a la lista y a la
-- ficha. El eje de actividad de 0055 (trae_nuevos / solo_termina /
-- sin_actividad) también queda: mide OTRA cosa (pacientes nuevos contra etapas)
-- y en la lista se lee al lado.
--
-- CUÁNDO SE RECALCULA. Al final de cada sync de Noloco (cada 2 h, que es cuando
-- llegan las aprobaciones), todas las noches a las 11:25 UTC (el borde de los
-- 90 días se mueve solo) y en el momento en que un doctor cruza a acreditado
-- (para que nazca beginner y no espere a la noche).
--
-- Rollback: supabase/rollbacks/0058_cuatro_estados_de_la_cartera_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Las columnas
-- ---------------------------------------------------------------------------
alter table doctors
  add column if not exists segmento text
    check (segmento in ('activo','lapsed','beginner','inactivo')),
  add column if not exists ultimo_caso_aprobado_at date;

comment on column doctors.segmento is
  'Estado de la cartera: la matriz Potencial × Afinidad del Plan Comercial 2026. activo (caso aprobado hace ≤90 días) / lapsed (>90) / beginner (acreditado hace ≤90 días sin caso aprobado) / inactivo (sin casos aprobados). Lo calcula recompute_segmento() desde cases.fecha_aprobacion_video y doctors.accredited_at; null en los no acreditados.';
comment on column doctors.ultimo_caso_aprobado_at is
  'Fecha en que el doctor aprobó su último caso (max de cases.fecha_aprobacion_video, cualquier etapa). Es el dato del que sale segmento; se muestra al lado para que el estado se pueda verificar.';

-- la lista filtra siempre por los dos juntos
create index if not exists doctors_segmento_idx
  on doctors (is_accredited, segmento);

-- ---------------------------------------------------------------------------
-- 2. El cálculo
-- ---------------------------------------------------------------------------
-- ai_mx_today() y no current_date: el borde del día se corre seis horas y el
-- repo ya tiene la función justamente por eso (0023:45).
create or replace function recompute_segmento(p_doctor uuid default null) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_previo text;
begin
  -- La corrida entera es cosa de manager (como recompute_actividad). La de UN
  -- doctor la dispara el trigger del cruce, que corre con la sesión de quien
  -- acreditó —y quien acredita no siempre es manager—, por eso no lleva
  -- candado: recalcula un hecho, no escribe nada que una persona pueda elegir.
  if p_doctor is null and auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede recalcular el estado de toda la cartera';
  end if;
  v_previo := coalesce(current_setting('app.system', true), '');
  perform set_config('app.system', 'on', true);

  update doctors d set
    segmento                = s.seg,
    ultimo_caso_aprobado_at = s.ult
  from (
    select dd.id, x.ult,
           case
             when x.ult >= ai_mx_today() - 90            then 'activo'
             when x.ult is not null                      then 'lapsed'
             when dd.accredited_at >= ai_mx_today() - 90 then 'beginner'
             else                                             'inactivo'
           end as seg
      from doctors dd
      left join (
        -- la aprobación tiene hora real (el doctor aprueba a las 7 de la tarde
        -- de México, que ya es mañana en UTC): el día se corta en México, como
        -- ai_mx_today(). Sin esto ~100 de 858 aprobaciones caen al día siguiente.
        select doctor_id,
               max(fecha_aprobacion_video at time zone 'America/Mexico_City')::date as ult
          from cases
         where not is_demo
           and fecha_aprobacion_video is not null
         group by doctor_id
      ) x on x.doctor_id = dd.id
     where dd.is_accredited and not dd.is_demo
       and (p_doctor is null or dd.id = p_doctor)
  ) s
  where d.id = s.id
    -- solo las filas que cambian: sin esto cada noche se reescribirían las 213
    -- filas (y su updated_at) para no cambiar nada
    and (d.segmento is distinct from s.seg
         or d.ultimo_caso_aprobado_at is distinct from s.ult);

  -- el que deja de estar acreditado no tiene estado: la matriz es de la cartera
  update doctors d
     set segmento = null, ultimo_caso_aprobado_at = null
   where not d.is_accredited
     and (d.segmento is not null or d.ultimo_caso_aprobado_at is not null)
     and (p_doctor is null or d.id = p_doctor);

  perform set_config('app.system', v_previo, true);
end $fn$;

comment on function recompute_segmento(uuid) is
  'Recalcula el estado de la cartera (activo/lapsed/beginner/inactivo) de los acreditados, o de un doctor si se pasa p_doctor. Un UPDATE que solo toca las filas que cambian; no mueve lifecycle ni scores.';

revoke all on function recompute_segmento(uuid) from public, anon;
grant execute on function recompute_segmento(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. El guard: las columnas nuevas las calcula el sistema
-- ---------------------------------------------------------------------------
-- Se re-declara entera la versión de 0055 con las dos columnas sumadas a los
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
    -- nuevas en 0058: el estado de la cartera
    new.segmento := null;              new.ultimo_caso_aprobado_at := null;
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
  -- nuevas en 0058: el estado sale del último caso aprobado y de la acreditación
  or new.segmento                 is distinct from old.segmento
  or new.ultimo_caso_aprobado_at  is distinct from old.ultimo_caso_aprobado_at
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
-- 4. Al cruzar a acreditado, el estado nace en el acto
-- ---------------------------------------------------------------------------
-- Versión de 0032 con una línea más. El trigger ya existe (AFTER UPDATE, WHEN
-- cambia is_accredited) y sigue apuntando a esta función; no se recrea.
-- recompute_segmento no cambia is_accredited, así que el WHEN corta la vuelta.
create or replace function doctors_recompute_al_cruzar() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  perform recompute_doctor(new.id);
  -- 0058: el que cruza a acreditado nace beginner ahora, no a la noche
  perform recompute_segmento(new.id);
  return null;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. Cuándo se recalcula
-- ---------------------------------------------------------------------------
-- El sync de Noloco lo llama al final (lib/noloco-sync.ts), después del eje de
-- actividad. El cron nocturno es la red: si un sync falla, el estado igual se
-- mueve solo cuando a alguien se le vencen los 90 días. Minuto 25: después del
-- eje (11:20) y antes de la regla se_apaga (xx:30).
do $$
begin
  perform cron.schedule('crm-segmento-nightly', '25 11 * * *',
                        'select recompute_segmento()');
exception when others then
  raise notice 'pg_cron no disponible (%). Programar recompute_segmento() manualmente.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Primera corrida y verificación
-- ---------------------------------------------------------------------------
do $$
declare
  v_act int; v_lap int; v_beg int; v_ina int; v_sin int;
  v_motor_dormido int; v_motor_activado int;
begin
  perform recompute_segmento();
  select count(*) filter (where segmento = 'activo'),
         count(*) filter (where segmento = 'lapsed'),
         count(*) filter (where segmento = 'beginner'),
         count(*) filter (where segmento = 'inactivo'),
         count(*) filter (where segmento is null),
         count(*) filter (where segmento = 'activo'
                            and lifecycle_stage in ('dormido','perdido')),
         count(*) filter (where segmento = 'inactivo'
                            and lifecycle_stage = 'activado')
    into v_act, v_lap, v_beg, v_ina, v_sin, v_motor_dormido, v_motor_activado
    from doctors where is_accredited and not is_demo;
  if v_sin > 0 then
    raise exception '0058: % acreditados quedaron sin estado', v_sin;
  end if;
  if exists (select 1 from doctors where not is_accredited and segmento is not null) then
    raise exception '0058: hay no acreditados con estado';
  end if;
  raise notice '0058 OK: % activos, % lapsed, % beginners, % inactivos. % que el motor tiene en dormido/perdido aprobaron un caso en 90 días; % "activados" no tienen ningún caso aprobado.',
    v_act, v_lap, v_beg, v_ina, v_motor_dormido, v_motor_activado;
end $$;

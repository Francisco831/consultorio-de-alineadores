-- 0060 — El nivel de interacción con soporte: real, puntual o sin contacto.
--
-- EL PEDIDO (Pancho, 8/9/2026). Con los cuatro estados de la cartera (0058) ya
-- en la lista de doctores, falta un segundo análisis, independiente del
-- estado, que mida la CALIDAD del vínculo con soporte: si además de mandar
-- casos hay conversación persona a persona con la línea de soporte
-- (+54 9 11 2374-0762, la que atiende Rocío), o si el vínculo es solo
-- transaccional —manda casos, pero no hay intercambio de mensajes ni llamadas
-- de seguimiento—. Se lee al lado del estado, y del cruce sale una sugerencia:
--
--   activo   + sin interacción real → solo transaccional: fortalecer el vínculo
--   inactivo + sin contacto         → prioridad de acercamiento: entender qué
--                                     necesita o qué está fallando
--   inactivo + buena interacción    → el problema no es de vínculo: indagar
--                                     otra causa
--
-- La matriz completa (4 estados × 3 niveles) vive en lib/interaccion.ts. Como
-- la acción del estado, es función fija del cruce y no se guarda.
--
-- LOS TRES NIVELES, sobre una ventana de días hacia atrás (90 por defecto):
--
--   real          mensajes de ida y vuelta por la línea de soporte que llegan
--                 a los mínimos (del doctor, nuestros, en días distintos), O al
--                 menos un contacto persona a persona registrado (llamada,
--                 videollamada, reunión, visita, KeepDay)
--   puntual       algún mensaje o contacto en la ventana, pero por debajo
--   sin_contacto  nada: ni un mensaje por la línea ni un contacto registrado
--
-- QUÉ ES "INTERACCIÓN REAL" LO DEFINE EL EQUIPO, no esta migración: el pedido
-- lo deja pendiente a propósito ("cantidad mínima de mensajes bidireccionales
-- en un período — dejarlo configurable"). Por eso los umbrales no están en el
-- código: viven en automation_rules.params (key 'interaccion_soporte') y se
-- editan desde /ajustes, que recalcula al guardar. Valores iniciales: 90 días,
-- 3 mensajes del doctor y 3 nuestros en 2 días distintos, o 1 contacto
-- registrado. Cambiarlos es un formulario, no una migración.
--
-- LAS FUENTES.
--   · WhatsApp: wa_messages de los chats vinculados a un doctor que viven en la
--     línea de soporte (wa_conversations.lineas). Hoy los carga el WhatsApp
--     directo (/api/sync/whatsapp, docs/WHATSAPP_DIRECTO.md): 234 mensajes en
--     27 chats desde el 1/9/2026, y nada anterior —el export de Periskope del
--     7/8 trajo chats sin cuerpos y esta línea no estaba en él—. WhatsApp Web
--     guarda desde el 6/6/2026: una corrida de la revisión con ese watermark
--     completa la ventana. Hasta entonces el nivel mide 8 días de mensajes y
--     90 de contactos registrados, y conviene leerlo sabiéndolo.
--   · Intranet / CRM: activities de los tipos persona a persona. Los contact
--     points del intranet entran por /api/sync/actividades como reunión o
--     visita; llamadas y videollamadas las registra el equipo. Quedan afuera,
--     igual que en lib/atribucion.ts: 'revision_clinica' (es un pedido de
--     modificación que hace el doctor sobre un caso: transaccional por
--     definición), 'nota' (enriquecimiento importado) y 'email' (no se usa en
--     MX). Y 'whatsapp' tampoco: los mensajes ya se cuentan uno por uno, y las
--     actividades whatsapp del sync son resúmenes diarios de esos mismos
--     mensajes.
--   · Noloco: el estado de 0058 con el que se cruza. Esta migración no lo toca.
--
-- LO QUE SE VE HOY (213 acreditados, 8/9/2026), medido antes de escribirla: 23
-- doctores tienen mensajes por la línea, 7 con ida y vuelta de 3 y 3; los 47
-- inactivos no tienen ni un mensaje. Con contactos registrados en 90 días
-- (llamada, videollamada, reunión, visita, KeepDay) hay 49 de 63 activos, 23 de
-- 100 lapsed, 5 de 47 inactivos y los 3 beginners.
--
-- CUÁNDO SE RECALCULA. Al final de cada corrida del WhatsApp directo (cartera
-- entera: es cuando entran mensajes); cuando se registra, edita o borra una
-- actividad (el mismo trigger que llama a recompute_doctor, para ese doctor:
-- una llamada cargada por Rocío se ve en el acto, no a la noche); al guardar
-- los umbrales en /ajustes; y todas las noches a las 11:28 UTC, porque la
-- ventana se mueve sola. Minuto 28: después del estado (11:25) y antes de la
-- regla se_apaga (xx:30).
--
-- Rollback: supabase/rollbacks/0060_nivel_de_interaccion_con_soporte_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Las columnas
-- ---------------------------------------------------------------------------
alter table doctors
  add column if not exists interaccion text
    check (interaccion in ('real','puntual','sin_contacto')),
  add column if not exists wa_del_doctor int not null default 0,
  add column if not exists wa_nuestros int not null default 0,
  add column if not exists wa_dias int not null default 0,
  add column if not exists contactos_registrados int not null default 0,
  add column if not exists ultimo_wa_at date;

comment on column doctors.interaccion is
  'Nivel de interacción con soporte, independiente del estado: real (mensajes de ida y vuelta por la línea de soporte que llegan a los mínimos, o un contacto persona a persona registrado) / puntual (algo, por debajo de los mínimos) / sin_contacto (nada en la ventana). Umbrales y ventana en automation_rules.params (key interaccion_soporte). Lo calcula recompute_interaccion(); null en los no acreditados.';
comment on column doctors.wa_del_doctor is
  'Mensajes que escribió el lado del doctor (direction in) por la línea de soporte dentro de la ventana. Uno de los números de los que sale interaccion; se muestra para poder verificarla.';
comment on column doctors.wa_nuestros is
  'Mensajes nuestros (direction out) por la línea de soporte dentro de la ventana.';
comment on column doctors.wa_dias is
  'Días distintos (hora de México) con al menos un mensaje, en cualquier dirección, dentro de la ventana.';
comment on column doctors.contactos_registrados is
  'Actividades persona a persona (params.tipos_contacto) dentro de la ventana: contact points del intranet, llamadas y videollamadas registradas.';
comment on column doctors.ultimo_wa_at is
  'Fecha (México) del último mensaje por la línea de soporte, en cualquier dirección y sin límite de ventana.';

-- la lista filtra siempre por los dos juntos
create index if not exists doctors_interaccion_idx
  on doctors (is_accredited, interaccion);

-- el único índice por doctor de wa_conversations era parcial (unanswered);
-- el cálculo mira todos los chats del doctor
create index if not exists wa_conversations_doctor_idx
  on wa_conversations (doctor_id)
  where doctor_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Los umbrales: una regla con parámetros, sin alertas ni tareas
-- ---------------------------------------------------------------------------
-- evaluate_automations() (0047) recorre las reglas activas con un if/elsif por
-- key y no tiene rama para ésta: la salta, como salta a se_apaga. Está acá y
-- no en una tabla nueva porque es exactamente lo que automation_rules.params
-- ya es para las otras diez: la configuración editable de una regla.
insert into automation_rules (key, nombre, descripcion, enabled, params, creates_task, task_type)
values ('interaccion_soporte', 'Nivel de interacción con soporte',
  'Qué cuenta como conversación real con la línea de soporte, en una ventana de días: mínimos de mensajes del doctor, nuestros y días distintos, o un contacto persona a persona registrado. No crea alertas ni tareas: clasifica a cada acreditado (real / puntual / sin contacto) para leerlo al lado del estado.',
  true,
  '{"dias": 90, "linea": "5491123740762", "min_del_doctor": 3, "min_nuestros": 3, "min_dias": 2, "min_contactos": 1, "tipos_contacto": ["llamada", "videollamada", "reunion", "visita", "keepday"]}',
  false, null)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. El cálculo
-- ---------------------------------------------------------------------------
-- ai_mx_today() y no current_date: el borde del día se corre seis horas y el
-- repo ya tiene la función justamente por eso (0023:45). La ventana arranca a
-- la medianoche de México de hace `dias` días.
create or replace function recompute_interaccion(p_doctor uuid default null) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_previo   text;
  v_params   jsonb;
  v_dias     int;
  v_linea    text;
  v_min_doc  int;
  v_min_nos  int;
  v_min_dias int;
  v_min_cont int;
  v_tipos    text[];
  v_desde    timestamptz;
begin
  -- La corrida entera es cosa de manager (como recompute_segmento). La de UN
  -- doctor la dispara el trigger de actividades con la sesión de quien registró
  -- la actividad —que no siempre es manager—, por eso no lleva candado:
  -- recalcula un hecho, no escribe nada que una persona pueda elegir.
  if p_doctor is null and auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede recalcular la interacción de toda la cartera';
  end if;

  select params into v_params from automation_rules where key = 'interaccion_soporte';
  v_params   := coalesce(v_params, '{}'::jsonb);
  v_dias     := greatest(1, coalesce(nullif(v_params->>'dias', '')::int, 90));
  -- solo dígitos, como profiles.periskope_org_phone; vacío = todas las líneas
  v_linea    := nullif(regexp_replace(coalesce(v_params->>'linea', ''), '\D', '', 'g'), '');
  v_min_doc  := greatest(0, coalesce(nullif(v_params->>'min_del_doctor', '')::int, 3));
  v_min_nos  := greatest(0, coalesce(nullif(v_params->>'min_nuestros', '')::int, 3));
  v_min_dias := greatest(0, coalesce(nullif(v_params->>'min_dias', '')::int, 2));
  v_min_cont := greatest(0, coalesce(nullif(v_params->>'min_contactos', '')::int, 1));
  v_tipos    := coalesce(
    (select array_agg(x) from jsonb_array_elements_text(
       case when jsonb_typeof(v_params->'tipos_contacto') = 'array'
            then v_params->'tipos_contacto' else '[]'::jsonb end) x),
    array['llamada','videollamada','reunion','visita','keepday']);
  v_desde    := (ai_mx_today() - v_dias)::timestamp at time zone 'America/Mexico_City';

  v_previo := coalesce(current_setting('app.system', true), '');
  perform set_config('app.system', 'on', true);

  update doctors d set
    interaccion           = s.nivel,
    wa_del_doctor         = s.del_doctor,
    wa_nuestros           = s.nuestros,
    wa_dias               = s.dias,
    contactos_registrados = s.contactos,
    ultimo_wa_at          = s.ultimo
  from (
    select dd.id, x.del_doctor, x.nuestros, x.dias, x.contactos, x.ultimo,
           case
             when (x.del_doctor >= v_min_doc
                   and x.nuestros >= v_min_nos
                   and x.dias >= v_min_dias)
               or (v_min_cont > 0 and x.contactos >= v_min_cont) then 'real'
             when x.del_doctor + x.nuestros + x.contactos > 0    then 'puntual'
             else                                                    'sin_contacto'
           end as nivel
      from doctors dd
      cross join lateral (
        select coalesce(w.del_doctor, 0)::int as del_doctor,
               coalesce(w.nuestros, 0)::int   as nuestros,
               coalesce(w.dias, 0)::int       as dias,
               coalesce(c.contactos, 0)::int  as contactos,
               u.ultimo
          from (select 1) uno
          -- los mensajes de la ventana, por la línea de soporte
          left join lateral (
            select count(*) filter (where wm.direction = 'in')  as del_doctor,
                   count(*) filter (where wm.direction = 'out') as nuestros,
                   -- el día se corta en México, como en 0058: un mensaje de las
                   -- 7 de la tarde ya es mañana en UTC
                   count(distinct (wm.sent_at at time zone 'America/Mexico_City')::date) as dias
              from wa_conversations wc
              join wa_messages wm on wm.conversation_id = wc.id
             where wc.doctor_id = dd.id
               and (v_linea is null or v_linea = any(wc.lineas))
               and wm.sent_at >= v_desde
          ) w on true
          -- los contactos persona a persona registrados en la ventana
          left join lateral (
            select count(*) as contactos
              from activities a
             where a.doctor_id = dd.id
               and not a.is_demo
               and a.type::text = any(v_tipos)
               and a.occurred_at >= v_desde
          ) c on true
          -- el último mensaje, sin ventana: para decir "hace cuánto"
          left join lateral (
            select max(wm.sent_at at time zone 'America/Mexico_City')::date as ultimo
              from wa_conversations wc
              join wa_messages wm on wm.conversation_id = wc.id
             where wc.doctor_id = dd.id
               and (v_linea is null or v_linea = any(wc.lineas))
          ) u on true
      ) x
     where dd.is_accredited and not dd.is_demo
       and (p_doctor is null or dd.id = p_doctor)
  ) s
  where d.id = s.id
    -- solo las filas que cambian: sin esto cada noche se reescribirían las 213
    -- filas (y su updated_at) para no cambiar nada
    and (d.interaccion           is distinct from s.nivel
      or d.wa_del_doctor         is distinct from s.del_doctor
      or d.wa_nuestros           is distinct from s.nuestros
      or d.wa_dias               is distinct from s.dias
      or d.contactos_registrados is distinct from s.contactos
      or d.ultimo_wa_at          is distinct from s.ultimo);

  -- el que deja de estar acreditado no tiene nivel: es una lectura de la cartera
  update doctors d
     set interaccion = null, wa_del_doctor = 0, wa_nuestros = 0, wa_dias = 0,
         contactos_registrados = 0, ultimo_wa_at = null
   where not d.is_accredited
     and (d.interaccion is not null or d.ultimo_wa_at is not null
          or d.wa_del_doctor <> 0 or d.wa_nuestros <> 0 or d.wa_dias <> 0
          or d.contactos_registrados <> 0)
     and (p_doctor is null or d.id = p_doctor);

  perform set_config('app.system', v_previo, true);
end $fn$;

comment on function recompute_interaccion(uuid) is
  'Recalcula el nivel de interacción con soporte (real/puntual/sin_contacto) de los acreditados, o de un doctor si se pasa p_doctor, con los umbrales de automation_rules (interaccion_soporte). Un UPDATE que solo toca las filas que cambian; no mueve lifecycle, estado ni scores.';

revoke all on function recompute_interaccion(uuid) from public, anon;
grant execute on function recompute_interaccion(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. El guard: las columnas nuevas las calcula el sistema
-- ---------------------------------------------------------------------------
-- Se re-declara entera la versión de 0058 con las seis columnas sumadas a los
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
    -- nuevas en 0060: el nivel de interacción con soporte
    new.interaccion := null;           new.wa_del_doctor := 0;
    new.wa_nuestros := 0;              new.wa_dias := 0;
    new.contactos_registrados := 0;    new.ultimo_wa_at := null;
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
  -- nuevas en 0060: el nivel sale de los mensajes y de los contactos registrados
  or new.interaccion              is distinct from old.interaccion
  or new.wa_del_doctor            is distinct from old.wa_del_doctor
  or new.wa_nuestros              is distinct from old.wa_nuestros
  or new.wa_dias                  is distinct from old.wa_dias
  or new.contactos_registrados    is distinct from old.contactos_registrados
  or new.ultimo_wa_at             is distinct from old.ultimo_wa_at
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
-- 5. Una actividad registrada mueve el nivel en el acto
-- ---------------------------------------------------------------------------
-- Versión de 0053 con una línea más. Los triggers de activities (0051) ya
-- apuntan a esta función; no se recrean. recompute_interaccion guarda y
-- devuelve la llave por su cuenta, y el envoltorio la devuelve igual al final,
-- pase lo que pase: es exactamente lo que 0053 vino a garantizar.
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
    -- 0060: la llamada o la reunión recién cargada cuenta ahora, no a la noche
    perform recompute_interaccion(v_doctor);
    -- Devolver la llave, pase lo que pase. Sin esto, quien registró la actividad
    -- se queda con permisos de sistema hasta el final de su transacción.
    perform set_config('app.system', v_previo, true);
  end if;
  return null;
end $fn$;

-- ---------------------------------------------------------------------------
-- 6. Cuándo se recalcula
-- ---------------------------------------------------------------------------
-- El WhatsApp directo lo llama al final de cada corrida (app/api/sync/whatsapp)
-- y /ajustes al guardar los umbrales. El cron nocturno es la red: la ventana se
-- mueve sola aunque no entre un mensaje.
do $$
begin
  perform cron.schedule('crm-interaccion-nightly', '28 11 * * *',
                        'select recompute_interaccion()');
exception when others then
  raise notice 'pg_cron no disponible (%). Programar recompute_interaccion() manualmente.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Primera corrida y verificación
-- ---------------------------------------------------------------------------
do $$
declare
  v_real int; v_pun int; v_sin int; v_nulos int;
  v_act_transaccional int; v_ina_sin int; v_ina_real int;
begin
  perform recompute_interaccion();
  select count(*) filter (where interaccion = 'real'),
         count(*) filter (where interaccion = 'puntual'),
         count(*) filter (where interaccion = 'sin_contacto'),
         count(*) filter (where interaccion is null),
         count(*) filter (where segmento = 'activo' and interaccion <> 'real'),
         count(*) filter (where segmento = 'inactivo' and interaccion = 'sin_contacto'),
         count(*) filter (where segmento = 'inactivo' and interaccion = 'real')
    into v_real, v_pun, v_sin, v_nulos, v_act_transaccional, v_ina_sin, v_ina_real
    from doctors where is_accredited and not is_demo;
  if v_nulos > 0 then
    raise exception '0060: % acreditados quedaron sin nivel de interacción', v_nulos;
  end if;
  if exists (select 1 from doctors where not is_accredited and interaccion is not null) then
    raise exception '0060: hay no acreditados con nivel de interacción';
  end if;
  if not exists (select 1 from automation_rules where key = 'interaccion_soporte') then
    raise exception '0060: falta la regla interaccion_soporte';
  end if;
  raise notice '0060 OK: % real, % puntual, % sin contacto. Activos solo transaccionales (sin interacción real): %. Inactivos sin contacto: %. Inactivos con interacción real: %.',
    v_real, v_pun, v_sin, v_act_transaccional, v_ina_sin, v_ina_real;
end $$;

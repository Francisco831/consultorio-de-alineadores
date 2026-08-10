-- 0015: DOS UNIVERSOS de doctores — columnas de journey, backfill y transiciones.
--
-- Universo A (NO acreditado): objetivo = LOGRAR QUE SE ACREDITE.
--   Pipeline de adquisición en doctors.acquisition_stage.
-- Universo B (acreditado): objetivo = GENERAR CASOS y subir frecuencia.
--   Pipeline de activación en doctors.activation_stage hasta el primer caso pagado.
-- El corte entre universos es doctors.is_accredited (Conversion 1 = acreditarse,
-- Conversion 2 = activarse, Conversion 3 = repetir — se miden por separado).

-- ---------- columnas nuevas ----------
alter table doctors
  add column if not exists is_accredited boolean not null default false,
  add column if not exists acquisition_stage acq_stage,
  add column if not exists activation_stage act_stage,
  -- fechas fundamentales del journey (item HISTORIAL)
  add column if not exists first_contact_at timestamptz,
  add column if not exists first_meeting_at timestamptz,
  add column if not exists accreditation_scheduled_at date,
  add column if not exists first_paid_case_at date,
  add column if not exists last_paid_case_at date,
  add column if not exists days_to_first_case int,
  add column if not exists activated_by uuid references profiles(id),
  add column if not exists reactivated_at date,
  add column if not exists lost_reason text,
  -- perfil de PROSPECTO (info que sí existe antes de acreditarse)
  add column if not exists specialty text,
  add column if not exists uses_aligners boolean,
  add column if not exists estimated_cases_month numeric,
  add column if not exists interest_level smallint
    check (interest_level between 1 and 5),
  add column if not exists accreditation_interest smallint
    check (accreditation_interest between 1 and 5),
  add column if not exists why_interesting text;

create index if not exists doctors_acq_stage_idx on doctors (acquisition_stage)
  where acquisition_stage is not null and not is_accredited;
create index if not exists doctors_act_stage_idx on doctors (activation_stage)
  where activation_stage is not null;
create index if not exists doctors_accredited_idx on doctors (is_accredited, lifecycle_stage);
create index if not exists doctors_accredited_at_idx on doctors (accredited_at)
  where accredited_at is not null;

-- buckets nuevos para /hoy: trabajo de adquisición y de activación diferenciados
alter table doctors drop constraint if exists doctors_priority_bucket_check;
alter table doctors add constraint doctors_priority_bucket_check
  check (priority_bucket in
    ('critico','alto_impacto','seguimientos','oportunidades','riesgo','growth',
     'nuevo_negocio','activacion'));

-- ---------- backfill ----------
-- 1. Acreditados = existen en Noloco (tienen cuenta) o tienen casos reales.
update doctors d set is_accredited = true
where not is_accredited
  and (noloco_id is not null
       or accredited_at is not null
       or exists (select 1 from cases c where c.doctor_id = d.id and not c.is_demo));

-- 2. Etapas deprecadas → equivalentes del modelo nuevo.
update doctors set lifecycle_stage = 'acreditacion_agendada'
  where lifecycle_stage = 'acreditacion_pendiente';
update doctors set lifecycle_stage = 'en_activacion'
  where lifecycle_stage = 'acreditado_no_activado';

-- 3. Universo A: etapa de adquisición inicial según señal real.
--    Con chat de WhatsApp vivo = contacto logrado; sin canal = solo identificado.
update doctors d set
  acquisition_stage = case
    when exists (select 1 from wa_conversations w where w.doctor_id = d.id)
      then 'contactado'::acq_stage
    else 'identificado'::acq_stage end,
  lifecycle_stage = case
    when lifecycle_stage <> 'prospecto' then lifecycle_stage
    when exists (select 1 from wa_conversations w where w.doctor_id = d.id)
      then 'contactado'::lifecycle_stage
    else 'prospecto'::lifecycle_stage end
where not is_accredited and acquisition_stage is null
  and lifecycle_stage not in ('perdido');

-- 4. Pagos → fechas de activación (la verdad del "pagado" es payments).
update doctors d set
  first_paid_case_at = p.first_paid,
  last_paid_case_at  = p.last_paid
from (
  select doctor_id, min(paid_at) as first_paid, max(paid_at) as last_paid
  from payments where not is_demo and doctor_id is not null
  group by doctor_id
) p
where p.doctor_id = d.id;

update doctors set days_to_first_case = first_paid_case_at - accredited_at
where accredited_at is not null and first_paid_case_at is not null
  and first_paid_case_at >= accredited_at;

-- 5. Universo B sin activar → lifecycle en_activacion + etapa del pipeline
--    de activación (mejorada por la oportunidad abierta más avanzada).
update doctors set lifecycle_stage = 'en_activacion'
where is_accredited and new_case_count = 0 and first_paid_case_at is null
  and lifecycle_stage in ('acreditado','activo','prospecto');

update doctors d set activation_stage = 'acreditado'
where is_accredited and first_paid_case_at is null and new_case_count = 0
  and activation_stage is null
  and lifecycle_stage in ('acreditado','en_activacion');

update doctors d set activation_stage = best.st
from (
  select o.doctor_id,
         max(case o.stage
           when 'viabilidad' then 1 when 'paciente_potencial' then 1
           when 'documentacion' then 2 when 'caso_ingresado' then 3
           when 'planificacion' then 4 else 5 end) as rank_,
         (array['paciente_potencial','documentacion','caso_ingresado',
                'planificacion','presentado'])[
           max(case o.stage
             when 'viabilidad' then 1 when 'paciente_potencial' then 1
             when 'documentacion' then 2 when 'caso_ingresado' then 3
             when 'planificacion' then 4 else 5 end)]::act_stage as st
  from opportunities o
  where o.stage not in ('ganada','perdida') and not o.is_demo
  group by o.doctor_id
) best
where best.doctor_id = d.id and d.activation_stage = 'acreditado';

-- 6. Primer contacto / primera reunión desde el historial real de actividades.
update doctors d set first_contact_at = a.first_any, first_meeting_at = a.first_meet
from (
  select doctor_id,
         min(occurred_at) as first_any,
         min(occurred_at) filter (where type in ('reunion','visita')) as first_meet
  from activities where not is_demo
  group by doctor_id
) a
where a.doctor_id = d.id;

-- ---------- trigger de journey: transiciones automáticas entre universos ----------
-- Mover acquisition_stage a 'acreditado' registra Accreditation Date y pasa al
-- pipeline de activación (MISMO doctor, mismo registro — nunca se duplica).
-- Mover activation_stage a 'primer_caso_pagado' registra First Case Date,
-- Days to First Case y Activated By, y cambia lifecycle a 'activado'.
create or replace function doctors_journey_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old_acq acq_stage := case when tg_op = 'UPDATE' then old.acquisition_stage else null end;
  v_old_act act_stage := case when tg_op = 'UPDATE' then old.activation_stage else null end;
  v_old_lc  lifecycle_stage := case when tg_op = 'UPDATE' then old.lifecycle_stage else null end;
begin
  -- regla de datos: existir en Noloco o tener fecha de acreditación = acreditado
  -- (aplica SIEMPRE, también a imports/recompute)
  if new.noloco_id is not null or new.accredited_at is not null then
    new.is_accredited := true;
  end if;

  -- las derivaciones de acá abajo son para movimientos HUMANOS (kanban/formularios);
  -- el sistema (recompute, imports, backfills) escribe los valores verdaderos directo
  if is_system() then
    return new;
  end if;

  -- ---- CONVERSIÓN 1: se acreditó ----
  if new.acquisition_stage = 'acreditado' and v_old_acq is distinct from 'acreditado' then
    new.is_accredited := true;
    new.accredited_at := coalesce(new.accredited_at, current_date);
    new.activation_stage := coalesce(new.activation_stage, 'acreditado');
    if new.lifecycle_stage is not distinct from v_old_lc then
      new.lifecycle_stage := 'en_activacion';
    end if;
  elsif new.acquisition_stage = 'no_interesado'
        and v_old_acq is distinct from 'no_interesado' then
    if new.lifecycle_stage is not distinct from v_old_lc then
      new.lifecycle_stage := 'perdido';
    end if;
  elsif new.acquisition_stage is distinct from v_old_acq and not new.is_accredited then
    -- el kanban de adquisición mueve el lifecycle (salvo override explícito)
    if new.lifecycle_stage is not distinct from v_old_lc then
      new.lifecycle_stage := case new.acquisition_stage
        when 'identificado'          then 'prospecto'
        when 'contacto_intentado'    then 'prospecto'
        when 'contactado'            then 'contactado'
        when 'calificado'            then 'calificacion'
        when 'reunion_agendada'      then 'calificacion'
        when 'reunion_realizada'     then 'calificacion'
        when 'interes_acreditacion'  then 'interes_acreditacion'
        when 'acreditacion_agendada' then 'acreditacion_agendada'
        else new.lifecycle_stage end;
    end if;
    if new.acquisition_stage = 'acreditacion_agendada' then
      new.accreditation_scheduled_at := coalesce(new.accreditation_scheduled_at, current_date);
    end if;
  end if;

  -- ---- CONVERSIÓN 2: pagó su primer caso ----
  if new.activation_stage = 'primer_caso_pagado'
     and v_old_act is distinct from 'primer_caso_pagado' then
    new.first_paid_case_at := coalesce(new.first_paid_case_at, current_date);
    if new.accredited_at is not null and new.days_to_first_case is null then
      new.days_to_first_case := new.first_paid_case_at - new.accredited_at;
    end if;
    new.activated_by := coalesce(new.activated_by, auth.uid());
    if new.lifecycle_stage is not distinct from v_old_lc then
      new.lifecycle_stage := 'activado';
    end if;
  end if;

  -- reactivación manual: registrar la fecha
  if new.lifecycle_stage = 'reactivado' and v_old_lc is distinct from 'reactivado'
     and new.reactivated_at is null then
    new.reactivated_at := current_date;
  end if;

  return new;
end $$;

-- corre DESPUÉS de doctors_guard (orden alfabético de triggers BEFORE):
-- guard valida lo que mandó el cliente; journey deriva los efectos del sistema.
drop trigger if exists doctors_journey_trg on doctors;
create trigger doctors_journey_trg
  before insert or update on doctors
  for each row execute function doctors_journey_sync();

-- ---------- guard: las fechas calculadas son del sistema ----------
create or replace function doctors_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- un alta desde el cliente entra con los campos calculados vacíos
    new.health_score := null;          new.health_factors := null;
    new.health_confidence := null;     new.potential_computed := null;
    new.priority_score := null;        new.priority_reasons := null;
    new.priority_bucket := null;       new.recommended_action := null;
    new.avg_interval_days := null;     new.expected_next_case_at := null;
    new.case_count := 0;               new.new_case_count := 0;
    new.first_case_at := null;         new.last_case_at := null;
    new.last_new_case_at := null;
    new.first_paid_case_at := null;    new.last_paid_case_at := null;
    new.days_to_first_case := null;
    if not is_manager() then
      new.potential_override := null;
    end if;
    return new;
  end if;
  -- columnas cacheadas de score: solo el sistema las escribe
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
  -- fechas de activación: las calculan payments/el trigger de journey
  or new.first_paid_case_at    is distinct from old.first_paid_case_at
  or new.last_paid_case_at     is distinct from old.last_paid_case_at
  or new.days_to_first_case    is distinct from old.days_to_first_case
  or new.first_contact_at      is distinct from old.first_contact_at
  or new.first_meeting_at      is distinct from old.first_meeting_at
  then
    raise exception 'Las columnas de score las calcula el sistema';
  end if;
  -- columnas de gestión: solo managers
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

-- ---------- audit ampliado: el journey queda en el historial ----------
create or replace function doctors_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.lifecycle_stage is distinct from old.lifecycle_stage then
    perform log_audit('doctor', new.id, 'lifecycle_stage', old.lifecycle_stage::text, new.lifecycle_stage::text);
  end if;
  if new.acquisition_stage is distinct from old.acquisition_stage then
    perform log_audit('doctor', new.id, 'acquisition_stage', old.acquisition_stage::text, new.acquisition_stage::text);
  end if;
  if new.activation_stage is distinct from old.activation_stage then
    perform log_audit('doctor', new.id, 'activation_stage', old.activation_stage::text, new.activation_stage::text);
  end if;
  if new.accredited_at is distinct from old.accredited_at then
    perform log_audit('doctor', new.id, 'accredited_at', old.accredited_at::text, new.accredited_at::text);
  end if;
  if new.owner_id is distinct from old.owner_id then
    perform log_audit('doctor', new.id, 'owner_id', old.owner_id::text, new.owner_id::text);
  end if;
  if new.categoria is distinct from old.categoria then
    perform log_audit('doctor', new.id, 'categoria', old.categoria::text, new.categoria::text);
  end if;
  if new.potential_override is distinct from old.potential_override then
    perform log_audit('doctor', new.id, 'potential_override', old.potential_override::text, new.potential_override::text);
  end if;
  return new;
end $$;

-- ---------- pagos disparan recompute (activación automática) ----------
drop trigger if exists payments_recompute_trg on payments;
create trigger payments_recompute_trg
  after insert or update on payments
  for each row execute function recompute_doctor_trigger();

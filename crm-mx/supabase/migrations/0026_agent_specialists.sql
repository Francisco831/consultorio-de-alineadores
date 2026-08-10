-- 0026 — Fase 3: los agentes como especialistas reales.
--
-- Qué agrega, y por qué cada cosa:
--   1. NEXT BEST ACTION completa: el cuello de botella que se ataca, quién ejecuta
--      (no todo es del comercial), la etapa, el resultado buscado y qué gatilla el
--      seguimiento. Sin esto una recomendación es una frase, no una acción.
--   2. TAXONOMÍA DE DESCARTE: el motivo pasa de texto libre a enum. Texto libre no
--      se puede contar, y este es el insumo del aprendizaje.
--   3. HISTORIAL DE HANDOFFS: quién le pasó el doctor a quién y con qué resultado.
--      Es lo que después permite medir Adquisición→Acreditación→Activación→Growth.
--   4. COSTO POR CORRIDA: tokens ya se guardaban; faltaba el costo estimado y los
--      tokens de caché para poder decidir con números si conviene otro modelo.
--   5. MÉTRICAS DEL SEGUNDO CASO: el primer caso puede ser una prueba; el segundo
--      es adopción. Se calcula en Postgres, no trayendo filas.
--
-- Idempotente: se puede correr varias veces.

-- ---------------------------------------------------------------------------
-- 1. Next Best Action en ai_recommendations
-- ---------------------------------------------------------------------------

alter table ai_recommendations
  add column if not exists bottleneck text,
  add column if not exists owner_role text,
  add column if not exists current_stage text,
  add column if not exists expected_outcome text,
  add column if not exists follow_up_condition text,
  add column if not exists routing_confidence int,
  add column if not exists dismiss_code text,
  -- lo que el humano dejó finalmente, cuando editó antes de aceptar: es la
  -- corrección humana, el dato más valioso del loop de aprendizaje
  add column if not exists human_edited boolean not null default false,
  add column if not exists final_action jsonb;

do $$ begin
  alter table ai_recommendations add constraint ai_rec_bottleneck_check
    check (bottleneck is null or bottleneck in (
      'DATOS_INSUFICIENTES','SIN_DUENO','SERVICIO','INCERTIDUMBRE_CLINICA','SIN_RELACION',
      'SIN_ACREDITACION','SIN_CASO_PROPIO','SIN_PRIMER_PACIENTE','SIN_SEGUNDO_CASO',
      'SIN_PACIENTES','CONVERSION_PACIENTE','DOCUMENTACION','PRECIO','EQUIPO',
      'SIN_SEGUIMIENTO','TIEMPO','CADENCIA_CAIDA','BRECHA_CRECIMIENTO','COMPETENCIA','NINGUNO','DESCONOCIDO'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table ai_recommendations add constraint ai_rec_owner_role_check
    check (owner_role is null or owner_role in
      ('SALES','CLINICAL','COUNTRY_MANAGER','OPERATIONS','ADMIN','MARKETING'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table ai_recommendations add constraint ai_rec_dismiss_code_check
    check (dismiss_code is null or dismiss_code in
      ('ya_hecho','momento_equivocado','interpretacion_equivocada','doctor_pidio_no_contacto',
       'existe_mejor_accion','dato_malo','no_apropiado_comercialmente','otro'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table ai_recommendations add constraint ai_rec_routing_conf_check
    check (routing_confidence is null or (routing_confidence between 0 and 100));
exception when duplicate_object then null; end $$;

comment on column ai_recommendations.bottleneck is
  'Qué impide que este doctor pase al siguiente estado sano. Es la unidad de '
  'razonamiento del sistema: el ruteo lo calcula, el agente lo ataca y el '
  'director lo agrega para ver dónde está trabada la máquina comercial.';

comment on column ai_recommendations.owner_role is
  'Quién EJECUTA. El agente no le asigna todo al comercial: una duda clínica es '
  'del equipo clínico y un caso trabado es de operaciones.';

comment on column ai_recommendations.final_action is
  'Lo que el humano dejó tras editar, cuando difiere de lo propuesto. Junto con '
  'dismiss_code es el corpus de "cómo los humanos corrigen a la IA".';

create index if not exists ai_rec_bottleneck_idx
  on ai_recommendations (bottleneck) where status = 'propuesta';
create index if not exists ai_rec_owner_role_idx
  on ai_recommendations (owner_role) where status = 'propuesta';

-- ---------------------------------------------------------------------------
-- 2. Historial de handoffs entre agentes
-- ---------------------------------------------------------------------------

create table if not exists agent_handoffs (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors(id) on delete cascade,
  agent_from text not null,
  agent_to text not null,
  reason text not null,
  doctor_stage text,                    -- lifecycle_stage al momento del handoff
  bottleneck text,
  run_id uuid,
  -- se completa después: ¿el doctor avanzó tras el handoff?
  outcome text check (outcome is null or outcome in
    ('avanzo_etapa','caso_generado','sin_cambio','retrocedio','sin_evaluar')),
  outcome_at timestamptz,
  created_at timestamptz not null default now()
);

do $$ begin
  alter table agent_handoffs add constraint agent_handoffs_agents_check
    check (agent_from <> agent_to
       and agent_from in ('orchestrator','acquisition','accreditation','activation',
                          'clinical_education','growth','retention_reactivation',
                          'doctor_success','commercial_director')
       and agent_to   in ('orchestrator','acquisition','accreditation','activation',
                          'clinical_education','growth','retention_reactivation',
                          'doctor_success','commercial_director'));
exception when duplicate_object then null; end $$;

comment on table agent_handoffs is
  'Quién le pasó el doctor a qué agente y por qué. Permite medir después las '
  'transiciones reales del journey: Adquisición→Acreditación→Activación→Growth, '
  'y si la intervención clínica desbloqueó la activación.';

create index if not exists agent_handoffs_doctor_idx on agent_handoffs (doctor_id, created_at desc);
create index if not exists agent_handoffs_pair_idx on agent_handoffs (agent_from, agent_to);

alter table agent_handoffs enable row level security;

drop policy if exists agent_handoffs_select on agent_handoffs;
create policy agent_handoffs_select on agent_handoffs
  for select to authenticated using (true);
-- Solo el runner (service-role) escribe: es auditoría, no dato editable.

-- ---------------------------------------------------------------------------
-- 3. Costo por corrida
-- ---------------------------------------------------------------------------

alter table agent_runs
  add column if not exists cache_read_tokens int,
  add column if not exists cache_write_tokens int,
  add column if not exists cost_usd numeric(10,5),
  add column if not exists bottleneck text,
  add column if not exists trigger_reason text;

comment on column agent_runs.cost_usd is
  'Costo estimado de la corrida con el precio del modelo vigente al momento. '
  'Estimado, no factura: sirve para decidir modelo y frecuencia, no para contabilidad.';

comment on column agent_runs.trigger_reason is
  'Qué disparó el recálculo (nueva acreditación, caso nuevo, resultado de '
  'viabilidad, problema de servicio, pedido manual...). Sin esto no se puede '
  'saber si estamos re-analizando doctores que no cambiaron.';

-- ---------------------------------------------------------------------------
-- 4. Métricas del segundo caso (adopción, no prueba)
-- ---------------------------------------------------------------------------

-- Un caso cuenta como de PACIENTE solo si está clasificado PATIENT. Con la base
-- en 0% clasificada esto devuelve ceros y lo declara: es correcto, no un bug.
create or replace function ai_second_case_metrics()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with pacientes as (
    select c.doctor_id,
           c.fecha_ingreso,
           row_number() over (partition by c.doctor_id order by c.fecha_ingreso, c.id) as n
      from cases c
     where c.case_subject_type = 'PATIENT'
       and c.fecha_ingreso is not null
       and coalesce(c.is_demo, false) = false
  ),
  primeros as (select doctor_id, fecha_ingreso as f1 from pacientes where n = 1),
  segundos as (select doctor_id, fecha_ingreso as f2 from pacientes where n = 2),
  j as (
    select p.doctor_id, p.f1, s.f2,
           case when s.f2 is not null then (s.f2::date - p.f1::date) end as dias
      from primeros p left join segundos s on s.doctor_id = p.doctor_id
  )
  select jsonb_build_object(
    'doctors_with_first_patient_case', (select count(*) from j),
    'doctors_with_second_patient_case', (select count(*) from j where f2 is not null),
    'doctors_with_first_but_no_second', (select count(*) from j where f2 is null),
    'second_case_conversion_rate',
      case when (select count(*) from j) = 0 then null
           else round(100.0 * (select count(*) from j where f2 is not null) / (select count(*) from j), 1) end,
    'time_first_to_second_median_days', (select percentile_cont(0.5) within group (order by dias) from j where dias is not null),
    'time_first_to_second_avg_days', (select round(avg(dias)::numeric, 1) from j where dias is not null),
    -- honestidad: cuánto del universo NO se puede evaluar todavía
    'cases_unclassified', (select count(*) from cases where case_subject_type = 'UNKNOWN' and coalesce(is_demo,false) = false),
    'limitation',
      case when (select count(*) from cases where case_subject_type = 'PATIENT') = 0
           then 'Ningún caso está clasificado como de paciente todavía: estas métricas no se pueden calcular. No interpretar los ceros como ausencia de segundos casos.'
           else null end,
    'calculated_at', now()
  );
$$;

comment on function ai_second_case_metrics is
  'Adopción vs. prueba: cuántos doctores pasaron del primer caso de paciente al '
  'segundo, en cuánto tiempo, y cuántos quedaron en el primero. Declara cuántos '
  'casos siguen sin clasificar para no leer un cero como un hecho.';

revoke all on function ai_second_case_metrics() from public;
grant execute on function ai_second_case_metrics() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Verificación
-- ---------------------------------------------------------------------------

do $$
declare m jsonb;
begin
  select ai_second_case_metrics() into m;
  raise notice '0026: segundo caso → %', m->>'limitation';
end $$;

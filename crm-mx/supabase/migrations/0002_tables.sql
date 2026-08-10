-- 0002: tablas principales (~20) e índices

-- ---------- helpers ----------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- profiles (1:1 auth.users) ----------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  rol user_role not null default 'VIEWER',
  activo boolean not null default true,
  avatar_url text,
  whatsapp_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- campaigns (lookup mínimo V1) ----------
create table campaigns (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  tipo attribution_source not null default 'campana',
  starts_on date,
  ends_on date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- doctors: el centro del sistema ----------
create table doctors (
  id uuid primary key default gen_random_uuid(),
  noloco_id text unique,               -- clave de sync con Noloco; null = doctor nacido en CRM
  nombre text not null,
  email text,
  phone text,
  whatsapp text,
  categoria doctor_categoria not null default 'SIN_CATEGORIA',
  lifecycle_stage lifecycle_stage not null default 'prospecto',
  owner_id uuid references profiles(id),
  clinical_owner_id uuid references profiles(id),
  clinic_name text,
  address text,
  city text,
  state text,
  zona text,                           -- territorio comercial: CDMX | Norte | Sur | Foráneos

  source attribution_source,
  campaign_id uuid references campaigns(id),
  accredited_at date,
  tags text[] not null default '{}',
  competitor_brands text[] not null default '{}',
  custom jsonb not null default '{}',
  -- ---- bloque de scores cacheados: solo escriben las funciones del sistema ----
  health_score int,
  health_factors jsonb,
  health_confidence text check (health_confidence in ('personal','cohort','insuficiente')),
  potential_computed int,
  potential_override int,              -- efectivo = coalesce(override, computed)
  priority_score int,
  priority_reasons jsonb,
  priority_bucket text check (priority_bucket in
    ('critico','alto_impacto','seguimientos','oportunidades','riesgo','growth')),
  recommended_action jsonb,            -- {type, label}
  avg_interval_days numeric,
  expected_next_case_at date,
  case_count int not null default 0,
  new_case_count int not null default 0,
  first_case_at date,
  last_case_at date,
  last_new_case_at date,
  last_contact_at timestamptz,
  -- ----
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index doctors_owner_idx on doctors (owner_id);
create index doctors_lifecycle_idx on doctors (lifecycle_stage);
create index doctors_priority_idx on doctors (priority_score desc nulls last);
create index doctors_expected_next_idx on doctors (expected_next_case_at);
create index doctors_tags_idx on doctors using gin (tags);
create index doctors_nombre_trgm_idx on doctors using gin (nombre gin_trgm_ops);

-- ---------- contacts (personas de la clínica: secretarias, asistentes) ----------
create table contacts (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors(id) on delete cascade,
  nombre text not null,
  rol_en_clinica text,
  phone text,
  whatsapp text,
  email text,
  es_principal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_doctor_idx on contacts (doctor_id);

-- ---------- cases: espejo 1:1 de Noloco, NUNCA se edita a mano ----------
create table cases (
  id uuid primary key default gen_random_uuid(),
  noloco_case_id text unique not null,   -- clave de upsert idempotente
  id_externo text,                       -- 'BW506'
  doctor_id uuid not null references doctors(id),
  paciente text,
  tipo_tratamiento text,
  etapa text,
  is_new_case boolean not null,          -- LA regla del KPI: etapa = 'I_1'
  needs_review boolean not null default false,
  treatment_key text,                    -- agrupa etapas de un mismo tratamiento
  fecha_ingreso timestamptz not null,
  fecha_documentacion timestamptz,
  fecha_aprobacion timestamptz,
  fecha_edicion timestamptz,
  fecha_movimientos timestamptz,
  fecha_video timestamptz,
  fecha_aprobacion_video timestamptz,
  fecha_impresion timestamptz,
  fecha_finalizado timestamptz,
  fecha_entrega timestamptz,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cases_doctor_fecha_idx on cases (doctor_id, fecha_ingreso desc);
create index cases_fecha_idx on cases (fecha_ingreso);
create index cases_new_case_idx on cases (fecha_ingreso) where is_new_case;
create index cases_paciente_trgm_idx on cases using gin (paciente gin_trgm_ops);
create index cases_video_pendiente_idx on cases (fecha_video)
  where fecha_aprobacion_video is null;

-- ---------- payments: la verdad del KPI "casos pagados" (planilla de cobros) ----------
create table payments (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid references doctors(id),
  case_id uuid references cases(id),
  paciente text,
  amount_mxn numeric,
  paid_at date not null,
  method text,
  notes text,
  source text not null default 'app',    -- 'app' | 'import'
  external_key text unique,              -- clave idempotente del import (fila de la planilla)
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_paid_at_idx on payments (paid_at);
create index payments_doctor_idx on payments (doctor_id);

-- ---------- opportunities ----------
create table opportunities (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors(id) on delete cascade,
  patient_name text,
  stage opp_stage not null default 'paciente_potencial',
  stage_entered_at timestamptz not null default now(),
  amount_mxn numeric,
  probability int check (probability between 0 and 100),
  forecast_category forecast_cat not null default 'pipeline',
  expected_close_date date,
  source attribution_source,
  campaign_id uuid references campaigns(id),
  owner_id uuid references profiles(id),
  case_id uuid references cases(id),
  lost_reason text,
  closed_at timestamptz,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index opps_open_idx on opportunities (stage) where stage not in ('ganada','perdida');
create index opps_doctor_idx on opportunities (doctor_id);
create index opps_owner_stage_idx on opportunities (owner_id, stage);

-- ---------- automation_rules (el "no-code" V1: umbrales en params) ----------
create table automation_rules (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  nombre text not null,
  descripcion text,
  enabled boolean not null default true,
  params jsonb not null default '{}',
  creates_task boolean not null default false,
  task_type task_type,
  last_run_at timestamptz,
  run_stats jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- alerts ----------
create table alerts (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null,
  doctor_id uuid references doctors(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete cascade,
  severity alert_severity not null default 'media',
  title text not null,
  reason text,
  status alert_status not null default 'abierta',
  resolved_by uuid references profiles(id),
  resolved_at timestamptz,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- dedupe: una alerta abierta por regla+doctor (solo alertas a nivel doctor) /
-- regla+oportunidad. Las alertas por oportunidad llevan doctor_id además, por eso
-- el índice de doctor excluye opportunity_id no-null.
create unique index alerts_dedupe_doctor_idx on alerts (rule_key, doctor_id)
  where status = 'abierta' and doctor_id is not null and opportunity_id is null;
create unique index alerts_dedupe_opp_idx on alerts (rule_key, opportunity_id)
  where status = 'abierta' and opportunity_id is not null;
create index alerts_open_idx on alerts (status, severity) where status = 'abierta';

-- ---------- tasks ----------
create table tasks (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid references doctors(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete set null,
  type task_type not null default 'seguimiento',
  title text not null,
  due_date date,
  status task_status not null default 'pendiente',
  outcome text,
  completed_at timestamptz,
  assigned_to uuid references profiles(id),
  created_by uuid references profiles(id),
  automation_rule_id uuid references automation_rules(id),
  alert_id uuid references alerts(id),
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_assigned_idx on tasks (assigned_to, status, due_date);
create index tasks_doctor_idx on tasks (doctor_id);

-- ---------- activities (incluye notas: type='nota') ----------
create table activities (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete set null,
  type activity_type not null,
  occurred_at timestamptz not null default now(),
  summary text,
  outcome text,
  created_by uuid references profiles(id),
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index activities_doctor_idx on activities (doctor_id, occurred_at desc);
create index activities_creator_idx on activities (created_by, occurred_at);

-- ---------- audit_log: LA tabla de historial (append-only) ----------
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  field text not null,
  old_value text,
  new_value text,
  actor_id uuid,                        -- null = sistema/cron/import
  source text not null default 'app',   -- 'app' | 'automation' | 'import'
  created_at timestamptz not null default now()
);
create index audit_entity_idx on audit_log (entity_type, entity_id, created_at desc);
create index audit_field_idx on audit_log (field, created_at);

-- ---------- score_snapshots: 1 fila/doctor/día ----------
create table score_snapshots (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors(id) on delete cascade,
  snapshot_date date not null default current_date,
  health int,
  potential int,
  priority int,
  created_at timestamptz not null default now(),
  unique (doctor_id, snapshot_date)
);

-- ---------- segments (reglas jsonb, evaluadas on-read) ----------
create table segments (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  rules jsonb not null default '[]',
  owner_id uuid references profiles(id),
  is_shared boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- saved_views ----------
create table saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  route text not null,
  nombre text not null,
  config jsonb not null default '{}',
  is_default boolean not null default false,
  is_shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index saved_views_user_idx on saved_views (user_id, route);

-- ---------- goals ----------
create table goals (
  id uuid primary key default gen_random_uuid(),
  period date not null,                 -- primer día del mes
  metric text not null,                 -- 'paid_cases' | 'activations' | 'reactivations' | 'activities'
  target int not null,
  user_id uuid references profiles(id), -- null = objetivo país
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index goals_unique_idx on goals (period, metric, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------- custom_field_defs (registro; valores viven en .custom jsonb) ----------
create table custom_field_defs (
  id uuid primary key default gen_random_uuid(),
  entity text not null,                 -- 'doctors' | 'opportunities'
  key text not null,
  label text not null,
  field_type text not null,             -- text|number|currency|date|boolean|select|multiselect|user|relation
  options jsonb,
  created_at timestamptz not null default now(),
  unique (entity, key)
);

-- ---------- WhatsApp-ready (solo DDL en V1) ----------
create table wa_conversations (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid references doctors(id) on delete set null,
  phone text not null,
  periskope_chat_id text unique,
  last_message_at timestamptz,
  unanswered boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table wa_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references wa_conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  body text,
  sent_at timestamptz not null,
  periskope_msg_id text unique,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index wa_messages_conv_idx on wa_messages (conversation_id, sent_at desc);

-- ---------- sync_runs (idempotencia del import + sync futuro) ----------
create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,                 -- 'noloco' | 'seed' | 'sheets'
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_upserted int,
  watermark timestamptz,
  status text not null default 'running',
  log jsonb,
  created_at timestamptz not null default now()
);

-- ---------- updated_at en todas las tablas que lo tienen ----------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','campaigns','doctors','contacts','cases','payments','opportunities',
    'automation_rules','alerts','tasks','activities','segments','saved_views','goals',
    'wa_conversations'
  ] loop
    execute format(
      'create trigger %I before update on %I for each row execute function set_updated_at()',
      t || '_updated_at', t
    );
  end loop;
end $$;

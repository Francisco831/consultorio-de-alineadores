-- 0001: extensiones y enums
-- pg_trgm: búsqueda global por similitud de nombres
create extension if not exists pg_trgm;

create type doctor_categoria as enum (
  'SIN_CATEGORIA','SILVER','GOLD','PLATINUM','BLACK','ELITE'
);

create type lifecycle_stage as enum (
  'prospecto','acreditacion_pendiente','acreditado','acreditado_no_activado',
  'en_activacion','activo','growth','en_riesgo','dormido','perdido'
);

create type user_role as enum (
  'ADMIN','COUNTRY_MANAGER','SALES_MANAGER','SALES','CLINICAL','VIEWER'
);

create type opp_stage as enum (
  'paciente_potencial','documentacion','caso_ingresado','planificacion',
  'presentada','decision','compromiso','ganada','perdida'
);

create type forecast_cat as enum ('pipeline','best_case','commit','closed','omitted');

create type task_type as enum ('llamada','whatsapp','visita','reunion','revision_clinica','seguimiento');
create type task_status as enum ('pendiente','completada','cancelada');

-- 'keepday' = evento comercial mensual por asesor (métrica de comisiones LATAM 80/10/10)
create type activity_type as enum ('llamada','whatsapp','visita','reunion','revision_clinica','email','nota','keepday');

create type alert_status as enum ('abierta','descartada','resuelta');
create type alert_severity as enum ('critica','alta','media','info');

create type attribution_source as enum (
  'ventas','clinica','evento','curso','inbound','referido','existente','campana'
);
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
-- 0003: helpers de rol, audit triggers, guardas de columnas y transiciones de negocio

-- ---------- rol del usuario actual (null = sistema/service role) ----------
create or replace function current_rol() returns user_role
language sql stable security definer set search_path = public as $$
  select rol from profiles where id = auth.uid()
$$;

create or replace function is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_rol() in ('ADMIN','COUNTRY_MANAGER','SALES_MANAGER'), false)
$$;

-- "sistema" = sin sesión (service role / cron) o funciones internas que setean app.system
create or replace function is_system() returns boolean
language sql stable as $$
  select auth.uid() is null or coalesce(current_setting('app.system', true), '') = 'on'
$$;

-- ---------- audit helper ----------
create or replace function log_audit(
  p_entity text, p_id uuid, p_field text, p_old text, p_new text
) returns void
language sql security definer set search_path = public as $$
  insert into audit_log (entity_type, entity_id, field, old_value, new_value, actor_id, source)
  values (
    p_entity, p_id, p_field, p_old, p_new, auth.uid(),
    coalesce(nullif(current_setting('app.source', true), ''), 'app')
  )
$$;

-- ---------- profile automático al crear usuario en auth ----------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_rol user_role;
begin
  -- rol SOLO desde app_metadata (lo setea el admin API / server; el cliente NO puede
  -- setearlo en signup). user_metadata es controlado por el cliente => nunca autoriza.
  -- El CASE valida contra el enum: metadata malformada cae a VIEWER en vez de abortar
  -- el alta en auth.users con un cast fallido.
  v_rol := (case new.raw_app_meta_data->>'rol'
    when 'ADMIN'           then 'ADMIN'
    when 'COUNTRY_MANAGER' then 'COUNTRY_MANAGER'
    when 'SALES_MANAGER'   then 'SALES_MANAGER'
    when 'SALES'           then 'SALES'
    when 'CLINICAL'        then 'CLINICAL'
    else 'VIEWER'
  end)::user_role;

  insert into profiles (id, nombre, rol)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1)),
    v_rol
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- doctors: guarda de columnas sensibles + audit ----------
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

create trigger doctors_guard_trg
  before insert or update on doctors
  for each row execute function doctors_guard();

create or replace function doctors_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.lifecycle_stage is distinct from old.lifecycle_stage then
    perform log_audit('doctor', new.id, 'lifecycle_stage', old.lifecycle_stage::text, new.lifecycle_stage::text);
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

create trigger doctors_audit_trg
  after update on doctors
  for each row execute function doctors_audit();

-- ---------- opportunities: transiciones de etapa + audit ----------
create or replace function opportunities_transition() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    new.stage_entered_at = now();
    if new.stage = 'ganada' then
      new.closed_at = now();
      new.forecast_category = 'closed';
      new.probability = 100;
    elsif new.stage = 'perdida' then
      new.closed_at = now();
      new.forecast_category = 'omitted';
      new.probability = 0;
    end if;
  end if;
  -- probabilidad default por etapa si no viene seteada
  if new.probability is null then
    new.probability = case new.stage
      when 'paciente_potencial' then 10
      when 'documentacion'      then 25
      when 'caso_ingresado'     then 40
      when 'planificacion'      then 50
      when 'presentada'         then 60
      when 'decision'           then 70
      when 'compromiso'         then 90
      when 'ganada'             then 100
      when 'perdida'            then 0
    end;
  end if;
  return new;
end $$;

create trigger opportunities_transition_trg
  before insert or update on opportunities
  for each row execute function opportunities_transition();

create or replace function opportunities_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage is distinct from old.stage then
    perform log_audit('opportunity', new.id, 'stage', old.stage::text, new.stage::text);
  end if;
  if new.owner_id is distinct from old.owner_id then
    perform log_audit('opportunity', new.id, 'owner_id', old.owner_id::text, new.owner_id::text);
  end if;
  if new.forecast_category is distinct from old.forecast_category then
    perform log_audit('opportunity', new.id, 'forecast_category', old.forecast_category::text, new.forecast_category::text);
  end if;
  return new;
end $$;

create trigger opportunities_audit_trg
  after update on opportunities
  for each row execute function opportunities_audit();

-- ---------- tasks: completed_at + audit ----------
create or replace function tasks_transition() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'completada' then
      new.completed_at = coalesce(new.completed_at, now());
    end if;
  end if;
  return new;
end $$;

create trigger tasks_transition_trg
  before update on tasks
  for each row execute function tasks_transition();

create or replace function tasks_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    perform log_audit('task', new.id, 'status', old.status::text, new.status::text);
  end if;
  return new;
end $$;

create trigger tasks_audit_trg
  after update on tasks
  for each row execute function tasks_audit();
-- 0004: RLS — transparencia total de lectura, escritura por rol, sistema por fuera
--
-- Principios:
--  * Todos los autenticados leen todo (el equipo se ve entre sí por diseño).
--  * Escritura operacional: cualquier rol menos VIEWER.
--  * goals / automation_rules / campaigns / custom_field_defs / roles: solo managers.
--  * DELETE: solo managers (salvo saved_views propias).
--  * cases / payments / audit_log / score_snapshots / sync_runs / wa_*: sin policies de
--    escritura para clientes → solo service role (import/cron) puede escribir.

-- ---------- habilitar RLS en todo ----------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','campaigns','doctors','contacts','cases','payments','opportunities',
    'automation_rules','alerts','tasks','activities','audit_log','score_snapshots',
    'segments','saved_views','goals','custom_field_defs','wa_conversations',
    'wa_messages','sync_runs'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------- lectura: todos los autenticados ----------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','campaigns','doctors','contacts','cases','payments','opportunities',
    'automation_rules','alerts','tasks','activities','audit_log','score_snapshots',
    'segments','saved_views','goals','custom_field_defs','wa_conversations',
    'wa_messages','sync_runs'
  ] loop
    execute format(
      'create policy %I on %I for select to authenticated using (true)',
      t || '_select', t
    );
  end loop;
end $$;

-- ---------- escritura operacional: no-VIEWER ----------
create or replace function can_write() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_rol() is not null and current_rol() <> 'VIEWER', false)
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'doctors','contacts','opportunities','activities','tasks','segments'
  ] loop
    execute format(
      'create policy %I on %I for insert to authenticated with check (can_write())',
      t || '_insert', t
    );
    execute format(
      'create policy %I on %I for update to authenticated using (can_write()) with check (can_write())',
      t || '_update', t
    );
    execute format(
      'create policy %I on %I for delete to authenticated using (is_manager())',
      t || '_delete', t
    );
  end loop;
end $$;

-- alerts: el sistema las crea; los usuarios solo las resuelven/descartan
create policy alerts_update on alerts
  for update to authenticated using (can_write()) with check (can_write());

-- guarda: desde el cliente solo se tocan status/resolved_*; el resto es del sistema
create or replace function alerts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then return new; end if;
  if new.id             is distinct from old.id
  or new.rule_key       is distinct from old.rule_key
  or new.doctor_id      is distinct from old.doctor_id
  or new.opportunity_id is distinct from old.opportunity_id
  or new.severity       is distinct from old.severity
  or new.title          is distinct from old.title
  or new.reason         is distinct from old.reason
  or new.is_demo        is distinct from old.is_demo
  or new.created_at     is distinct from old.created_at
  then
    raise exception 'Las alertas solo se resuelven o descartan desde la app';
  end if;
  return new;
end $$;

create trigger alerts_guard_trg
  before update on alerts
  for each row execute function alerts_guard();

-- ---------- saved_views: cada uno gestiona las suyas ----------
create policy saved_views_insert on saved_views
  for insert to authenticated with check (user_id = auth.uid());
create policy saved_views_update on saved_views
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy saved_views_delete on saved_views
  for delete to authenticated using (user_id = auth.uid() or is_manager());

-- ---------- profiles: cada uno edita su fila; managers editan todas ----------
create policy profiles_update_own on profiles
  for update to authenticated
  using (id = auth.uid() or is_manager())
  with check (id = auth.uid() or is_manager());

-- guarda: el rol solo lo cambian managers (aunque edites tu propia fila)
create or replace function profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then return new; end if;
  if new.rol is distinct from old.rol and not is_manager() then
    raise exception 'Solo un manager puede cambiar roles';
  end if;
  return new;
end $$;

create trigger profiles_guard_trg
  before update on profiles
  for each row execute function profiles_guard();

-- ---------- tablas de manager ----------
do $$
declare t text;
begin
  foreach t in array array['goals','campaigns','custom_field_defs'] loop
    execute format(
      'create policy %I on %I for insert to authenticated with check (is_manager())',
      t || '_insert', t
    );
    execute format(
      'create policy %I on %I for update to authenticated using (is_manager()) with check (is_manager())',
      t || '_update', t
    );
    execute format(
      'create policy %I on %I for delete to authenticated using (is_manager())',
      t || '_delete', t
    );
  end loop;
end $$;

-- automation_rules: managers editan (enabled/params); nadie borra desde el cliente
create policy automation_rules_update on automation_rules
  for update to authenticated using (is_manager()) with check (is_manager());
-- 0005: motor de scores — Health / Potential / Priority con razones explicables
--
-- Arquitectura: funciones plpgsql que escriben columnas cacheadas en doctors.
-- recompute_doctor(id) por doctor; recompute_all() nightly (pg_cron) + botón manual.

-- intervalos por categoría (fallback para doctores con <3 casos nuevos)
create table cohort_intervals (
  categoria doctor_categoria primary key,
  median_interval numeric not null,
  updated_at timestamptz not null default now()
);
alter table cohort_intervals enable row level security;
create policy cohort_intervals_select on cohort_intervals
  for select to authenticated using (true);

create or replace function refresh_cohort_intervals() returns void
language sql security definer set search_path = public as $$
  insert into cohort_intervals (categoria, median_interval, updated_at)
  select d.categoria,
         percentile_cont(0.5) within group (order by p.pinterval),
         now()
  from (
    select doctor_id,
           greatest(14, least(365,
             percentile_cont(0.5) within group (order by gap_days))) as pinterval
    from (
      select doctor_id,
             extract(epoch from fecha_ingreso
               - lag(fecha_ingreso) over (partition by doctor_id order by fecha_ingreso)
             ) / 86400.0 as gap_days,
             row_number() over (partition by doctor_id order by fecha_ingreso desc) as rn
      from cases
      where is_new_case and not is_demo
    ) g
    where gap_days is not null and rn <= 8
    group by doctor_id
    having count(*) >= 2
  ) p
  join doctors d on d.id = p.doctor_id
  group by d.categoria
  on conflict (categoria) do update
    set median_interval = excluded.median_interval, updated_at = now();
$$;

-- Nota de diseño sobre is_demo: los CASOS demo se excluyen siempre (no deben tocar
-- el KPI), pero las actividades/oportunidades demo SÍ cuentan en los scores — el seed
-- las crea sobre doctores reales a propósito para que Hoy/pipeline se vean poblados
-- en la evaluación. purge_demo() las borra y recalcula, dejando los scores 100% reales.
create or replace function recompute_doctor(p_id uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  d record;
  -- casos
  v_case_count int; v_new_count int;
  v_first date; v_last date; v_last_new date;
  v_interval numeric; v_confidence text;
  v_overdue numeric := null;
  -- contacto
  v_last_contact timestamptz;
  v_contact_days numeric := null;
  -- momentum
  v_recent90 int; v_prior90 int;
  -- pipeline
  v_open_opps int; v_max_stage_rank int; v_max_prob int; v_open_amount numeric;
  v_p90_amount numeric;
  -- señales negativas
  v_lost90 boolean; v_critical_alert boolean;
  -- health
  h_freq numeric := 0; h_contact numeric := 0; h_momentum numeric := 0;
  h_pipeline numeric := 0; h_neg numeric := 10;
  v_health int;
  -- potential
  v_cat_pts numeric; v_capacity int; v_cap_pts numeric; v_lc_pts numeric;
  v_potential int;
  -- priority
  v_urgency numeric := 0; v_value numeric := 0; v_prob numeric := 0;
  v_decay numeric := 1.0; v_priority int;
  reasons jsonb := '[]'::jsonb;
  top_code text := null; top_weight numeric := -1;
  v_bucket text; v_action jsonb;
  -- opp estancada
  v_stalled record;
  v_stalled_found boolean := false;
  v_expected_days jsonb;
  -- tarea vencida
  v_overdue_task boolean;
begin
  perform set_config('app.system', 'on', true);

  select * into d from doctors where id = p_id;
  if not found then return; end if;

  -- ---------- stats de casos ----------
  select count(*),
         count(*) filter (where is_new_case),
         min(fecha_ingreso)::date,
         max(fecha_ingreso)::date,
         max(fecha_ingreso) filter (where is_new_case)
  into v_case_count, v_new_count, v_first, v_last, v_last_new
  from cases where doctor_id = p_id and not is_demo;

  -- ---------- intervalo esperado ----------
  if v_new_count >= 3 then
    select greatest(14, least(365,
      percentile_cont(0.5) within group (order by gap_days)))
    into v_interval
    from (
      select extract(epoch from fecha_ingreso
               - lag(fecha_ingreso) over (order by fecha_ingreso)) / 86400.0 as gap_days,
             row_number() over (order by fecha_ingreso desc) as rn
      from cases where doctor_id = p_id and is_new_case and not is_demo
    ) g
    where gap_days is not null and rn <= 8;
    v_confidence := 'personal';
  elsif v_new_count >= 1 then
    select median_interval into v_interval
    from cohort_intervals where categoria = d.categoria;
    v_interval := coalesce(v_interval, 45);
    v_confidence := 'cohort';
  else
    v_interval := null;
    v_confidence := 'insuficiente';
  end if;

  if v_last_new is not null and v_interval is not null then
    v_overdue := (current_date - v_last_new) / v_interval;
  end if;

  -- ---------- último contacto (actividad o cualquier movimiento de caso) ----------
  select greatest(
    (select max(occurred_at) from activities where doctor_id = p_id),
    (select max(fecha_ingreso) from cases where doctor_id = p_id and not is_demo)
  ) into v_last_contact;
  if v_last_contact is not null then
    v_contact_days := extract(epoch from now() - v_last_contact) / 86400.0;
  end if;

  -- ---------- momentum 90d vs 90d previos ----------
  select count(*) filter (where fecha_ingreso > now() - interval '90 days'),
         count(*) filter (where fecha_ingreso <= now() - interval '90 days'
                            and fecha_ingreso > now() - interval '180 days')
  into v_recent90, v_prior90
  from cases where doctor_id = p_id and is_new_case and not is_demo;

  -- ---------- pipeline abierto ----------
  select count(*),
         max(case stage
           when 'paciente_potencial' then 1 when 'documentacion' then 2
           when 'caso_ingresado' then 3 when 'planificacion' then 4
           when 'presentada' then 5 when 'decision' then 6
           when 'compromiso' then 7 else 0 end),
         max(probability),
         coalesce(sum(amount_mxn), 0)
  into v_open_opps, v_max_stage_rank, v_max_prob, v_open_amount
  from opportunities
  where doctor_id = p_id and stage not in ('ganada','perdida');

  select coalesce(nullif(percentile_cont(0.9) within group (order by s.total), 0), 1)
  into v_p90_amount
  from (
    select sum(coalesce(amount_mxn, 0)) as total
    from opportunities where stage not in ('ganada','perdida')
    group by doctor_id
  ) s;

  select exists(
    select 1 from opportunities
    where doctor_id = p_id and stage = 'perdida'
      and closed_at > now() - interval '90 days'
  ) into v_lost90;
  select exists(
    select 1 from alerts
    where doctor_id = p_id and status = 'abierta' and severity = 'critica'
  ) into v_critical_alert;

  -- ---------- HEALTH ----------
  if v_overdue is not null then
    h_freq := 40 * greatest(0, least(1, 2 - v_overdue));
  end if;
  if v_contact_days is not null then
    h_contact := case
      when v_contact_days <= 14 then 20
      when v_contact_days >= 60 then 0
      else 20 * (1 - (v_contact_days - 14) / 46.0)
    end;
  end if;
  h_momentum := case
    when v_prior90 = 0 and v_recent90 > 0 then 20
    when v_prior90 = 0 then 0
    when v_recent90::numeric / v_prior90 >= 1 then 20
    when v_recent90::numeric / v_prior90 <= 0.5 then 0
    else 20 * ((v_recent90::numeric / v_prior90) - 0.5) / 0.5
  end;
  h_pipeline := case
    when v_max_stage_rank >= 2 then 10
    when v_open_opps > 0 then 5
    else 0 end;
  h_neg := 10 - (case when v_lost90 then 5 else 0 end)
              - (case when v_critical_alert then 5 else 0 end);

  if v_confidence = 'insuficiente' then
    -- sin historial de casos: escala solo contacto + pipeline + negativos (máx 40)
    v_health := round((h_contact + h_pipeline + h_neg) * 100.0 / 40);
  else
    v_health := round(h_freq + h_contact + h_momentum + h_pipeline + h_neg);
  end if;
  v_health := greatest(0, least(100, v_health));

  -- ---------- POTENTIAL ----------
  v_cat_pts := case d.categoria
    when 'ELITE' then 90 when 'BLACK' then 80 when 'PLATINUM' then 75
    when 'GOLD' then 65 when 'SILVER' then 45 else 35 end;
  select coalesce(max(cnt), 0) into v_capacity
  from (
    select count(*) as cnt
    from cases c1
    join cases c2 on c2.doctor_id = c1.doctor_id
      and c2.is_new_case and not c2.is_demo
      and c2.fecha_ingreso >= c1.fecha_ingreso
      and c2.fecha_ingreso < c1.fecha_ingreso + interval '90 days'
    where c1.doctor_id = p_id and c1.is_new_case and not c1.is_demo
    group by c1.id
  ) w;
  v_cap_pts := least(100, v_capacity * 100.0 / 6);
  v_lc_pts := case d.lifecycle_stage
    when 'growth' then 80 when 'activo' then 60
    when 'dormido' then 30 when 'perdido' then 10
    else 50 end;
  v_potential := round(0.4 * v_cat_pts + 0.4 * v_cap_pts + 0.2 * v_lc_pts);

  -- ---------- señales de PRIORITY (con razones en español) ----------
  if v_overdue is not null and d.lifecycle_stage not in ('perdido') then
    if v_overdue >= 1.75 then
      reasons := reasons || jsonb_build_object('code', 'caso_muy_atrasado',
        'text', format('Lleva %s días sin caso nuevo (su ritmo: cada %s días)',
          current_date - v_last_new, round(v_interval)), 'weight', 1.0);
    elsif v_overdue >= 1.25 then
      reasons := reasons || jsonb_build_object('code', 'caso_atrasado',
        'text', format('Lleva %s días sin caso nuevo (su ritmo: cada %s días)',
          current_date - v_last_new, round(v_interval)), 'weight', 0.6);
    end if;
  end if;

  if d.lifecycle_stage in ('acreditado','acreditado_no_activado','en_activacion')
     and v_new_count = 0
     and coalesce(d.accredited_at, d.created_at::date) < current_date - 30 then
    reasons := reasons || jsonb_build_object('code', 'acreditado_no_activado',
      'text', format('Acreditado hace %s días y nunca mandó un caso',
        current_date - coalesce(d.accredited_at, d.created_at::date)), 'weight', 0.9);
  end if;

  -- oportunidad estancada (días esperados por etapa desde params de la regla)
  select coalesce(params->'expected_days', '{}'::jsonb) into v_expected_days
  from automation_rules where key = 'oportunidad_estancada';
  select o.patient_name, o.stage,
         extract(epoch from now() - o.stage_entered_at) / 86400.0 as days_in,
         coalesce((v_expected_days->>o.stage::text)::numeric,
           case o.stage
             when 'paciente_potencial' then 14 when 'documentacion' then 7
             when 'caso_ingresado' then 7 when 'planificacion' then 7
             when 'presentada' then 5 when 'decision' then 4
             when 'compromiso' then 7 else 7 end) as expected
  into v_stalled
  from opportunities o
  where o.doctor_id = p_id and o.stage not in ('ganada','perdida')
    and extract(epoch from now() - o.stage_entered_at) / 86400.0 >
        1.5 * coalesce((v_expected_days->>o.stage::text)::numeric,
           case o.stage
             when 'paciente_potencial' then 14 when 'documentacion' then 7
             when 'caso_ingresado' then 7 when 'planificacion' then 7
             when 'presentada' then 5 when 'decision' then 4
             when 'compromiso' then 7 else 7 end)
  order by extract(epoch from now() - o.stage_entered_at) desc
  limit 1;
  v_stalled_found := found;
  if v_stalled_found then
    reasons := reasons || jsonb_build_object('code', 'oportunidad_estancada',
      'text', format('Oportunidad %s hace %s días en %s (esperado: %s)',
        coalesce('“' || v_stalled.patient_name || '”', 'abierta'),
        round(v_stalled.days_in), v_stalled.stage, round(v_stalled.expected)),
      'weight', 0.8);
  end if;

  -- oportunidad caliente sin seguimiento (presentada/decision sin actividad 5 días)
  if exists (
    select 1 from opportunities o
    where o.doctor_id = p_id and o.stage in ('presentada','decision')
      and not exists (
        select 1 from activities a
        where a.doctor_id = p_id and a.occurred_at > now() - interval '5 days')
  ) then
    reasons := reasons || jsonb_build_object('code', 'seguimiento_oportunidad',
      'text', 'Caso presentado al paciente, sin seguimiento en 5 días',
      'weight', 0.75);
  end if;

  select exists(
    select 1 from tasks
    where doctor_id = p_id and status = 'pendiente'
      and due_date < current_date
  ) into v_overdue_task;
  if v_overdue_task then
    reasons := reasons || jsonb_build_object('code', 'tarea_vencida',
      'text', 'Tiene una tarea vencida', 'weight', 0.7);
  end if;

  if d.lifecycle_stage in ('activo','growth')
     and v_contact_days is not null and v_contact_days > 30 then
    reasons := reasons || jsonb_build_object('code', 'sin_contacto',
      'text', format('Sin contacto hace %s días', round(v_contact_days)),
      'weight', 0.5);
  end if;

  if jsonb_array_length(reasons) = 0 and v_potential >= 70 and v_health >= 70
     and v_capacity > coalesce(v_recent90, 0) then
    reasons := reasons || jsonb_build_object('code', 'growth',
      'text', format('Techo demostrado de %s casos/90 días, lleva %s en los últimos 90',
        v_capacity, v_recent90), 'weight', 0.4);
  end if;

  -- ---------- PRIORITY ----------
  select r->>'code', (r->>'weight')::numeric
  into top_code, top_weight
  from jsonb_array_elements(reasons) r
  order by (r->>'weight')::numeric desc
  limit 1;
  v_urgency := coalesce(top_weight, 0);

  v_value := least(1, v_open_amount / v_p90_amount);
  v_prob := coalesce(v_max_prob, 0) / 100.0;
  if exists (
    select 1 from activities
    where doctor_id = p_id and occurred_at > now() - interval '3 days'
  ) then
    v_decay := 0.5;
  end if;
  v_priority := round(100 * v_decay *
    (0.35 * v_urgency + 0.25 * v_potential / 100.0 + 0.20 * v_value + 0.20 * v_prob));
  v_priority := greatest(0, least(100, v_priority));

  v_bucket := case top_code
    when 'caso_muy_atrasado' then 'critico'
    when 'acreditado_no_activado' then 'alto_impacto'
    when 'oportunidad_estancada' then 'seguimientos'
    when 'seguimiento_oportunidad' then 'oportunidades'
    when 'tarea_vencida' then 'seguimientos'
    when 'caso_atrasado' then 'riesgo'
    when 'sin_contacto' then 'riesgo'
    when 'growth' then 'growth'
    else null end;

  v_action := case top_code
    when 'caso_muy_atrasado' then jsonb_build_object('type','llamada','label','Llamar hoy: retomar el ritmo de casos')
    when 'caso_atrasado' then jsonb_build_object('type','whatsapp','label','WhatsApp: preguntar por próximos pacientes')
    when 'acreditado_no_activado' then jsonb_build_object('type','llamada','label','Llamar: activar su primer caso')
    when 'oportunidad_estancada' then jsonb_build_object('type','whatsapp','label','WhatsApp: destrabar la oportunidad')
    when 'seguimiento_oportunidad' then jsonb_build_object('type','whatsapp','label','WhatsApp: seguimiento post-presentación')
    when 'tarea_vencida' then jsonb_build_object('type','seguimiento','label','Resolver la tarea vencida')
    when 'sin_contacto' then jsonb_build_object('type','whatsapp','label','WhatsApp: retomar contacto')
    when 'growth' then jsonb_build_object('type','visita','label','Visita: proponerle crecer en volumen')
    else null end;

  -- ---------- escribir cache ----------
  update doctors set
    health_score = v_health,
    health_factors = jsonb_build_object(
      'frequency', jsonb_build_object('points', round(h_freq,1), 'overdue_ratio', round(coalesce(v_overdue,0),2), 'interval', round(coalesce(v_interval,0)), 'basis', v_confidence),
      'contact', jsonb_build_object('points', round(h_contact,1), 'days', round(coalesce(v_contact_days,0))),
      'momentum', jsonb_build_object('points', round(h_momentum,1), 'recent90', v_recent90, 'prior90', v_prior90),
      'pipeline', jsonb_build_object('points', h_pipeline, 'open', v_open_opps),
      'negative', jsonb_build_object('points', h_neg)
    ),
    health_confidence = v_confidence,
    potential_computed = v_potential,
    priority_score = v_priority,
    priority_reasons = reasons,
    priority_bucket = v_bucket,
    recommended_action = v_action,
    avg_interval_days = v_interval,
    expected_next_case_at = case
      when v_last_new is not null and v_interval is not null
      then v_last_new + v_interval::int else null end,
    case_count = v_case_count,
    new_case_count = v_new_count,
    first_case_at = v_first,
    last_case_at = v_last,
    last_new_case_at = v_last_new,
    last_contact_at = v_last_contact
  where id = p_id;
end $fn$;

create or replace function recompute_all() returns void
language plpgsql security definer set search_path = public as $fn$
declare r record;
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede recalcular los scores';
  end if;
  perform set_config('app.system', 'on', true);
  perform refresh_cohort_intervals();
  for r in select id from doctors loop
    perform recompute_doctor(r.id);
  end loop;
  insert into score_snapshots (doctor_id, snapshot_date, health, potential, priority)
  select id, current_date, health_score,
         coalesce(potential_override, potential_computed), priority_score
  from doctors
  on conflict (doctor_id, snapshot_date) do update
    set health = excluded.health,
        potential = excluded.potential,
        priority = excluded.priority;
end $fn$;

-- recompute liviano al vuelo cuando cambian datos del doctor
create or replace function recompute_doctor_trigger() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_doctor uuid;
begin
  if tg_op = 'DELETE' then
    v_doctor := old.doctor_id;
  else
    v_doctor := new.doctor_id;
  end if;
  if v_doctor is not null then
    perform recompute_doctor(v_doctor);
  end if;
  return null;
end $fn$;

create trigger cases_recompute_trg
  after insert or update on cases
  for each row execute function recompute_doctor_trigger();
create trigger activities_recompute_trg
  after insert or update or delete on activities
  for each row execute function recompute_doctor_trigger();
create trigger opportunities_recompute_trg
  after insert or update on opportunities
  for each row execute function recompute_doctor_trigger();
create trigger tasks_recompute_trg
  after insert or update on tasks
  for each row execute function recompute_doctor_trigger();
-- 0006: motor de automatizaciones V1 — evaluador horario + 8 reglas seed + purge_demo + cron
--
-- Diseño: una función evaluate_automations() que recorre automation_rules habilitadas.
-- Cada key es una rama hardcodeada parametrizada por params (el "no-code" V1 son los
-- umbrales editables en /ajustes). Idempotente: dedupe por NOT EXISTS de alerta abierta.

create or replace function evaluate_automations() returns void
language plpgsql security definer set search_path = public as $fn$
declare
  rule record;
  v_count int;
  stats jsonb := '{}'::jsonb;
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede ejecutar las automatizaciones';
  end if;
  perform set_config('app.system', 'on', true);
  perform set_config('app.source', 'automation', true);

  for rule in select * from automation_rules where enabled loop
    v_count := 0;

    -- ================================================================
    if rule.key = 'caso_atrasado' then
      with candidates as (
        select d.* from doctors d
        where d.lifecycle_stage in ('activo','growth')
          and d.health_confidence in ('personal','cohort')
          and d.avg_interval_days is not null and d.last_new_case_at is not null
          and (current_date - d.last_new_case_at) / d.avg_interval_days
              > coalesce((rule.params->>'threshold')::numeric, 1.25)
      ), ins_alerts as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select rule.key, c.id, 'alta',
          format('%s está atrasado con su próximo caso', c.nombre),
          format('Lleva %s días sin caso nuevo; su ritmo es cada %s días.',
            current_date - c.last_new_case_at, round(c.avg_interval_days)),
          c.is_demo
        from candidates c
        where not exists (select 1 from alerts a
          where a.rule_key = rule.key and a.doctor_id = c.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins_alerts;

      insert into tasks (doctor_id, type, title, due_date, assigned_to, created_by,
                         automation_rule_id, is_demo)
      select c.id, coalesce(rule.task_type, 'llamada'),
        format('Llamar a %s: retomar ritmo de casos', c.nombre),
        current_date, c.owner_id, null, rule.id, c.is_demo
      from doctors c
      where rule.creates_task
        and c.lifecycle_stage in ('activo','growth')
        and c.health_confidence in ('personal','cohort')
        and c.avg_interval_days is not null and c.last_new_case_at is not null
        and (current_date - c.last_new_case_at) / c.avg_interval_days
            > coalesce((rule.params->>'threshold')::numeric, 1.25)
        and not exists (select 1 from tasks t
          where t.doctor_id = c.id and t.status = 'pendiente'
            and t.automation_rule_id = rule.id);

    -- ================================================================
    elsif rule.key = 'sin_contacto' then
      insert into tasks (doctor_id, type, title, due_date, assigned_to,
                         automation_rule_id, is_demo)
      select d.id, coalesce(rule.task_type, 'whatsapp'),
        format('WhatsApp a %s: retomar contacto', d.nombre),
        current_date, d.owner_id, rule.id, d.is_demo
      from doctors d
      where d.lifecycle_stage in ('activo','growth')
        and d.last_contact_at < now() -
          (coalesce((rule.params->>'days')::int, 30) || ' days')::interval
        and not exists (select 1 from tasks t
          where t.doctor_id = d.id and t.status = 'pendiente'
            and t.automation_rule_id = rule.id);
      get diagnostics v_count = row_count;

    -- ================================================================
    elsif rule.key = 'oportunidad_estancada' then
      with expected as (
        select coalesce(rule.params->'expected_days', '{}'::jsonb) as ed
      ), stalled as (
        select o.*, d.nombre as doctor_nombre,
          extract(epoch from now() - o.stage_entered_at) / 86400.0 as days_in,
          coalesce(((select ed from expected)->>o.stage::text)::numeric,
            case o.stage
              when 'paciente_potencial' then 14 when 'documentacion' then 7
              when 'caso_ingresado' then 7 when 'planificacion' then 7
              when 'presentada' then 5 when 'decision' then 4
              when 'compromiso' then 7 else 7 end) as expected_days
        from opportunities o join doctors d on d.id = o.doctor_id
        where o.stage not in ('ganada','perdida')
      ), ins as (
        insert into alerts (rule_key, doctor_id, opportunity_id, severity, title, reason, is_demo)
        select rule.key, s.doctor_id, s.id, 'media',
          format('Oportunidad estancada: %s', coalesce(s.patient_name, s.doctor_nombre)),
          format('Lleva %s días en %s; lo esperado son %s días.',
            round(s.days_in), s.stage, round(s.expected_days)),
          s.is_demo
        from stalled s
        where s.days_in > coalesce((rule.params->>'multiplier')::numeric, 1.5) * s.expected_days
          and not exists (select 1 from alerts a
            where a.rule_key = rule.key and a.opportunity_id = s.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    elsif rule.key = 'acreditado_no_activado' then
      -- transición: acreditado viejo sin casos pasa a "no activado"
      update doctors d set lifecycle_stage = 'acreditado_no_activado'
      where d.lifecycle_stage = 'acreditado' and d.new_case_count = 0
        and coalesce(d.accredited_at, d.created_at::date)
            < current_date - coalesce((rule.params->>'days')::int, 30);

      with candidates as (
        select d.* from doctors d
        where d.lifecycle_stage in ('acreditado_no_activado','en_activacion')
          and d.new_case_count = 0
          and coalesce(d.accredited_at, d.created_at::date)
              < current_date - coalesce((rule.params->>'days')::int, 30)
      ), ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select rule.key, c.id, 'alta',
          format('%s: acreditado sin activar', c.nombre),
          format('Acreditado hace %s días y todavía no mandó su primer caso.',
            current_date - coalesce(c.accredited_at, c.created_at::date)),
          c.is_demo
        from candidates c
        where not exists (select 1 from alerts a
          where a.rule_key = rule.key and a.doctor_id = c.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins;

      insert into tasks (doctor_id, type, title, due_date, assigned_to,
                         automation_rule_id, is_demo)
      select c.id, coalesce(rule.task_type, 'llamada'),
        format('Llamar a %s: activar su primer caso', c.nombre),
        current_date, c.owner_id, rule.id, c.is_demo
      from doctors c
      where rule.creates_task
        and c.lifecycle_stage in ('acreditado_no_activado','en_activacion')
        and c.new_case_count = 0
        and coalesce(c.accredited_at, c.created_at::date)
            < current_date - coalesce((rule.params->>'days')::int, 30)
        and not exists (select 1 from tasks t
          where t.doctor_id = c.id and t.status = 'pendiente'
            and t.automation_rule_id = rule.id);

    -- ================================================================
    elsif rule.key = 'dormido_detectado' then
      with moved as (
        update doctors d set lifecycle_stage = 'dormido'
        where d.lifecycle_stage in ('activo','growth','en_riesgo')
          and d.avg_interval_days is not null and d.last_new_case_at is not null
          and (current_date - d.last_new_case_at) / d.avg_interval_days
              > coalesce((rule.params->>'threshold')::numeric, 2.0)
        returning d.*
      ), ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select rule.key, m.id, 'critica',
          format('%s se durmió', m.nombre),
          format('Superó el doble de su ritmo: %s días sin caso nuevo (ritmo: cada %s).',
            current_date - m.last_new_case_at, round(m.avg_interval_days)),
          m.is_demo
        from moved m
        where not exists (select 1 from alerts a
          where a.rule_key = rule.key and a.doctor_id = m.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    elsif rule.key = 'reactivacion' then
      with moved as (
        update doctors d set lifecycle_stage = 'activo'
        where d.lifecycle_stage in ('dormido','en_riesgo','perdido')
          and d.last_new_case_at > current_date - 7
        returning d.*
      ), closed as (
        -- al reactivarse, cierra la alerta de dormido
        update alerts a set status = 'resuelta', resolved_at = now()
        where a.doctor_id in (select id from moved)
          and a.rule_key in ('dormido_detectado','caso_atrasado')
          and a.status = 'abierta'
      ), ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select rule.key, m.id, 'info',
          format('🎉 %s se reactivó', m.nombre),
          'Volvió a mandar un caso después de estar dormido.',
          m.is_demo
        from moved m
        where not exists (select 1 from alerts a
          where a.rule_key = rule.key and a.doctor_id = m.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    elsif rule.key = 'tarea_vencida' then
      -- distinct on: una sola alerta por doctor por corrida (la tarea más vencida)
      with ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select distinct on (t.doctor_id)
          rule.key, t.doctor_id, 'media',
          format('Tarea vencida: %s', t.title),
          format('Vencida hace %s días. Asignada a %s.',
            current_date - t.due_date,
            coalesce((select nombre from profiles p where p.id = t.assigned_to), 'nadie')),
          t.is_demo
        from tasks t
        where t.status = 'pendiente' and t.doctor_id is not null
          and t.due_date < current_date - coalesce((rule.params->>'days')::int, 3)
          and not exists (select 1 from alerts a
            where a.rule_key = rule.key and a.doctor_id = t.doctor_id and a.status = 'abierta')
        order by t.doctor_id, t.due_date
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    elsif rule.key = 'aprobacion_pendiente' then
      -- distinct on: una sola alerta por doctor por corrida (el video más viejo)
      with ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select distinct on (c.doctor_id)
          rule.key, c.doctor_id, 'media',
          format('Video sin aprobar: caso %s', coalesce(c.id_externo, c.noloco_case_id)),
          format('El video está listo hace %s días y %s no lo aprobó (paciente %s).',
            extract(day from now() - c.fecha_video)::int, d.nombre, coalesce(c.paciente, '—')),
          c.is_demo
        from cases c join doctors d on d.id = c.doctor_id
        where c.fecha_video is not null and c.fecha_aprobacion_video is null
          and c.fecha_video < now() - (coalesce((rule.params->>'days')::int, 7) || ' days')::interval
          and c.fecha_video >= coalesce((rule.params->>'cutoff')::timestamptz, '2026-06-01'::timestamptz)
          and not exists (select 1 from alerts a
            where a.rule_key = rule.key and a.doctor_id = c.doctor_id and a.status = 'abierta')
        order by c.doctor_id, c.fecha_video
        returning 1
      )
      select count(*) into v_count from ins;
    end if;

    update automation_rules set last_run_at = now(),
      run_stats = jsonb_build_object('last_created', v_count)
      where id = rule.id;
    stats := stats || jsonb_build_object(rule.key, v_count);
  end loop;
end $fn$;

-- ---------- reglas seed ----------
insert into automation_rules (key, nombre, descripcion, enabled, params, creates_task, task_type) values
  ('caso_atrasado', 'Doctor atrasado con su próximo caso',
   'Activo que superó 1,25× su ritmo propio de casos. Alerta + tarea de llamada.',
   true, '{"threshold": 1.25}', true, 'llamada'),
  ('sin_contacto', 'Doctor activo sin contacto',
   'Activo sin ninguna interacción en 30 días. Crea tarea de WhatsApp al owner.',
   true, '{"days": 30}', true, 'whatsapp'),
  ('oportunidad_estancada', 'Oportunidad estancada',
   'Oportunidad que lleva más de 1,5× los días esperados en su etapa.',
   true, '{"multiplier": 1.5, "expected_days": {"paciente_potencial": 14, "documentacion": 7, "caso_ingresado": 7, "planificacion": 7, "presentada": 5, "decision": 4, "compromiso": 7}}', false, null),
  ('acreditado_no_activado', 'Acreditado sin activar',
   'Acreditado hace 30+ días sin su primer caso. Alerta + tarea de llamada.',
   true, '{"days": 30}', true, 'llamada'),
  ('dormido_detectado', 'Doctor dormido',
   'Superó 2× su ritmo propio: pasa a Dormido y alerta crítica.',
   true, '{"threshold": 2.0}', false, null),
  ('reactivacion', 'Reactivación 🎉',
   'Doctor dormido que volvió a mandar caso: pasa a Activo y cierra sus alertas.',
   true, '{}', false, null),
  ('tarea_vencida', 'Tarea vencida',
   'Tarea pendiente vencida hace 3+ días. Alerta para el manager.',
   true, '{"days": 3}', false, null),
  ('aprobacion_pendiente', 'Video sin aprobar',
   'Video de tratamiento listo hace 7+ días sin aprobación del doctor.',
   true, '{"days": 7, "cutoff": "2026-06-01"}', false, null)
on conflict (key) do nothing;

-- ---------- purga de datos demo ----------
create or replace function purge_demo() returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede borrar los datos demo';
  end if;
  perform set_config('app.system', 'on', true);
  delete from alerts where is_demo;
  delete from tasks where is_demo;
  delete from activities where is_demo;
  delete from payments where is_demo;
  delete from opportunities where is_demo;
  delete from cases where is_demo;
  delete from doctors where is_demo;
  perform recompute_all();
end $fn$;

-- ---------- permisos de ejecución de funciones (PostgREST expone todo por default) ----------
-- anon no ejecuta NINGUNA función del sistema; log_audit y las internas tampoco
-- las ejecuta authenticated (solo las llaman triggers/funciones definer como owner).
revoke execute on function purge_demo() from public, anon;
revoke execute on function recompute_all() from public, anon;
revoke execute on function evaluate_automations() from public, anon;
revoke execute on function recompute_doctor(uuid) from public, anon, authenticated;
revoke execute on function refresh_cohort_intervals() from public, anon, authenticated;
revoke execute on function log_audit(text, uuid, text, text, text) from public, anon, authenticated;
-- current_rol/is_manager/can_write/is_system quedan ejecutables por authenticated:
-- las evalúan las policies RLS con el rol del llamador.
revoke execute on function current_rol() from anon;
revoke execute on function is_manager() from anon;
revoke execute on function can_write() from anon;

-- ---------- pg_cron: nightly 05:00 México (11:00 UTC) + evaluador horario ----------
do $cron$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('crm-recompute-nightly', '0 11 * * *', 'select recompute_all()');
  perform cron.schedule('crm-automations-hourly', '10 * * * *', 'select evaluate_automations()');
exception when others then
  raise notice 'pg_cron no disponible (%). Programar recompute_all() y evaluate_automations() manualmente.', sqlerrm;
end $cron$;

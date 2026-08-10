-- 0017: capa AI multi-agente — ai_recommendations, doctor_ai_profile, agent_runs.
-- Diseño: docs/AI_ARCHITECTURE.md §7. Contratos TS: lib/ai/types.ts.
--
-- Principios:
--  * Los agentes NUNCA escriben tablas CRM; el runner escribe SOLO estas ai_*
--    via service-role (lib/ai/db.ts), con app.source='agent' para el audit.
--  * Los usuarios solo DECIDEN recomendaciones (status/decided_*/outcome...);
--    el resto de la fila es del sistema (guard trigger, estilo alerts_guard).
--  * doctor_ai_profile se actualiza SOLO por input humano o propuesta AI aceptada
--    (flujo server action → service-role); sin policies de escritura de cliente.
--  * Texto plano + CHECK (no enums nuevos), como priority_bucket en 0015.
--  * Idempotente: no hay ledger de migraciones.

-- ===========================================================================
-- ai_recommendations — feedback loop: cada recomendación con decisión y outcome
-- ===========================================================================
create table if not exists ai_recommendations (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid references doctors(id) on delete cascade, -- null = recomendación de director
  agent text not null check (agent in
    ('orchestrator','acquisition','accreditation','activation','clinical_education',
     'growth','retention_reactivation','doctor_success','commercial_director')),
  run_id uuid,                          -- agent_runs.id (sin FK: el run puede persistirse después)
  brain_version text not null,
  model_version text not null,
  recommendation_type text not null,    -- 'contacto' | 'revision_clinica' | 'tarea' | 'profile_update' | 'escalamiento' | ...
  objective text,
  situation text,
  recommended_action text not null,
  channel text check (channel in ('whatsapp','call','video','visit','clinical','task')),
  recommended_date date,
  why jsonb not null default '[]'::jsonb,       -- inferencias marcadas (string[])
  evidence jsonb not null default '[]'::jsonb,  -- FACTS [{field,value}]
  confidence int check (confidence between 0 and 100),
  commercial_priority int check (commercial_priority between 0 and 100),
  clinical_handoff boolean not null default false,
  handoff_agent text check (handoff_agent in
    ('orchestrator','acquisition','accreditation','activation','clinical_education',
     'growth','retention_reactivation','doctor_success','commercial_director')),
  suggested_message text,               -- draft es-MX; NUNCA se envía solo
  requires_user_confirmation boolean not null default true,
  payload jsonb,                        -- draft ejecutable: {kind: task|activity|profile_update|none}
  status text not null default 'propuesta' check (status in
    ('propuesta','aceptada','descartada','ejecutada','expirada')),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  dismiss_reason text,                  -- insumo directo de la blacklist (contrato P34)
  action_completed boolean not null default false,
  executed_ref jsonb,                   -- ref a lo ejecutado (p.ej. {task_id})
  outcome text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

comment on table ai_recommendations is
  'Recomendaciones emitidas por los agentes AI (HITL: la AI propone, el usuario decide). Cada fila guarda evidencia, decisión, motivo de descarte y outcome — es el feedback loop y la base de la blacklist futura.';

-- dedupe estilo alerts: una propuesta abierta por doctor+agente+tipo;
-- las de director (doctor_id null) deduplican por agente+tipo.
create unique index if not exists ai_recommendations_dedupe_idx
  on ai_recommendations (doctor_id, agent, recommendation_type)
  where status = 'propuesta' and doctor_id is not null;
create unique index if not exists ai_recommendations_dedupe_global_idx
  on ai_recommendations (agent, recommendation_type)
  where status = 'propuesta' and doctor_id is null;

create index if not exists ai_recommendations_doctor_idx
  on ai_recommendations (doctor_id, created_at desc);
create index if not exists ai_recommendations_open_idx
  on ai_recommendations (created_at desc) where status = 'propuesta';

-- ===========================================================================
-- doctor_ai_profile — memoria cualitativa controlada (1:1 doctors)
-- ===========================================================================
create table if not exists doctor_ai_profile (
  doctor_id uuid primary key references doctors(id) on delete cascade,
  experience_with_aligners text,
  clinical_confidence text not null default 'desconocida'
    check (clinical_confidence in ('alta','media','baja','desconocida')),
  main_concerns text,
  preferred_contact_style text,
  business_goals text,
  growth_ambition text,
  known_objections text,
  competitor_relationship text,
  previous_bad_experiences text,
  relationship_notes text,
  team_readiness text,
  patient_acquisition_problem text,
  education_needs text,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  last_source text not null default 'humano'
    check (last_source in ('humano','ai_confirmado'))
);

comment on table doctor_ai_profile is
  'Perfil cualitativo del doctor para los agentes AI (memoria controlada, 1:1 con doctors). Se actualiza SOLO por input humano o por propuesta AI aceptada (recommendation_type=profile_update) — nunca por inferencia directa del modelo.';

-- ===========================================================================
-- agent_runs — observabilidad: "¿por qué recomendó llamar a este doctor?"
-- ===========================================================================
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent text not null check (agent in
    ('orchestrator','acquisition','accreditation','activation','clinical_education',
     'growth','retention_reactivation','doctor_success','commercial_director')),
  doctor_id uuid references doctors(id) on delete set null, -- set null: la corrida es historial
  "trigger" text not null check ("trigger" in ('doctor360','hoy','ask','manual')),
  requested_by uuid references profiles(id),
  model_version text not null,
  brain_version text not null,
  status text not null check (status in ('ok','error','refusal')),
  error text,
  latency_ms int,
  input_tokens int,
  output_tokens int,
  tools_called jsonb not null default '[]'::jsonb, -- [{name,args,ms,rows}]
  records_used jsonb,
  recommendation_ids uuid[] not null default '{}',
  result jsonb,                        -- assessment/brief emitido, para re-mostrar en UI
  created_at timestamptz not null default now()
);

comment on table agent_runs is
  'Auditoría de cada corrida de agente AI: modelo, brain version, tools llamadas, tokens, latencia y recomendaciones emitidas. Solo escribe el runner (service-role).';

create index if not exists agent_runs_created_idx on agent_runs (created_at desc);
create index if not exists agent_runs_doctor_idx on agent_runs (doctor_id, created_at desc);

-- ===========================================================================
-- RLS — lectura para todos los autenticados; escritura solo del sistema,
-- salvo la DECISIÓN de recomendaciones (update gateado por guard trigger)
-- ===========================================================================
alter table ai_recommendations enable row level security;
alter table doctor_ai_profile enable row level security;
alter table agent_runs enable row level security;

drop policy if exists ai_recommendations_select on ai_recommendations;
create policy ai_recommendations_select on ai_recommendations
  for select to authenticated using (true);

drop policy if exists doctor_ai_profile_select on doctor_ai_profile;
create policy doctor_ai_profile_select on doctor_ai_profile
  for select to authenticated using (true);

drop policy if exists agent_runs_select on agent_runs;
create policy agent_runs_select on agent_runs
  for select to authenticated using (true);

-- ai_recommendations: los usuarios (no VIEWER) deciden — el guard limita columnas.
-- Sin policy de INSERT/DELETE: solo el runner (service-role) crea; nadie borra.
drop policy if exists ai_recommendations_update on ai_recommendations;
create policy ai_recommendations_update on ai_recommendations
  for update to authenticated using (can_write()) with check (can_write());

-- guard: desde el cliente solo se tocan los campos de decisión
-- (status, decided_by, decided_at, dismiss_reason, action_completed,
--  executed_ref, outcome, resolved_at); el resto lo escribe el sistema.
create or replace function ai_recommendations_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then return new; end if;
  if new.id                         is distinct from old.id
  or new.doctor_id                  is distinct from old.doctor_id
  or new.agent                      is distinct from old.agent
  or new.run_id                     is distinct from old.run_id
  or new.brain_version              is distinct from old.brain_version
  or new.model_version              is distinct from old.model_version
  or new.recommendation_type        is distinct from old.recommendation_type
  or new.objective                  is distinct from old.objective
  or new.situation                  is distinct from old.situation
  or new.recommended_action         is distinct from old.recommended_action
  or new.channel                    is distinct from old.channel
  or new.recommended_date           is distinct from old.recommended_date
  or new.why                        is distinct from old.why
  or new.evidence                   is distinct from old.evidence
  or new.confidence                 is distinct from old.confidence
  or new.commercial_priority        is distinct from old.commercial_priority
  or new.clinical_handoff           is distinct from old.clinical_handoff
  or new.handoff_agent              is distinct from old.handoff_agent
  or new.suggested_message          is distinct from old.suggested_message
  or new.requires_user_confirmation is distinct from old.requires_user_confirmation
  or new.payload                    is distinct from old.payload
  or new.created_at                 is distinct from old.created_at
  then
    raise exception 'Las recomendaciones AI solo se deciden desde la app (aceptar/descartar/outcome)';
  end if;
  return new;
end $$;

drop trigger if exists ai_recommendations_guard_trg on ai_recommendations;
create trigger ai_recommendations_guard_trg
  before update on ai_recommendations
  for each row execute function ai_recommendations_guard();

-- doctor_ai_profile y agent_runs: SIN policies de escritura de cliente —
-- solo service-role (runner / flujo de confirmación humana) escribe.

-- updated_at en doctor_ai_profile (reusa set_updated_at si existe)
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists doctor_ai_profile_updated_at on doctor_ai_profile;
    create trigger doctor_ai_profile_updated_at
      before update on doctor_ai_profile
      for each row execute function set_updated_at();
  end if;
end $$;

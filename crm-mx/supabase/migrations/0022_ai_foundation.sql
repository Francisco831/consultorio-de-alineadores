-- 0022: AI Foundation Hardening — correctitud antes que inteligencia.
--
-- Problema que resuelve: los agentes razonaban bien sobre datos mal modelados.
-- El caso testigo es la activación. El journey real de México es
--   ACREDITADO -> CASO PROPIO -> PRIMER CASO DE PACIENTE -> REPETICIÓN
-- y el CRM no distinguía el caso propio del doctor (el tratamiento que se hace
-- él mismo para ganar confianza en la técnica) de su primer caso de paciente.
-- Asumir que "cualquier caso después de acreditarse = primer paciente" inventa
-- un hito comercial que puede no haber ocurrido.
--
-- Regla de esta migración: NUNCA inferir. Todo lo histórico queda 'UNKNOWN' y
-- se clasifica con revisión humana. Un dato desconocido vale más que uno
-- inventado.
--
-- Idempotente (no hay ledger de migraciones): if not exists / or replace.

-- ---------------------------------------------------------------------------
-- 1. Sujeto del caso: ¿de quién es este tratamiento?
-- ---------------------------------------------------------------------------

alter table cases
  add column if not exists case_subject_type text not null default 'UNKNOWN',
  add column if not exists case_subject_source text,
  add column if not exists case_subject_set_by uuid references profiles(id),
  add column if not exists case_subject_set_at timestamptz;

do $$ begin
  alter table cases add constraint cases_subject_type_check
    check (case_subject_type in ('PATIENT', 'DOCTOR_SELF', 'OTHER', 'UNKNOWN'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table cases add constraint cases_subject_source_check
    check (case_subject_source is null
           or case_subject_source in ('humano', 'ai_confirmado', 'import'));
exception when duplicate_object then null; end $$;

comment on column cases.case_subject_type is
  'PATIENT | DOCTOR_SELF (el caso propio del doctor) | OTHER | UNKNOWN. Los '
  'históricos quedan UNKNOWN: no se infiere. Solo se cambia con confirmación humana.';

create index if not exists cases_subject_type_idx
  on cases (doctor_id, case_subject_type);

-- Casos candidatos a ser propios, para la herramienta de clasificación: el
-- nombre del paciente se parece al del doctor. NO clasifica: solo prioriza la
-- cola de revisión humana (pg_trgm ya está instalado).
create or replace function case_self_similarity(p_case_id uuid)
returns real language sql stable security definer set search_path = public as $$
  select greatest(
           similarity(coalesce(c.paciente, ''), coalesce(d.nombre, '')),
           similarity(coalesce(c.paciente, ''), coalesce(d.clinic_name, ''))
         )
  from cases c join doctors d on d.id = c.doctor_id
  where c.id = p_case_id
$$;

-- ---------------------------------------------------------------------------
-- 2. Calidad del contacto: un WhatsApp corto no es una conversación real
-- ---------------------------------------------------------------------------
-- La regla del corpus distingue el toque (saludo, recordatorio, invitación
-- masiva) de la interacción sustantiva (caso, objeción, propuesta, estrategia,
-- capacitación, problema, próxima acción). El tipo de actividad NO alcanza para
-- decidirlo: una llamada puede ser un "te llamo la semana que viene" y un
-- WhatsApp puede ser la discusión de un caso completo.

alter table activities
  add column if not exists engagement_quality text not null default 'UNKNOWN',
  add column if not exists engagement_source text,
  add column if not exists engagement_set_by uuid references profiles(id),
  add column if not exists engagement_set_at timestamptz,
  add column if not exists main_topic text,
  add column if not exists next_action text;

do $$ begin
  alter table activities add constraint activities_engagement_quality_check
    check (engagement_quality in ('MEANINGFUL', 'LOW_TOUCH', 'UNKNOWN'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table activities add constraint activities_engagement_source_check
    check (engagement_source is null
           or engagement_source in ('humano', 'ai_confirmado', 'import', 'regla'));
exception when duplicate_object then null; end $$;

comment on column activities.engagement_quality is
  'MEANINGFUL | LOW_TOUCH | UNKNOWN. Las 4.257 notas importadas quedan UNKNOWN: '
  'sin cuerpo del mensaje no se puede saber si hubo conversación real.';

create index if not exists activities_engagement_idx
  on activities (doctor_id, engagement_quality, occurred_at desc);

-- Las actividades que el equipo registra de acá en adelante con tipo de alto
-- contacto arrancan como MEANINGFUL; el resto queda UNKNOWN salvo que alguien
-- las clasifique. Solo aplica a filas nuevas — no reescribe el histórico.
create or replace function activities_default_engagement() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.engagement_quality is null or new.engagement_quality = 'UNKNOWN' then
    if new.type in ('reunion', 'visita', 'revision_clinica', 'keepday') then
      new.engagement_quality = 'MEANINGFUL';
      new.engagement_source = coalesce(new.engagement_source, 'regla');
    end if;
    -- llamada/whatsapp/email/nota quedan UNKNOWN a propósito: el tipo no dice
    -- si la conversación fue sustantiva.
  end if;
  return new;
end $$;

drop trigger if exists activities_engagement_trg on activities;
create trigger activities_engagement_trg
  before insert on activities
  for each row execute function activities_default_engagement();

-- ---------------------------------------------------------------------------
-- 3. Impacto de servicio: no toda alerta secuestra el routing
-- ---------------------------------------------------------------------------
-- "¿Hay una alerta?" es la pregunta equivocada. La correcta es "¿esto puede
-- dañar de verdad la confianza del doctor?". Estas columnas son nullable: si
-- nadie las cargó, la capa AI las deriva de la regla y del atraso real, y lo
-- declara como estimación.

alter table alerts
  add column if not exists service_confidence text,
  add column if not exists trust_risk_score int,
  add column if not exists impact_factors jsonb not null default '[]'::jsonb;

do $$ begin
  alter table alerts add constraint alerts_service_confidence_check
    check (service_confidence is null
           or service_confidence in ('CONFIRMED', 'LIKELY', 'POSSIBLE'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table alerts add constraint alerts_trust_risk_check
    check (trust_risk_score is null or (trust_risk_score between 0 and 100));
exception when duplicate_object then null; end $$;

comment on column alerts.impact_factors is
  'Factores que justifican el riesgo de confianza: dias_atraso, sla_incumplido, '
  'queja_registrada, problema_repetido, caso_bloqueado, pedido_sin_responder, '
  'paciente_afectado, problema_administrativo, problema_clinico.';

-- El guard de alerts limita qué columnas puede tocar un cliente: sumar las
-- nuevas para que la revisión humana pueda calificar el impacto.
create or replace function alerts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then return new; end if;
  if new.doctor_id is distinct from old.doctor_id
     or new.opportunity_id is distinct from old.opportunity_id
     or new.rule_key is distinct from old.rule_key
     or new.title is distinct from old.title
     or new.reason is distinct from old.reason
     or new.severity is distinct from old.severity
     or new.created_at is distinct from old.created_at then
    raise exception 'Solo se pueden actualizar estado e impacto de la alerta';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Viabilidad como evento real (extiende la oportunidad, que ya la modela)
-- ---------------------------------------------------------------------------
-- 'viabilidad' ya es la primera etapa de opp_stage (0010/0011). Le faltaba el
-- ciclo: cuándo se pidió, cuándo se mandó, qué respondió el equipo clínico y
-- cuándo hay que volver. La IA nunca determina si un caso es viable: propone
-- pedir la viabilidad y registra el evento.

alter table opportunities
  add column if not exists viability_requested_at timestamptz,
  add column if not exists viability_submitted_at timestamptz,
  add column if not exists viability_status text,
  add column if not exists viability_result text,
  add column if not exists viability_completed_at timestamptz,
  add column if not exists viability_clinical_owner uuid references profiles(id),
  add column if not exists viability_follow_up_date date;

do $$ begin
  alter table opportunities add constraint opportunities_viability_status_check
    check (viability_status is null
           or viability_status in ('solicitada', 'enviada', 'respondida', 'sin_respuesta'));
exception when duplicate_object then null; end $$;

comment on column opportunities.viability_result is
  'Respuesta del equipo clínico tal cual (ej: "Medium", "Medium y adicional", '
  '"no viable"). Texto libre: hoy vive en el grupo de WhatsApp Viabilidades Mexico.';

create index if not exists opportunities_viability_pendiente_idx
  on opportunities (viability_follow_up_date)
  where viability_status in ('solicitada', 'enviada');

-- ---------------------------------------------------------------------------
-- 5. Ofertas comerciales configurables (nada de descuentos hardcodeados)
-- ---------------------------------------------------------------------------
-- Precios, descuentos y campañas cambian. Si no hay oferta vigente configurada,
-- el agente NO inventa: dice que no hay condición comercial vigente.
-- Se crea VACÍA a propósito — el 50/50 vs 20/15/10 de México está sin resolver.

create table if not exists commercial_offers (
  id uuid primary key default gen_random_uuid(),
  market text not null default 'MX',
  name text not null,
  offer_type text not null,
  lifecycle_stage text,
  percentage numeric(5,2),
  valid_from date,
  valid_to date,
  conditions text,
  requires_approval boolean not null default true,
  active boolean not null default false,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table commercial_offers add constraint commercial_offers_pct_check
    check (percentage is null or (percentage >= 0 and percentage <= 100));
exception when duplicate_object then null; end $$;

comment on table commercial_offers is
  'Condiciones comerciales vigentes por mercado y etapa. La capa AI consulta '
  'acá antes de mencionar cualquier incentivo. Sin fila activa no hay oferta: '
  'el agente responde "no hay una condición comercial vigente configurada".';

alter table commercial_offers enable row level security;

drop policy if exists commercial_offers_select on commercial_offers;
create policy commercial_offers_select on commercial_offers
  for select to authenticated using (true);

drop policy if exists commercial_offers_write on commercial_offers;
create policy commercial_offers_write on commercial_offers
  for all to authenticated using (is_manager()) with check (is_manager());

drop trigger if exists commercial_offers_updated_at on commercial_offers;
create trigger commercial_offers_updated_at
  before update on commercial_offers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Trazabilidad del routing (auditar por qué intervino cada agente)
-- ---------------------------------------------------------------------------

alter table agent_runs
  add column if not exists primary_agent text,
  add column if not exists supporting_agents text[] not null default '{}',
  add column if not exists routing_reason text,
  add column if not exists routing_evidence jsonb not null default '[]'::jsonb,
  add column if not exists data_quality jsonb;

comment on column agent_runs.routing_evidence is
  'Hechos que dispararon el ruteo: campo, valor y de dónde salió. Permite '
  'auditar despues si las reglas hacen lo que creemos.';

-- La confianza de una recomendación no puede depender solo del modelo: si los
-- datos del doctor son pobres, la confianza global no puede ser alta.
alter table ai_recommendations
  add column if not exists reasoning_confidence int,
  add column if not exists data_confidence int,
  add column if not exists supporting_agents text[] not null default '{}';

do $$ begin
  alter table ai_recommendations add constraint ai_rec_reasoning_conf_check
    check (reasoning_confidence is null or (reasoning_confidence between 0 and 100));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table ai_recommendations add constraint ai_rec_data_conf_check
    check (data_confidence is null or (data_confidence between 0 and 100));
exception when duplicate_object then null; end $$;

comment on column ai_recommendations.confidence is
  'Confianza GLOBAL = min(reasoning_confidence, data_confidence). Nunca puede '
  'ser alta si los datos que la sostienen son pobres.';

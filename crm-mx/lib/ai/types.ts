// Contratos compartidos de la capa multi-agente.
// Referencia de diseño: docs/AI_ARCHITECTURE.md

import type {
  AcqStage,
  ActStage,
  Alert,
  Case,
  DoctorCategoria,
  LifecycleStage,
  Opportunity,
  PriorityBucket,
  PriorityReason,
  Task,
  TaskType,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Agentes
// ---------------------------------------------------------------------------

export type AgentKey =
  | "orchestrator"
  | "acquisition"
  | "accreditation"
  | "activation"
  | "clinical_education"
  | "growth"
  | "retention_reactivation"
  | "doctor_success"
  | "commercial_director";

// Labels cortos para chips de UI (es-MX)
export const AGENT_LABELS: Record<AgentKey, string> = {
  orchestrator: "ORQUESTADOR",
  acquisition: "ADQUISICIÓN",
  accreditation: "ACREDITACIÓN",
  activation: "ACTIVACIÓN",
  clinical_education: "CLÍNICA",
  growth: "GROWTH",
  retention_reactivation: "RETENCIÓN",
  doctor_success: "SERVICIO",
  commercial_director: "DIRECCIÓN",
};

export type RecommendationChannel =
  | "whatsapp"
  | "call"
  | "video"
  | "visit"
  | "clinical"
  | "task";

// ---------------------------------------------------------------------------
// Vocabulario de especialista (Fase 3)
// ---------------------------------------------------------------------------

/** Quién EJECUTA la acción. El agente no le asigna todo al comercial: una duda
 *  clínica es del equipo clínico y un caso trabado es de operaciones. */
export type OwnerRole =
  | "SALES"
  | "CLINICAL"
  | "COUNTRY_MANAGER"
  | "OPERATIONS"
  | "ADMIN"
  | "MARKETING";

export const OWNER_ROLE_LABELS: Record<OwnerRole, string> = {
  SALES: "comercial",
  CLINICAL: "equipo clínico",
  COUNTRY_MANAGER: "dirección de país",
  OPERATIONS: "operaciones",
  ADMIN: "administración",
  MARKETING: "marketing",
};

/**
 * Qué impide que este doctor pase al siguiente estado sano. Es la unidad de
 * razonamiento de toda la capa: el ruteo lo calcula, el agente lo ataca y el
 * director lo agrega para ver dónde está trabada la máquina comercial.
 *
 * Cubre los bloqueos de activación, las causas de brecha de crecimiento y las
 * causas de churn en un solo vocabulario, para poder contarlos juntos.
 */
export type Bottleneck =
  | "DATOS_INSUFICIENTES"
  | "SIN_DUENO"
  | "SERVICIO"
  | "INCERTIDUMBRE_CLINICA"
  | "SIN_RELACION"
  | "SIN_ACREDITACION"
  | "SIN_CASO_PROPIO"
  | "SIN_PRIMER_PACIENTE"
  | "SIN_SEGUNDO_CASO"
  | "SIN_PACIENTES"
  | "CONVERSION_PACIENTE"
  | "DOCUMENTACION"
  | "PRECIO"
  | "EQUIPO"
  | "SIN_SEGUIMIENTO"
  | "TIEMPO"
  | "CADENCIA_CAIDA"
  | "BRECHA_CRECIMIENTO"
  | "COMPETENCIA"
  | "NINGUNO"
  | "DESCONOCIDO";

export const BOTTLENECK_LABELS: Record<Bottleneck, string> = {
  DATOS_INSUFICIENTES: "no sabemos lo suficiente para decidir",
  SIN_DUENO: "la cuenta no tiene responsable asignado",
  SERVICIO: "hay un problema de servicio sin resolver",
  INCERTIDUMBRE_CLINICA: "el doctor no está seguro con la técnica o con un caso",
  SIN_RELACION: "todavía no hay una conversación significativa",
  SIN_ACREDITACION: "no entró al sistema KeepSmiling",
  SIN_CASO_PROPIO: "no vivió el tratamiento en carne propia",
  SIN_PRIMER_PACIENTE: "no llevó el sistema a un paciente real",
  SIN_SEGUNDO_CASO: "hizo el primero y no repitió",
  SIN_PACIENTES: "no tiene pacientes candidatos",
  CONVERSION_PACIENTE: "tiene candidatos pero no los cierra",
  DOCUMENTACION: "se traba en documentación o escaneo",
  PRECIO: "el precio es el freno declarado",
  EQUIPO: "su equipo del consultorio no acompaña",
  SIN_SEGUIMIENTO: "quedó sin seguimiento de nuestro lado",
  TIEMPO: "quiere avanzar pero no le da la agenda",
  CADENCIA_CAIDA: "cayó su propio ritmo de casos",
  BRECHA_CRECIMIENTO: "hace bastante menos de lo que podría",
  COMPETENCIA: "resolvió con otra marca o con brackets",
  NINGUNO: "no hay un bloqueo identificable hoy",
  DESCONOCIDO: "hay un freno pero los datos no dicen cuál",
};

/** Motivo de descarte (taxonomía §48) — insumo de la lista negra y del
 *  aprendizaje. Es un enum y no texto libre para poder contarlo. */
export type DismissCode =
  | "ya_hecho"
  | "momento_equivocado"
  | "interpretacion_equivocada"
  | "doctor_pidio_no_contacto"
  | "existe_mejor_accion"
  | "dato_malo"
  | "no_apropiado_comercialmente"
  | "otro";

export const DISMISS_CODE_LABELS: Record<DismissCode, string> = {
  ya_hecho: "Ya está hecho",
  momento_equivocado: "Momento equivocado",
  interpretacion_equivocada: "Interpretación equivocada",
  doctor_pidio_no_contacto: "El doctor pidió que no lo contactemos",
  existe_mejor_accion: "Hay una acción mejor",
  dato_malo: "El dato está mal",
  no_apropiado_comercialmente: "No corresponde comercialmente",
  otro: "Otro",
};

export type RecommendationStatus =
  | "propuesta"
  | "aceptada"
  | "descartada"
  | "ejecutada"
  | "expirada";

export type AgentRunTrigger = "doctor360" | "hoy" | "ask" | "manual";

// ---------------------------------------------------------------------------
// Vocabulario de hitos y calidad de dato (migración 0022)
// ---------------------------------------------------------------------------

/** Estado de un hito del journey. UNKNOWN = los datos NO alcanzan para decidir
 *  (típicamente porque los casos del doctor siguen con case_subject_type
 *  'UNKNOWN'). UNKNOWN nunca se resuelve por inferencia. */
export type MilestoneStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "UNKNOWN";

/** El 2º caso de paciente es un hito binario: ocurrió o no (o no se sabe). */
export type SecondCaseStatus = "NOT_STARTED" | "COMPLETED" | "UNKNOWN";

/** De dónde salió la fecha de pago del primer caso de paciente.
 *  'ledger_caso'  = fila de payments atada a ese case_id (la mejor evidencia).
 *  'ledger_doctor'= primer pago del doctor en el ledger, SIN atar a un caso
 *                   (hoy payments.case_id está vacío en las 1.046 filas).
 *  'doctors.first_paid_case_at' = campo derivado, último recurso. */
export type PaidCaseSource = "ledger_caso" | "ledger_doctor" | "doctors.first_paid_case_at";

/** Qué tan confiable es el reloj de contacto significativo de este doctor.
 *  POOR ⇒ NO se puede afirmar "hace N días que nadie lo contacta". */
export type InteractionDataQuality = "GOOD" | "PARTIAL" | "POOR";

export type ServiceSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL";

/** CONFIRMED solo puede venir de revisión humana (alerts.service_confidence).
 *  Lo derivado nunca es CONFIRMED. */
export type ServiceConfidence = "CONFIRMED" | "LIKELY" | "POSSIBLE";

// ---------------------------------------------------------------------------
// DoctorContext (Context Engine)
// ---------------------------------------------------------------------------

export interface DoctorContext {
  doctor_id: string;
  name: string;
  city: string | null;
  zona: string | null;
  clinic: string | null;
  phone: string | null;
  whatsapp: string | null;
  owner: string | null; // nombre del comercial (profiles.nombre)
  clinical_owner: string | null;
  categoria: DoctorCategoria;
  lifecycle: LifecycleStage;
  is_accredited: boolean;
  acquisition_stage: AcqStage | null;
  activation_stage: ActStage | null;
  accreditation_status: string; // derivado legible: "no acreditado" | "interesado" | "agendada" | "acreditado"
  accreditation_date: string | null;
  days_since_accreditation: number | null;
  // ---- cadena de hitos MX: ACREDITADO → CASO PROPIO → 1er CASO DE PACIENTE → 2º ----
  // Se derivan de cases.case_subject_type (0022). Un caso cuenta como propio SOLO
  // con 'DOCTOR_SELF' y como de paciente SOLO con 'PATIENT'. Si el doctor tiene
  // casos sin clasificar, el hito es UNKNOWN — nunca COMPLETED.
  own_case_status: MilestoneStatus;
  own_case_id: string | null;
  own_case_started_at: string | null;
  own_case_completed_at: string | null;
  first_patient_case_status: MilestoneStatus;
  first_patient_case_id: string | null;
  first_patient_case_started_at: string | null;
  first_patient_case_paid_at: string | null;
  first_patient_case_paid_source: PaidCaseSource | null;
  /** @deprecated Espejo de first_patient_case_started_at (o del pago si no hay
   *  fecha de ingreso). Se mantiene para no romper consumidores previos. */
  first_patient_case_date: string | null;
  second_patient_case_status: SecondCaseStatus;
  second_patient_case_date: string | null;
  // Distancias entre INICIOS de hito (fecha_ingreso del caso). null si alguna punta
  // es desconocida — nunca se estima.
  days_accreditation_to_own_case: number | null;
  days_own_case_to_first_patient: number | null;
  days_first_to_second_patient: number | null;
  /** Casos del doctor todavía con case_subject_type='UNKNOWN' (cola de revisión). */
  cases_unclassified: number;
  /** Ledger de pagos (verdad del KPI): cuántos y el primero. */
  payments_count: number;
  first_payment_at: string | null;
  cases_total: number;
  cases_30d: number;
  cases_90d: number;
  historical_case_frequency: {
    avg_interval_days: number | null;
    expected_next_case_at: string | null;
    confidence: "personal" | "cohort" | "insuficiente";
  };
  days_since_last_case: number | null;
  open_cases: number;
  stalled_cases: StalledCase[];
  open_opportunities: OpportunitySummary[];
  /** ISO de la última activity con engagement_quality='MEANINGFUL' (0022).
   *  Ya NO se deriva del tipo de actividad: el tipo no dice si hubo conversación
   *  real. Si interaction_data_quality es POOR, este null NO significa "no lo
   *  contactaron": significa que no se sabe. */
  last_meaningful_contact: string | null;
  days_since_meaningful_contact: number | null;
  interaction_data_quality: InteractionDataQuality;
  engagement_unknown_count: number;
  engagement_classified_count: number;
  last_touch: string | null; // cualquier activity (incluye whatsapp/email/nota)
  next_action: { type: TaskType; label: string } | null; // doctors.recommended_action (motor determinístico)
  priority: {
    score: number | null;
    bucket: PriorityBucket | null;
    reasons: PriorityReason[];
  };
  health: { score: number | null; confidence: string | null };
  potential_score: number | null;
  tasks: TaskSummary[]; // pendientes reales (creadas por humanos o con due date próximo)
  competitors: string[];
  aligner_experience: string | null; // de doctor_ai_profile
  clinical_confidence: "alta" | "media" | "baja" | "desconocida";
  main_objection: string | null;
  lead_source: string | null;
  notes_summary: string | null; // últimas notas relevantes condensadas
  relationship_summary: string | null; // de doctor_ai_profile.relationship_notes
  recent_activity: ActivitySummary[]; // últimas ~15
  training_history: string[]; // activities keepday/revision_clinica + cursos si hay
  keepday_history: string[];
  kos_status: string | null;
  campaign_history: string[];
  known_commitments: string[]; // tasks/notas con compromisos
  service_issues: ServiceIssue[];
  /** Máximo trust_risk_score de service_issues. null = no hay problemas
   *  detectados (que no es lo mismo que "no hay problemas"). */
  trust_risk_score: number | null;
  service_summary: string; // una línea es-MX
  wa_channel: { chat_name: string; unanswered: boolean; activity_bucket: string | null } | null;
  ai_profile: DoctorAiProfileRow | null;
  open_recommendations: AiRecommendationRow[];
  data_as_of: string; // watermark de sync_runs — frescura de datos
}

export interface StalledCase {
  case_id: string;
  label: string; // id_externo ?? noloco_case_id
  etapa: string | null;
  issue: string; // p.ej. "video sin aprobar hace 12 días"
  days_stalled: number;
}

export interface ServiceIssue {
  kind: "alerta" | "caso_estancado";
  detail: string;
  since: string | null;
  /** Impacto real del problema, NO "existe una alerta". Se toma de la alerta si
   *  un humano la calificó; si no, se deriva y la confianza lo declara. */
  severity: ServiceSeverity;
  confidence: ServiceConfidence;
  trust_risk_score: number; // 0-100
  impact_factors: string[]; // vocabulario de alerts.impact_factors
  /** 'alerta_revisada' = valores cargados por una persona; 'derivado' = estimado. */
  source: "alerta_revisada" | "derivado";
  /** Severidad cruda de la alerta del motor (critica|alta|media|info), si vino de una. */
  alert_severity: string | null;
  rule_key: string | null;
}

export interface OpportunitySummary {
  id: string;
  patient_name: string | null;
  stage: string;
  days_in_stage: number;
  probability: number | null;
  amount_mxn: number | null;
}

export interface TaskSummary {
  id: string;
  title: string;
  type: TaskType;
  due_date: string | null;
  overdue: boolean;
  from_automation: boolean;
}

export interface ActivitySummary {
  type: string;
  date: string;
  summary: string | null;
  outcome: string | null;
  /** true SOLO si engagement_quality='MEANINGFUL' (clasificado). */
  meaningful: boolean;
  engagement_quality: "MEANINGFUL" | "LOW_TOUCH" | "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Routing (orchestrator determinístico)
// ---------------------------------------------------------------------------

export interface AgentInvolvement {
  agent: Exclude<AgentKey, "orchestrator" | "commercial_director">;
  reason: string; // es-MX, corto, para UI y auditoría
}

export interface RoutingResult {
  primary: AgentInvolvement | null; // null p.ej. no_interesado/perdido no recuperable
  involvements: AgentInvolvement[]; // incluye al primario
}

// ---------------------------------------------------------------------------
// Outputs estructurados (validados con lib/ai/schemas.ts)
// ---------------------------------------------------------------------------

export interface AgentRecommendation {
  doctor_id: string | null;
  agent: AgentKey;
  recommendation_type: string; // ej: "contacto", "revision_clinica", "tarea", "profile_update", "escalamiento"
  objective: string;
  situation: string;
  recommended_action: string;
  channel: RecommendationChannel;
  recommended_date: string | null; // YYYY-MM-DD
  // ---- Next Best Action (Fase 3, §32) ----
  /** Qué impide que este doctor pase al siguiente estado sano. Lo propone el
   *  agente; el runner lo compara contra el que calculó el ruteo. */
  bottleneck: Bottleneck;
  /** Quién EJECUTA. No todo es del comercial. */
  owner_role: OwnerRole;
  /** Etapa comercial en palabras del negocio (no el enum crudo). */
  current_stage: string;
  /** Qué queremos que pase como consecuencia — no la acción, el resultado. */
  expected_outcome: string;
  /** Qué gatilla el siguiente paso ("si no responde en 3 días…"). */
  follow_up_condition: string | null;
  why: string[]; // inferencias/razonamiento — marcadas como inferencia
  evidence: { field: string; value: string }[]; // FACTS con origen en datos
  confidence: number; // 0-100
  commercial_priority: number; // 0-100
  clinical_handoff: boolean;
  handoff_agent: AgentKey | null;
  suggested_message: string | null; // draft es-MX, tono usted — NUNCA se envía solo
  requires_user_confirmation: boolean; // siempre true en V1
  payload: RecommendationPayload | null;
}

// Draft ejecutable al aceptar (mapea a server actions existentes)
export type RecommendationPayload =
  | { kind: "task"; title: string; type: TaskType; due_date: string | null; description: string | null }
  | { kind: "activity"; type: string; summary: string; outcome: string | null }
  | { kind: "profile_update"; fields: Partial<DoctorAiProfileFields>; rationale: string }
  // Propuestas de corrección de datos (0022). La IA aporta la evidencia; el
  // humano confirma. Sin confirmación el dato sigue siendo UNKNOWN.
  | {
      kind: "case_subject";
      case_id: string;
      proposed_type: "PATIENT" | "DOCTOR_SELF" | "OTHER";
      evidence: string;
    }
  | {
      kind: "activity_classification";
      activity_id: string;
      proposed_quality: "MEANINGFUL" | "LOW_TOUCH";
      main_topic: string | null;
      next_action: string | null;
      evidence: string;
    }
  | { kind: "none" };

export interface OrchestratorAssessment {
  doctor_id: string;
  ai_summary: string; // 2-4 oraciones es-MX: quién es, dónde está, qué necesita para avanzar con confianza
  situation: string;
  primary_agent: AgentKey;
  involvements: { agent: AgentKey; reason: string }[];
  recommendations: AgentRecommendation[];
}

export interface DirectorBrief {
  answer: string; // respuesta es-MX al manager, con números citados
  findings: { title: string; detail: string; evidence: { field: string; value: string }[] }[];
  recommendations: AgentRecommendation[];
  data_as_of: string;
  /**
   * Completitud REAL del dataset que sostiene la respuesta. La calcula el
   * runner sumando el `meta` de cada tool que corrió — NO la emite el modelo.
   * Si el modelo dijera "132 acreditados sin activar" sobre una lista capada,
   * este flag es lo que permite mostrarlo como incompleto igual.
   */
  dataset: DatasetCompleteness;
}

export interface DatasetCompleteness {
  complete: boolean;
  sources: string[];
  limitations: string[];
  tools_used: number;
}

// ---------------------------------------------------------------------------
// Filas de tablas AI (migración 0017)
// ---------------------------------------------------------------------------

export interface AiRecommendationRow {
  id: string;
  doctor_id: string | null;
  agent: AgentKey;
  run_id: string | null;
  brain_version: string;
  model_version: string;
  recommendation_type: string;
  objective: string | null;
  situation: string | null;
  recommended_action: string;
  channel: RecommendationChannel | null;
  recommended_date: string | null;
  why: string[];
  evidence: { field: string; value: string }[];
  confidence: number | null;
  commercial_priority: number | null;
  clinical_handoff: boolean;
  handoff_agent: string | null;
  suggested_message: string | null;
  requires_user_confirmation: boolean;
  payload: RecommendationPayload | null;
  status: RecommendationStatus;
  decided_by: string | null;
  decided_at: string | null;
  dismiss_reason: string | null;
  action_completed: boolean;
  executed_ref: Record<string, unknown> | null;
  outcome: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface DoctorAiProfileFields {
  experience_with_aligners: string | null;
  clinical_confidence: "alta" | "media" | "baja" | "desconocida";
  main_concerns: string | null;
  preferred_contact_style: string | null;
  business_goals: string | null;
  growth_ambition: string | null;
  known_objections: string | null;
  competitor_relationship: string | null;
  previous_bad_experiences: string | null;
  relationship_notes: string | null;
  team_readiness: string | null;
  patient_acquisition_problem: string | null;
  education_needs: string | null;
}

export interface DoctorAiProfileRow extends DoctorAiProfileFields {
  doctor_id: string;
  updated_by: string | null;
  updated_at: string;
  last_source: "humano" | "ai_confirmado";
}

export interface AgentRunRow {
  id: string;
  agent: AgentKey;
  doctor_id: string | null;
  trigger: AgentRunTrigger;
  requested_by: string | null;
  model_version: string;
  brain_version: string;
  status: "ok" | "error" | "refusal";
  error: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tools_called: { name: string; args: Record<string, unknown>; ms: number; rows: number | null }[];
  records_used: Record<string, unknown> | null;
  recommendation_ids: string[];
  result: Record<string, unknown> | null; // assessment/brief emitido, para re-mostrar en UI
  created_at: string;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export interface AiToolResult {
  data: unknown;
  rows: number | null; // para observabilidad
}

export interface AiToolDef {
  name: string;
  description: string; // incluye CUÁNDO usarla
  // JSON Schema (derivado de zod con z.toJSONSchema) — strict tool use
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<AiToolResult>;
}

// Re-exports útiles para los módulos de la capa AI
export type { Case, Opportunity, Task, Alert };

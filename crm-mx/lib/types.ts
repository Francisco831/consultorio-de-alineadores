// Tipos de dominio (espejo del schema de supabase/migrations)

export type DoctorCategoria =
  | "SIN_CATEGORIA" | "SILVER" | "GOLD" | "PLATINUM" | "BLACK" | "ELITE";

/** Journey comercial completo — 14 etapas, DOS universos:
 *  A (no acreditado): prospecto → contactado → calificacion → interes_acreditacion
 *    → acreditacion_agendada. Objetivo: QUE SE ACREDITE.
 *  B (acreditado): acreditado → en_activacion → activado → activo → growth
 *    → en_riesgo → dormido → reactivado. Objetivo: GENERAR CASOS.
 *  El corte entre universos es doctors.is_accredited.
 *  ('acreditacion_pendiente' y 'acreditado_no_activado' quedaron deprecados) */
export type LifecycleStage =
  | "prospecto" | "contactado" | "calificacion" | "interes_acreditacion"
  | "acreditacion_agendada" | "acreditado" | "en_activacion" | "activado"
  | "activo" | "growth" | "en_riesgo" | "dormido" | "reactivado" | "perdido"
  | "acreditacion_pendiente" | "acreditado_no_activado";

/** Pipeline de ADQUISICIÓN de doctores nuevos (universo A) */
export type AcqStage =
  | "identificado" | "contacto_intentado" | "contactado" | "calificado"
  | "reunion_agendada" | "reunion_realizada" | "interes_acreditacion"
  | "acreditacion_agendada" | "acreditado" | "no_interesado";

/** Pipeline de ACTIVACIÓN post-acreditación (hasta el primer caso pagado) */
export type ActStage =
  | "acreditado" | "contactado_post" | "paciente_potencial" | "documentacion"
  | "caso_ingresado" | "planificacion" | "presentado" | "primer_caso_pagado";

export type UserRole =
  | "ADMIN" | "COUNTRY_MANAGER" | "SALES_MANAGER" | "SALES" | "CLINICAL" | "VIEWER";

export type OppStage =
  | "viabilidad"
  | "paciente_potencial" | "documentacion" | "caso_ingresado" | "planificacion"
  | "presentada" | "decision" | "compromiso" | "ganada" | "perdida";

export type ForecastCat = "pipeline" | "best_case" | "commit" | "closed" | "omitted";
export type TaskType =
  | "llamada" | "videollamada" | "whatsapp" | "visita" | "reunion" | "revision_clinica" | "seguimiento";
export type TaskStatus = "pendiente" | "completada" | "cancelada";
export type ActivityType =
  | "llamada" | "videollamada" | "whatsapp" | "visita" | "reunion" | "revision_clinica" | "email" | "nota" | "keepday";
export type AlertStatus = "abierta" | "descartada" | "resuelta";
export type AlertSeverity = "critica" | "alta" | "media" | "info";
export type AttributionSource =
  | "ventas" | "clinica" | "evento" | "curso" | "inbound" | "referido" | "existente"
  | "campana" | "congreso" | "instagram" | "website" | "universidad" | "partnership" | "otro";
export type PriorityBucket =
  | "critico" | "alto_impacto" | "seguimientos" | "oportunidades" | "riesgo" | "growth"
  | "nuevo_negocio" | "activacion";
export type HealthConfidence = "personal" | "cohort" | "insuficiente";

export interface Profile {
  id: string;
  nombre: string;
  rol: UserRole;
  activo: boolean;
  avatar_url: string | null;
  whatsapp_phone: string | null;
  /** Línea de la organización desde la que atiende en Periskope (0041). Solo dígitos, sin @c.us. */
  periskope_org_phone: string | null;
  /** Última entrada real al CRM (0050): la toca el layout en cada carga de página. */
  last_seen_at: string | null;
}

export interface PriorityReason {
  code: string;
  text: string;
  weight: number;
}

export interface RecommendedAction {
  type: TaskType;
  label: string;
}

export interface Doctor {
  id: string;
  noloco_id: string | null;
  nombre: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  categoria: DoctorCategoria;
  lifecycle_stage: LifecycleStage;
  owner_id: string | null;
  clinical_owner_id: string | null;
  clinic_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zona: string | null;
  source: AttributionSource | null;
  campaign_id: string | null;
  accredited_at: string | null;
  // ---- journey de DOS universos ----
  is_accredited: boolean;
  acquisition_stage: AcqStage | null;
  activation_stage: ActStage | null;
  first_contact_at: string | null;
  first_meeting_at: string | null;
  accreditation_scheduled_at: string | null;
  first_paid_case_at: string | null;
  last_paid_case_at: string | null;
  days_to_first_case: number | null;
  activated_by: string | null;
  reactivated_at: string | null;
  lost_reason: string | null;
  // ---- perfil de prospecto ----
  specialty: string | null;
  uses_aligners: boolean | null;
  estimated_cases_month: number | null;
  interest_level: number | null;
  accreditation_interest: number | null;
  why_interesting: string | null;
  /** Notas libres del equipo sobre el doctor (migración 0048). Las usa el brief. */
  observaciones: string | null;
  // handle sin arroba; la URL es instagram.com/<handle> (migración 0036)
  instagram: string | null;
  // ---- resto de las redes y el cumpleaños (migración 0040) ----
  facebook: string | null;
  tiktok: string | null;
  linkedin: string | null;
  website: string | null;
  /** Cumpleaños. Si no se sabe el año, va 1900 y la edad queda en null. */
  birth_date: string | null;
  tags: string[];
  competitor_brands: string[];
  custom: Record<string, unknown>;
  health_score: number | null;
  health_factors: Record<string, unknown> | null;
  health_confidence: HealthConfidence | null;
  potential_computed: number | null;
  potential_override: number | null;
  priority_score: number | null;
  priority_reasons: PriorityReason[] | null;
  priority_bucket: PriorityBucket | null;
  recommended_action: RecommendedAction | null;
  avg_interval_days: number | null;
  expected_next_case_at: string | null;
  case_count: number;
  new_case_count: number;
  first_case_at: string | null;
  last_case_at: string | null;
  last_new_case_at: string | null;
  last_contact_at: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

export interface Case {
  id: string;
  noloco_case_id: string;
  id_externo: string | null;
  doctor_id: string;
  paciente: string | null;
  tipo_tratamiento: string | null;
  /** Fast | Medium | Full | Kids | Teens — derivado de la ficha de entregas */
  tipo_caso: string | null;
  alineadores_total: number | null;
  entregas: number | null;
  etapa: string | null;
  is_new_case: boolean;
  needs_review: boolean;
  fecha_ingreso: string;
  fecha_documentacion: string | null;
  fecha_aprobacion: string | null;
  fecha_video: string | null;
  fecha_aprobacion_video: string | null;
  fecha_impresion: string | null;
  fecha_finalizado: string | null;
  is_demo: boolean;
}

export interface Opportunity {
  id: string;
  doctor_id: string;
  patient_name: string | null;
  stage: OppStage;
  stage_entered_at: string;
  amount_mxn: number | null;
  probability: number | null;
  forecast_category: ForecastCat;
  expected_close_date: string | null;
  source: AttributionSource | null;
  owner_id: string | null;
  case_id: string | null;
  lost_reason: string | null;
  closed_at: string | null;
  is_demo: boolean;
  created_at: string;
  // ---- ciclo de viabilidad (migración 0022) ----
  viability_status: ViabilityStatus | null;
  viability_result: string | null;
  viability_requested_at: string | null;
  viability_submitted_at: string | null;
  viability_completed_at: string | null;
  viability_follow_up_date: string | null;
}

export interface Activity {
  id: string;
  doctor_id: string;
  opportunity_id: string | null;
  type: ActivityType;
  occurred_at: string;
  summary: string | null;
  outcome: string | null;
  created_by: string | null;
  is_demo: boolean;
}

export interface Task {
  id: string;
  doctor_id: string | null;
  opportunity_id: string | null;
  type: TaskType;
  title: string;
  due_date: string | null;
  status: TaskStatus;
  outcome: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  created_by: string | null;
  is_demo: boolean;
}

export interface Alert {
  id: string;
  rule_key: string;
  doctor_id: string | null;
  opportunity_id: string | null;
  severity: AlertSeverity;
  title: string;
  reason: string | null;
  status: AlertStatus;
  is_demo: boolean;
  created_at: string;
}

// ---------- labels en español ----------

export const LIFECYCLE_LABELS: Record<LifecycleStage, string> = {
  prospecto: "Prospecto",
  contactado: "Contactado",
  calificacion: "Calificación",
  interes_acreditacion: "Interés en acreditarse",
  acreditacion_agendada: "Acreditación agendada",
  acreditado: "Acreditado",
  en_activacion: "En activación",
  activado: "Activado",
  activo: "Activo",
  growth: "Growth",
  en_riesgo: "En riesgo",
  dormido: "Dormido",
  reactivado: "Reactivado",
  perdido: "Perdido",
  // deprecados (pueden quedar en audit_log viejo)
  acreditacion_pendiente: "Acreditación agendada",
  acreditado_no_activado: "En activación",
};

export const ACQ_STAGE_LABELS: Record<AcqStage, string> = {
  identificado: "Identificado",
  contacto_intentado: "Contacto intentado",
  contactado: "Contactado",
  calificado: "Calificado",
  reunion_agendada: "Reunión agendada",
  reunion_realizada: "Reunión realizada",
  interes_acreditacion: "Interés en acreditarse",
  acreditacion_agendada: "Acreditación agendada",
  acreditado: "Acreditado",
  no_interesado: "No interesado",
};

export const ACT_STAGE_LABELS: Record<ActStage, string> = {
  acreditado: "Acreditado",
  contactado_post: "Contactado",
  paciente_potencial: "Paciente potencial",
  documentacion: "Documentación",
  caso_ingresado: "Caso ingresado",
  planificacion: "Planificación",
  presentado: "Presentado",
  primer_caso_pagado: "1er caso pagado",
};

export const SOURCE_LABELS: Record<AttributionSource, string> = {
  ventas: "Ventas (outbound)",
  clinica: "Equipo clínico",
  evento: "Evento",
  curso: "Curso",
  inbound: "Inbound",
  referido: "Referido",
  existente: "Referido de doctor",
  campana: "Campaña",
  congreso: "Congreso",
  instagram: "Instagram",
  website: "Website",
  universidad: "Universidad",
  partnership: "Partnership",
  otro: "Otro",
};

export const OPP_STAGE_LABELS: Record<OppStage, string> = {
  viabilidad: "Viabilidad",
  paciente_potencial: "Paciente potencial",
  documentacion: "Documentación",
  caso_ingresado: "Caso ingresado",
  planificacion: "Planificación",
  presentada: "Presentada",
  decision: "Decisión",
  compromiso: "Compromiso",
  ganada: "Ganada",
  perdida: "Perdida",
};

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  llamada: "Llamada",
  videollamada: "Videollamada",
  whatsapp: "WhatsApp",
  visita: "Visita",
  reunion: "Reunión",
  revision_clinica: "Revisión clínica",
  seguimiento: "Seguimiento",
};

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  llamada: "Llamada",
  videollamada: "Videollamada",
  whatsapp: "WhatsApp",
  visita: "Visita",
  reunion: "Reunión",
  revision_clinica: "Revisión clínica",
  email: "Email",
  nota: "Nota",
  keepday: "KeepDay",
};

export const BUCKET_LABELS: Record<PriorityBucket, string> = {
  nuevo_negocio: "Nuevos doctores",
  activacion: "Activación",
  critico: "Crítico",
  alto_impacto: "Alto impacto",
  seguimientos: "Seguimientos",
  oportunidades: "Oportunidades",
  riesgo: "Riesgo",
  growth: "Growth",
};

/** Las dos áreas tienen su propio marcador mensual. `paid_cases` es el del área
 *  ACREDITADOS; `accreditations` el de POR ACREDITARSE — este último ya lo leían
 *  /prospeccion y /dashboard y ninguna línea del código lo escribía, así que el
 *  tile mostraba el conteo del mes sin denominador.
 *
 *  Vive acá y no en lib/actions/admin.ts porque ese archivo es "use server" y
 *  solo puede exportar funciones async. */
export const METRICAS_OBJETIVO = {
  paid_cases: "Casos pagados (Acreditados)",
  accreditations: "Acreditaciones (Por acreditarse)",
} as const;

export type MetricaObjetivo = keyof typeof METRICAS_OBJETIVO;

// ---------------------------------------------------------------------------
// Viabilidad: el ciclo de "pedí una viabilidad al equipo clínico" (0022).
// `solicitada` = el doctor la pidió; `enviada` = se mandaron los registros;
// `respondida` = el equipo clínico contestó; `sin_respuesta` = se dio por perdida.
// ---------------------------------------------------------------------------
export type ViabilityStatus = "solicitada" | "enviada" | "respondida" | "sin_respuesta";

export const VIABILITY_STATUS_LABELS: Record<ViabilityStatus, string> = {
  solicitada: "Solicitada",
  enviada: "Enviada",
  respondida: "Respondida",
  sin_respuesta: "Sin respuesta",
};

/** Un renglón de la libreta personal (migración 0039). No es una tarea del CRM. */
export interface Pendiente {
  id: string;
  user_id: string;
  texto: string;
  hecho: boolean;
  hecho_at: string | null;
  orden: number;
  created_at: string;
}

/** Cumpleaños o aniversario de acreditación (función doctores_efemerides, 0040). */
export interface Efemeride {
  doctor_id: string;
  nombre: string;
  tipo: "cumple" | "aniversario";
  /** La fecha de este año (o la del que viene si ya pasó). */
  fecha: string;
  /** 0 = hoy, -1 = ayer, positivo = faltan. */
  dias: number;
  /** Años que cumple. null cuando no se sabe el año de origen. */
  anios: number | null;
  categoria: DoctorCategoria;
  city: string | null;
  whatsapp: string | null;
  phone: string | null;
  instagram: string | null;
  owner_id: string | null;
}

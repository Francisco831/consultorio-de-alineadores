// Orchestrator (docs/AI_ARCHITECTURE.md §6 + endurecimiento 0022): ruteo
// DETERMINÍSTICO en código — auditable y gratis; el LLM analiza, no rutea.
//
// Qué cambia respecto de V1 (Módulo C):
// 1. El ruteo devuelve PRIMARIO + AGENTES DE APOYO, con `routing_reason` (es-MX)
//    y `routing_evidence` ({campo, valor, fuente}) — se persisten en agent_runs.
// 2. REGLA DE SERVICIO: doctor_success se vuelve PRIMARIO solo si la severidad
//    es CRITICAL/HIGH o hay evidencia registrada de impacto en la experiencia
//    del doctor (queja, caso bloqueado, pedido sin responder, problema
//    repetido). Con MEDIUM/LOW/INFORMATIONAL acompaña como APOYO y el primario
//    lo decide el ciclo de vida. Servicio le sigue ganando a growth — pero solo
//    cuando el problema de servicio es real.
// 3. Ruteo por HITOS (0022): la activación es primaria mientras el primer caso
//    de paciente no esté COMPLETED, y su foco cambia según el caso propio. Un
//    hito UNKNOWN JAMÁS se trata como cumplido: rutea igual y se declara
//    "tipo de caso no identificado" como evidencia.
//
// analyzeDoctor: contexto → routing → confianza de datos → corre el agente
// primario (y a lo sumo un segundo) → arma el OrchestratorAssessment.

import { buildDoctorContext, contextToPromptBlock } from "@/lib/ai/context";
import { dataConfidence } from "@/lib/ai/confidence";
import { runAgentLLM } from "@/lib/ai/runner";
import { BRAIN_VERSION } from "@/lib/ai/brain";
import { AI_MODEL, createAiServiceClient } from "@/lib/ai/db";
import { AGENT_LABELS, BOTTLENECK_LABELS } from "@/lib/ai/types";
import { LIFECYCLE_LABELS, type Doctor } from "@/lib/types";
import type {
  AgentInvolvement,
  AgentKey,
  Bottleneck,
  AgentRecommendation,
  AgentRunTrigger,
  DoctorContext,
  InteractionDataQuality,
  OrchestratorAssessment as BaseOrchestratorAssessment,
  RoutingResult as BaseRoutingResult,
  ServiceConfidence,
  ServiceSeverity,
} from "@/lib/ai/types";

// ---------------------------------------------------------------------------
// Contratos extendidos (las interfaces base viven en lib/ai/types.ts)
// ---------------------------------------------------------------------------

/** Hecho que disparó una decisión de ruteo. Va a agent_runs.routing_evidence. */
export interface RoutingEvidence {
  field: string;
  value: string;
  source: string;
}

export interface RoutingResult extends BaseRoutingResult {
  /** Agentes que acompañan sin ser primarios. */
  supporting: AgentInvolvement[];
  /** Por qué quedó este ruteo, en es-MX, citando la evidencia. */
  routing_reason: string;
  routing_evidence: RoutingEvidence[];
  /** Qué impide que este doctor pase al siguiente estado sano (Fase 3). Es lo
   *  que el agente tiene que atacar, y lo que el director agrega para ver dónde
   *  está trabada la máquina comercial. */
  bottleneck: Bottleneck;
  /** Confianza en la DECISIÓN DE RUTEO (no en la recomendación): cuánto se puede
   *  creer que este es el agente correcto, dados los datos que hay. */
  routing_confidence: number;
  /** Por qué la confianza del ruteo no es 100. Vacío = ruteo sin reservas. */
  routing_caps: string[];
}

export interface OrchestratorAssessment extends BaseOrchestratorAssessment {
  routing_reason: string;
  supporting_agents: AgentKey[];
  routing_evidence: RoutingEvidence[];
  data_quality: { data_confidence: number; caps: string[] };
}

// ---------------------------------------------------------------------------
// Vocabulario de servicio (0022)
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<ServiceSeverity, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFORMATIONAL: 1,
};

const SEVERITY_LABEL: Record<ServiceSeverity, string> = {
  CRITICAL: "CRÍTICA",
  HIGH: "ALTA",
  MEDIUM: "MEDIA",
  LOW: "BAJA",
  INFORMATIONAL: "INFORMATIVA",
};

/** enum alert_severity de la DB (es) → escala del ruteo, por si algún contexto
 *  llega con la severidad cruda de la alerta en vez de la calificada. */
const LEGACY_SEVERITY: Record<string, ServiceSeverity> = {
  critica: "CRITICAL",
  alta: "HIGH",
  media: "MEDIUM",
  baja: "LOW",
  info: "INFORMATIONAL",
};

/** Factores de alerts.impact_factors (0022) que PRUEBAN impacto en la
 *  experiencia del doctor. El resto del vocabulario (dias_atraso,
 *  sla_incumplido, paciente_afectado, problema_administrativo/clinico) describe
 *  el problema pero no alcanza por sí solo para secuestrar el ruteo: la
 *  severidad ya pondera la magnitud y el SLA de México está sin definir. */
const ESCALATING_IMPACT_FACTORS: Record<string, string> = {
  queja_registrada: "queja registrada",
  caso_bloqueado: "caso bloqueado",
  pedido_sin_responder: "pedido sin responder",
  problema_repetido: "problema repetido",
};

/** trust_risk_score (0-100) desde el cual el riesgo de confianza vale por sí
 *  mismo como evidencia de impacto. */
const TRUST_RISK_ESCALATION = 70;

// ---------------------------------------------------------------------------
// Lecturas defensivas
// ---------------------------------------------------------------------------
// Los campos ya están tipados (Módulo B), pero el router también lo corren el
// harness de evaluación y consumidores viejos con contextos parciales. Un valor
// ausente o fuera de vocabulario se lee como DESCONOCIDO — nunca como bueno.

function normalizeSeverity(v: unknown): ServiceSeverity | null {
  if (typeof v !== "string") return null;
  const up = v.toUpperCase();
  if (up in SEVERITY_RANK) return up as ServiceSeverity;
  return LEGACY_SEVERITY[v.toLowerCase()] ?? null;
}

function normalizeServiceConfidence(v: unknown): ServiceConfidence | null {
  if (typeof v !== "string") return null;
  const up = v.toUpperCase();
  return up === "CONFIRMED" || up === "LIKELY" || up === "POSSIBLE"
    ? (up as ServiceConfidence)
    : null;
}

function safeScore(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100
    ? Math.round(v)
    : null;
}

function safeCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
}

function safeQuality(v: unknown): InteractionDataQuality | null {
  return v === "GOOD" || v === "PARTIAL" || v === "POOR" ? v : null;
}

function safeFactors(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ---------------------------------------------------------------------------
// Evaluación de servicio
// ---------------------------------------------------------------------------

interface ServiceAssessment {
  count: number;
  maxSeverity: ServiceSeverity | null;
  /** problemas abiertos sin severidad calificada (no se asumen graves) */
  unqualified: number;
  /** etiquetas es-MX de la evidencia de impacto registrada */
  impact: string[];
  maxTrustRisk: number | null;
  confidences: ServiceConfidence[];
  escalates: boolean;
}

function assessService(ctx: DoctorContext): ServiceAssessment {
  const issues = Array.isArray(ctx.service_issues) ? ctx.service_issues : [];
  let maxSeverity: ServiceSeverity | null = null;
  let maxTrustRisk = safeScore(ctx.trust_risk_score);
  let unqualified = 0;
  let atLeastMedium = 0;
  const impact = new Set<string>();
  const confidences = new Set<ServiceConfidence>();

  for (const issue of issues) {
    const severity = normalizeSeverity(issue.severity);
    if (severity === null) {
      unqualified++;
    } else {
      if (maxSeverity === null || SEVERITY_RANK[severity] > SEVERITY_RANK[maxSeverity]) {
        maxSeverity = severity;
      }
      if (SEVERITY_RANK[severity] >= SEVERITY_RANK.MEDIUM) atLeastMedium++;
    }

    const confidence = normalizeServiceConfidence(issue.confidence);
    if (confidence) confidences.add(confidence);

    const risk = safeScore(issue.trust_risk_score);
    if (risk !== null && (maxTrustRisk === null || risk > maxTrustRisk)) maxTrustRisk = risk;

    for (const factor of safeFactors(issue.impact_factors)) {
      const label = ESCALATING_IMPACT_FACTORS[factor];
      if (label) impact.add(label);
    }
  }

  // "Problema repetido" también se DERIVA de los datos: dos o más problemas
  // abiertos con severidad conocida de MEDIA para arriba. Es un conteo, no una
  // inferencia; los problemas sin severidad calificada NO cuentan.
  if (atLeastMedium >= 2) impact.add("problema repetido (2 o más problemas abiertos)");

  const severeEnough =
    maxSeverity !== null && SEVERITY_RANK[maxSeverity] >= SEVERITY_RANK.HIGH;
  const trustAtRisk = maxTrustRisk !== null && maxTrustRisk >= TRUST_RISK_ESCALATION;

  return {
    count: issues.length,
    maxSeverity,
    unqualified,
    impact: [...impact],
    maxTrustRisk,
    confidences: [...confidences],
    escalates: issues.length > 0 && (severeEnough || impact.size > 0 || trustAtRisk),
  };
}

// ---------------------------------------------------------------------------
// Prioridad entre agentes del ciclo de vida
// ---------------------------------------------------------------------------
// doctor_success YA NO está en esta lista: su lugar lo decide la regla de
// servicio (primario si escala, apoyo si no).
//
// `activation` va PRIMERA: mientras el primer caso de paciente no esté
// COMPLETED, el hito manda. Esto incluye ganarle a retención — no se puede
// "retener" a un doctor del que no está confirmado que activó (y hoy, con los
// 1.017 casos en UNKNOWN, eso es casi todo el universo B). Retención y educación
// clínica acompañan como apoyo/handoff (§6).

// Orden de ruteo A-G (Fase 3, §29):
//   A. CALIDAD DE DATOS — no es un agente: es un cuello de botella que se declara
//      y baja la confianza del ruteo. El agente del ciclo de vida sigue siendo el
//      dueño de la acción (pedir que se clasifique el dato).
//   B. SERVICIO / CONFIANZA — lo resuelve la regla de severidad, fuera de esta lista.
//   C. BLOQUEO CLÍNICO — una duda concreta o una confianza clínica baja registrada
//      manda sobre la etapa: el doctor no avanza hasta resolverla.
//   D. LIFECYCLE — activación, acreditación, adquisición.
//   E. OPORTUNIDAD COMERCIAL — no es un agente propio: eleva al agente del ciclo
//      de vida que la posee por encima de retención y crecimiento.
//   F. RETENCIÓN.
//   G. GROWTH.
const LIFECYCLE_PRIORITY: AgentInvolvement["agent"][] = [
  "clinical_education",
  "activation",
  "accreditation",
  "acquisition",
  "retention_reactivation",
  "growth",
];

function sortByPriority(involvements: AgentInvolvement[]): AgentInvolvement[] {
  return [...involvements].sort((a, b) => {
    const ia = LIFECYCLE_PRIORITY.indexOf(a.agent);
    const ib = LIFECYCLE_PRIORITY.indexOf(b.agent);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

// Etapas del universo A anteriores al interés real → adquisición
const ACQ_EARLY_STAGES = new Set([
  "identificado",
  "contacto_intentado",
  "contactado",
  "calificado",
  "reunion_agendada",
  "reunion_realizada",
]);

const HEALTHY_B_STAGES = new Set(["activo", "growth", "reactivado"]);

// Estados que ya rutea la regla de retención/reactivación: no deben además caer
// en growth.
const RETENTION_STAGES = new Set(["en_riesgo", "dormido", "perdido"]);

// ---------------------------------------------------------------------------
// Cadencia relativa al propio doctor (Brain 2026.08.2 — "cadencia dinámica")
// ---------------------------------------------------------------------------
// No existe la regla "contactar cada 30 días" ni un umbral fijo de caída: la
// referencia es la frecuencia histórica DEL PROPIO DOCTOR. Uno que manda un caso
// cada 90 días y lleva 45 NO está en caída, aunque el motor lo haya marcado en
// riesgo — levantar una alarma falsa cuesta relación.

/** Tolerancia sobre el intervalo propio antes de hablar de caída. */
const RHYTHM_TOLERANCE = 1.5;

interface CadenceAssessment {
  /** true = dentro de su patrón · false = fuera · null = no se puede saber. */
  withinOwnRhythm: boolean | null;
  intervalDays: number | null;
  daysSinceLastCase: number | null;
  ratio: number | null;
}

function assessCadence(ctx: DoctorContext): CadenceAssessment {
  const freq = ctx.historical_case_frequency;
  const interval =
    freq && typeof freq.avg_interval_days === "number" && freq.avg_interval_days > 0
      ? freq.avg_interval_days
      : null;
  const since = typeof ctx.days_since_last_case === "number" ? ctx.days_since_last_case : null;
  // Solo la frecuencia PERSONAL sirve para desmentir una alarma: un promedio de
  // cohorte no dice nada sobre el patrón de este doctor.
  if (interval === null || since === null || freq.confidence !== "personal") {
    return { withinOwnRhythm: null, intervalDays: interval, daysSinceLastCase: since, ratio: null };
  }
  const ratio = since / interval;
  return {
    withinOwnRhythm: ratio <= RHYTHM_TOLERANCE,
    intervalDays: interval,
    daysSinceLastCase: since,
    ratio,
  };
}

// ---------------------------------------------------------------------------
// Oportunidad clínica (Brain 2026.08.2 — el equipo clínico como activo comercial)
// ---------------------------------------------------------------------------
// La pregunta que el agente se hace seguido: ¿una intervención clínica podría
// aumentar la confianza y mover esta cuenta? Pero el tiempo clínico es escaso:
// los niveles 1-3 justifican involucrar al agente clínico; del 4 al 7 se deja
// anotado como oportunidad sin ocupar la agenda.

const CLINICAL_TIER_ESCALATES = 3;

interface ClinicalOpportunity {
  tier: number | null;
  reason: string | null;
  field: string;
}

function assessClinicalOpportunity(ctx: DoctorContext): ClinicalOpportunity {
  const viabilityInPlay = ctx.open_opportunities.some((o) => o.stage === "viabilidad");
  const clinicalObjection = ctx.main_objection
    ? /cl[ií]nic|t[eé]cnic|viabilidad|caso complejo|inseguridad/i.test(ctx.main_objection)
    : false;

  if (viabilityInPlay)
    return {
      tier: 1,
      reason: "Viabilidad en juego en una oportunidad abierta",
      field: "opportunities.stage",
    };
  if (clinicalObjection)
    return { tier: 1, reason: "Objeción principal de tipo clínico", field: "doctor_ai_profile" };

  // Nivel 2 = "recién acreditado con posibilidad REAL de caso propio / primer
  // paciente". La posibilidad real exige que el hito se CONOZCA: con el hito en
  // UNKNOWN no se ocupa agenda clínica — primero se clasifica el caso.
  const days = ctx.days_since_accreditation;
  const reciénAcreditado = ctx.is_accredited && typeof days === "number" && days <= 120;
  const hitoConocido =
    ctx.first_patient_case_status === "NOT_STARTED" ||
    ctx.first_patient_case_status === "IN_PROGRESS";
  if (reciénAcreditado && hitoConocido)
    return {
      tier: 2,
      reason: `Recién acreditado (${days} días) sin primer caso de paciente confirmado: la presencia clínica es lo que acelera el caso propio y el primer paciente`,
      field: "days_since_accreditation + first_patient_case_status",
    };

  if (ctx.clinical_confidence === "baja")
    return { tier: 3, reason: "Confianza clínica baja registrada", field: "doctor_ai_profile" };

  // Niveles 4-7: oportunidad real, pero no ocupa agenda clínica por sí sola.
  const potencial = typeof ctx.potential_score === "number" ? ctx.potential_score : null;
  if (ctx.is_accredited && RETENTION_STAGES.has(ctx.lifecycle) && ctx.cases_total >= 3)
    return {
      tier: 4,
      reason: "Doctor con historial perdiendo ritmo: si la causa es la técnica, corresponde intervención clínica",
      field: "lifecycle_stage + cases_total",
    };
  if (ctx.is_accredited && potencial !== null && potencial >= 70 && ctx.cases_90d === 0)
    return {
      tier: 5,
      reason: "Alto potencial estancado: verificar si el freno es la técnica",
      field: "potential_score + cases_90d",
    };
  if (!ctx.is_accredited && potencial !== null && potencial >= 70)
    return {
      tier: 6,
      reason: "Prospecto de alto potencial: la presencia clínica puede acelerar la acreditación",
      field: "potential_score",
    };
  return { tier: null, reason: null, field: "" };
}

// ---------------------------------------------------------------------------
// A. Puerta de calidad de datos (Fase 3, §29)
// ---------------------------------------------------------------------------
// Antes de decidir a qué agente va el doctor: ¿sabemos lo suficiente para
// decidir algo? La puerta se abre solo cuando NO hay ninguna señal dura sobre la
// que actuar — no cuando faltan datos en general (con la base actual faltan
// datos en todos, y bloquear a todos no ayudaría a nadie).

interface DataGate {
  insuficiente: boolean;
  motivos: string[];
}

function assessDataGate(ctx: DoctorContext, service: ServiceAssessment): DataGate {
  const motivos: string[] = [];
  const quality = safeQuality(ctx.interaction_data_quality);

  // Señales duras: cualquiera de estas alcanza para saber qué hacer.
  const haySenalDura =
    service.count > 0 ||
    ctx.open_opportunities.length > 0 ||
    ctx.tasks.length > 0 ||
    ctx.stalled_cases.length > 0 ||
    ctx.clinical_confidence === "baja" ||
    ctx.main_objection !== null ||
    (typeof ctx.days_since_last_case === "number" && ctx.days_since_last_case <= 90);
  if (haySenalDura) return { insuficiente: false, motivos };

  if (quality !== "GOOD") {
    motivos.push(
      quality === null
        ? "la calidad del historial de interacción no está evaluada"
        : `el historial de interacción es ${quality}: no se puede saber si hubo conversaciones reales`
    );
  }
  if (ctx.is_accredited) {
    const unclassified = safeCount(ctx.cases_unclassified) ?? 0;
    if (
      ctx.own_case_status === "UNKNOWN" &&
      ctx.first_patient_case_status === "UNKNOWN" &&
      unclassified > 0
    ) {
      motivos.push(
        `sus ${unclassified} caso(s) están sin clasificar: ningún hito del journey está confirmado`
      );
    }
  } else if (ctx.acquisition_stage === null) {
    motivos.push("no tiene etapa de adquisición cargada");
  }

  // Hace falta más de un hueco para declarar que no se puede decidir: un solo
  // dato faltante se resuelve dentro de la recomendación, no bloqueando el ruteo.
  return { insuficiente: motivos.length >= 2, motivos };
}

// ---------------------------------------------------------------------------
// Cuello de botella y confianza del ruteo
// ---------------------------------------------------------------------------

/** Confianza en la decisión de ruteo. Arranca en 100 y descuenta por cada cosa
 *  que hace dudar de que este sea el agente correcto. */
function assessRoutingConfidence(
  ctx: DoctorContext,
  service: ServiceAssessment,
  gate: DataGate
): { score: number; caps: string[] } {
  let score = 100;
  const caps: string[] = [];
  const baja = (puntos: number, motivo: string) => {
    score -= puntos;
    caps.push(motivo);
  };

  if (gate.insuficiente) baja(30, "no hay señales duras sobre las que decidir");

  const quality = safeQuality(ctx.interaction_data_quality);
  if (quality === "POOR" || quality === null)
    baja(20, "el historial de interacción no permite ubicar la relación en el tiempo");
  else if (quality === "PARTIAL") baja(10, "solo parte de las interacciones está calificada");

  if (ctx.is_accredited && (safeCount(ctx.cases_unclassified) ?? 0) > 0)
    baja(15, "los hitos del journey no están confirmados (casos sin clasificar)");

  // El caso que más duele en la base real: el ruteo lo decide un problema de
  // servicio que ninguna persona verificó y que el propio dato marca como dudoso.
  if (service.escalates && !service.confidences.includes("CONFIRMED"))
    baja(15, "el problema de servicio que decide el ruteo no lo verificó ninguna persona");

  if (ctx.is_accredited && ctx.accreditation_date === null)
    baja(10, "no hay fecha de acreditación: la antigüedad de la relación es desconocida");

  return { score: Math.max(10, Math.min(100, score)), caps };
}

/** El cuello de botella que el agente primario tiene que atacar. El orden sigue
 *  el de ruteo: lo que aparece antes manda. */
function assessBottleneck(
  ctx: DoctorContext,
  service: ServiceAssessment,
  gate: DataGate,
  clinical: ClinicalOpportunity,
  cadence: CadenceAssessment,
  retentionDowngraded: boolean
): Bottleneck {
  if (gate.insuficiente) return "DATOS_INSUFICIENTES";
  if (service.escalates) return "SERVICIO";
  if (clinical.tier === 1 || ctx.clinical_confidence === "baja") return "INCERTIDUMBRE_CLINICA";

  if (!ctx.is_accredited) {
    if (ctx.acquisition_stage === "no_interesado") return "NINGUNO";
    if (
      ctx.acquisition_stage === "interes_acreditacion" ||
      ctx.acquisition_stage === "acreditacion_agendada"
    )
      return "SIN_ACREDITACION";
    return "SIN_RELACION";
  }

  // Universo B: los hitos mandan mientras no estén cumplidos.
  if (ctx.first_patient_case_status !== "COMPLETED") {
    if (ctx.own_case_status === "UNKNOWN" || ctx.first_patient_case_status === "UNKNOWN")
      return "DATOS_INSUFICIENTES";
    if (ctx.own_case_status !== "COMPLETED") return "SIN_CASO_PROPIO";
    return "SIN_PRIMER_PACIENTE";
  }

  if (RETENTION_STAGES.has(ctx.lifecycle) && !retentionDowngraded)
    return cadence.withinOwnRhythm === false ? "CADENCIA_CAIDA" : "DESCONOCIDO";

  if (ctx.second_patient_case_status !== "COMPLETED") return "SIN_SEGUNDO_CASO";

  const potencial = safeScore(ctx.potential_score);
  if (potencial !== null && potencial >= 60 && ctx.cases_90d <= 1) return "BRECHA_CRECIMIENTO";
  if (ctx.owner === null) return "SIN_DUENO";
  return "NINGUNO";
}

// ---------------------------------------------------------------------------
// Armado del resultado
// ---------------------------------------------------------------------------

function composeRoutingReason(
  primary: AgentInvolvement | null,
  supporting: AgentInvolvement[],
  service: ServiceAssessment,
  dataAsOf: string | null,
  extra: string[]
): string {
  const parts: string[] = [];
  if (primary) {
    parts.push(`${AGENT_LABELS[primary.agent]} primario: ${primary.reason}.`);
  } else {
    parts.push(
      "Sin agente asignado: el doctor no muestra señales que requieran acción comercial ahora."
    );
  }
  if (supporting.length > 0) {
    parts.push(
      `Acompañan: ${supporting
        .map((s) => `${AGENT_LABELS[s.agent]} (${s.reason.toLowerCase()})`)
        .join("; ")}.`
    );
  }
  if (service.count > 0 && !service.escalates) {
    parts.push(
      "El problema de servicio no alcanza severidad crítica ni alta y no tiene impacto registrado sobre el doctor, así que servicio acompaña y no desplaza al primario."
    );
  }
  parts.push(...extra);
  if (dataAsOf) parts.push(`Datos al ${dataAsOf}.`);
  return parts.join(" ");
}

interface FinalizeInput {
  serviceInvolvement: AgentInvolvement | null;
  lifecycle: AgentInvolvement[];
  service: ServiceAssessment;
  evidence: RoutingEvidence[];
  notes: string[];
  dataAsOf: string | null;
  /** Agentes que acompañan pero NUNCA pueden quedar primarios (p. ej. retención
   *  cuando la caída no está confirmada contra la frecuencia propia del doctor). */
  alwaysSupporting: AgentInvolvement[];
  bottleneck: Bottleneck;
  routingConfidence: number;
  routingCaps: string[];
}

function finalizeRouting({
  serviceInvolvement,
  lifecycle,
  service,
  evidence,
  notes,
  dataAsOf,
  alwaysSupporting,
  bottleneck,
  routingConfidence,
  routingCaps,
}: FinalizeInput): RoutingResult {
  const ordered = sortByPriority(lifecycle);
  let primary: AgentInvolvement | null;
  const supporting: AgentInvolvement[] = [];

  if (serviceInvolvement && service.escalates) {
    // Problema de servicio real ⇒ primario. Todo el ciclo de vida acompaña.
    primary = serviceInvolvement;
    supporting.push(...ordered);
  } else if (ordered.length > 0) {
    // Servicio no escala ⇒ el primario lo decide el ciclo de vida.
    primary = ordered[0];
    if (serviceInvolvement) supporting.push(serviceInvolvement);
    supporting.push(...ordered.slice(1));
  } else {
    // Sin señales de ciclo de vida: si hay un problema de servicio, alguien
    // tiene que atenderlo aunque sea leve.
    primary = serviceInvolvement;
  }
  supporting.push(...sortByPriority(alwaysSupporting));

  return {
    primary,
    supporting,
    involvements: primary ? [primary, ...supporting] : [],
    routing_reason: composeRoutingReason(primary, supporting, service, dataAsOf, notes),
    routing_evidence: evidence,
    bottleneck,
    routing_confidence: routingConfidence,
    routing_caps: routingCaps,
  };
}

// ---------------------------------------------------------------------------
// routeDoctor — ruteo completo con el DoctorContext
// ---------------------------------------------------------------------------

/**
 * Reglas §6 + endurecimiento 0022. Devuelve primario, agentes de apoyo, el
 * motivo en es-MX y la evidencia que lo sostiene.
 */
export function routeDoctor(ctx: DoctorContext): RoutingResult {
  const evidence: RoutingEvidence[] = [];
  const lifecycle: AgentInvolvement[] = [];
  // Acompañan siempre, jamás quedan primarios.
  const softSupport: AgentInvolvement[] = [];
  const notes: string[] = [];

  evidence.push({
    field: "doctors.lifecycle_stage",
    value: ctx.lifecycle,
    source: "motor determinístico (recompute_doctor)",
  });
  evidence.push({
    field: "doctors.is_accredited",
    value: ctx.is_accredited
      ? `sí${
          ctx.accreditation_date
            ? ` (${ctx.accreditation_date.slice(0, 10)}, hace ${ctx.days_since_accreditation ?? "?"} días)`
            : " — SIN fecha de acreditación cargada"
        }`
      : `no (etapa ${ctx.acquisition_stage ?? "sin etapa"})`,
    source: "doctors",
  });

  // -------------------------------------------------------------------------
  // 1. SERVICIO — primero, pero solo si el problema es real
  // -------------------------------------------------------------------------
  const service = assessService(ctx);
  let serviceInvolvement: AgentInvolvement | null = null;
  if (service.count > 0) {
    const sev = service.maxSeverity
      ? `severidad máxima ${SEVERITY_LABEL[service.maxSeverity]}`
      : "severidad no calificada";
    const impacto = service.impact.length > 0 ? `; impacto: ${service.impact.join(", ")}` : "";
    const cuantos =
      service.count === 1
        ? "Un problema de servicio abierto"
        : `${service.count} problemas de servicio abiertos`;
    serviceInvolvement = {
      agent: "doctor_success",
      reason: service.escalates
        ? `${cuantos} — ${sev}${impacto}`
        : `${cuantos} de ${sev}: acompaña sin desplazar el objetivo del ciclo de vida`,
    };
    evidence.push({
      field: "service_issues",
      value: `${service.count} abierto(s) · ${sev}${impacto}${
        service.maxTrustRisk !== null
          ? ` · riesgo de confianza ${service.maxTrustRisk}/100`
          : ""
      }${service.confidences.length ? ` · diagnóstico ${service.confidences.join("/")}` : ""}`,
      source: "alerts (0022) + casos estancados del context engine",
    });
    if (service.unqualified > 0) {
      evidence.push({
        field: "alerts.service_confidence",
        value: `${service.unqualified} problema(s) sin severidad calificada — no se asumen graves`,
        source: "alerts (0022, columnas nullable)",
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. Retención / reactivación
  // -------------------------------------------------------------------------
  const cadence = assessCadence(ctx);
  // true = el motor marcó riesgo pero la frecuencia propia no lo sostiene, así
  // que el doctor se trata como sano (y vuelve a ser elegible para growth).
  let retentionDowngraded = false;
  if (ctx.lifecycle === "en_riesgo") {
    if (cadence.withinOwnRhythm === true) {
      retentionDowngraded = true;
      // El motor lo marcó en riesgo, pero contra SU propia frecuencia todavía
      // está dentro de patrón. No se rutea una alarma que los datos no sostienen:
      // retención acompaña para verificar, no para reclamar.
      const detalle = `manda un caso cada ${Math.round(cadence.intervalDays ?? 0)} días y lleva ${cadence.daysSinceLastCase}`;
      softSupport.push({
        agent: "retention_reactivation",
        reason: `El motor lo marcó en riesgo, pero ${detalle}: verificar antes de tratarlo como caída`,
      });
      evidence.push({
        field: "historical_case_frequency.avg_interval_days",
        value: `${detalle} (${(cadence.ratio ?? 0).toFixed(1)}× su intervalo): dentro de su patrón`,
        source: "cases (frecuencia personal del doctor)",
      });
      notes.push(
        "No hay caída confirmada: la frecuencia histórica de este doctor explica el silencio. Prohibido plantearlo como reclamo o como riesgo de abandono."
      );
    } else {
      lifecycle.push({
        agent: "retention_reactivation",
        reason:
          cadence.withinOwnRhythm === false
            ? `En riesgo real: lleva ${cadence.daysSinceLastCase} días sin caso contra un intervalo propio de ${Math.round(cadence.intervalDays ?? 0)} días (${(cadence.ratio ?? 0).toFixed(1)}×)`
            : "En riesgo: el ritmo de casos cayó frente a su frecuencia histórica",
      });
      if (cadence.withinOwnRhythm === false) {
        evidence.push({
          field: "historical_case_frequency.avg_interval_days",
          value: `${cadence.daysSinceLastCase} días sin caso vs. intervalo propio de ${Math.round(cadence.intervalDays ?? 0)} días`,
          source: "cases (frecuencia personal del doctor)",
        });
      } else {
        notes.push(
          "No hay frecuencia personal suficiente para medir la caída contra el propio patrón del doctor: tratar el riesgo como hipótesis, no como hecho."
        );
      }
    }
  } else if (ctx.lifecycle === "dormido") {
    lifecycle.push({
      agent: "retention_reactivation",
      reason: "Dormido: reactivar según su punto de abandono",
    });
  } else if (
    ctx.lifecycle === "perdido" &&
    ctx.days_since_last_case !== null &&
    ctx.days_since_last_case <= 365
  ) {
    lifecycle.push({
      agent: "retention_reactivation",
      reason: "Perdido recuperable: último caso hace menos de un año",
    });
  }

  // -------------------------------------------------------------------------
  // 3. Educación clínica (normalmente handoff / apoyo)
  // -------------------------------------------------------------------------
  const clinicalOpp = assessClinicalOpportunity(ctx);
  if (clinicalOpp.tier !== null && clinicalOpp.reason !== null) {
    if (clinicalOpp.tier <= CLINICAL_TIER_ESCALATES) {
      // Nivel 1 (duda concreta o viabilidad) y nivel 3 (confianza clínica baja
      // registrada) son BLOQUEOS: el doctor no avanza hasta resolverlos, así que
      // pueden quedar primarios (orden C, antes del ciclo de vida).
      // Nivel 2 (recién acreditado) es una OPORTUNIDAD de agenda clínica:
      // acompaña la activación, no la desplaza.
      const esBloqueo = clinicalOpp.tier !== 2;
      (esBloqueo ? lifecycle : softSupport).push({
        agent: "clinical_education",
        reason: clinicalOpp.reason,
      });
      evidence.push({
        field: clinicalOpp.field,
        value: `${clinicalOpp.reason} — prioridad clínica nivel ${clinicalOpp.tier}`,
        source: "Brain 2026.08.2 · prioridad de agenda clínica",
      });
    } else {
      // Niveles 4-7: oportunidad real, pero no se ocupa agenda clínica sin una
      // ventana concreta. Queda anotada para que el agente pueda proponerla.
      notes.push(
        `Oportunidad clínica de nivel ${clinicalOpp.tier}: ${clinicalOpp.reason.toLowerCase()}. Proponer intervención clínica solo si hay una ventana concreta y nada de mayor prioridad compitiendo por la misma agenda.`
      );
      evidence.push({
        field: clinicalOpp.field,
        value: `oportunidad clínica de nivel ${clinicalOpp.tier} (no ocupa agenda clínica por sí sola)`,
        source: "Brain 2026.08.2 · prioridad de agenda clínica",
      });
    }
  }
  if (ctx.clinical_owner === null && clinicalOpp.tier !== null && clinicalOpp.tier <= CLINICAL_TIER_ESCALATES) {
    evidence.push({
      field: "doctors.clinical_owner",
      value: "sin clinical owner asignado — la derivación va al equipo clínico y corresponde proponer la asignación",
      source: "doctors",
    });
  }

  // -------------------------------------------------------------------------
  // 4/7. Hitos del universo B (0022): activación vs growth
  // -------------------------------------------------------------------------
  const ownCase = ctx.own_case_status;
  const firstPatient = ctx.first_patient_case_status;
  const secondPatient = ctx.second_patient_case_status;
  const unclassified = safeCount(ctx.cases_unclassified);

  if (ctx.is_accredited) {
    evidence.push({
      field: "own_case_status / first_patient_case_status / second_patient_case_status",
      value: `${ownCase ?? "UNKNOWN"} / ${firstPatient ?? "UNKNOWN"} / ${secondPatient ?? "UNKNOWN"}`,
      source: "cases.case_subject_type (migración 0022)",
    });
    if (ownCase === "UNKNOWN" || firstPatient === "UNKNOWN" || (unclassified ?? 0) > 0) {
      evidence.push({
        field: "cases.case_subject_type",
        value:
          unclassified !== null && unclassified > 0
            ? `tipo de caso no identificado — ${unclassified} caso(s) sin clasificar`
            : "tipo de caso no identificado",
        source: "cases.case_subject_type = UNKNOWN (pendiente de revisión humana)",
      });
      notes.push(
        "Los hitos de este doctor no están confirmados (tipo de caso no identificado): un hito desconocido NO se cuenta como cumplido."
      );
    }

    // La activación manda mientras el primer caso de paciente no esté cumplido.
    // UNKNOWN cuenta como NO cumplido — nunca como cumplido.
    if (firstPatient !== "COMPLETED") {
      const focus =
        ownCase === "NOT_STARTED"
          ? "Acreditado sin caso propio: el siguiente paso es proponerle su propio caso"
          : ownCase === "IN_PROGRESS"
            ? "Caso propio en curso: acompañarlo hasta terminarlo, sin pedir volumen"
            : ownCase === "COMPLETED"
              ? "Caso propio completado y sin primer caso de paciente: ese es el objetivo"
              : "No está identificado si tiene caso propio (casos sin clasificar): confirmarlo antes de proponer el siguiente hito";
      const estado =
        firstPatient === "UNKNOWN"
          ? "primer caso de paciente sin identificar"
          : firstPatient === "IN_PROGRESS"
            ? "primer caso de paciente en curso"
            : "sin primer caso de paciente";
      lifecycle.push({ agent: "activation", reason: `${focus} (${estado})` });
    } else if (!RETENTION_STAGES.has(ctx.lifecycle) || retentionDowngraded) {
      // Growth: el primer caso de paciente ya está cumplido y no hay caída.
      lifecycle.push({
        agent: "growth",
        reason:
          secondPatient === "COMPLETED"
            ? HEALTHY_B_STAGES.has(ctx.lifecycle)
              ? "Repetición confirmada: desarrollar ritmo, categoría y programas"
              : "Ya repitió: sostener el ritmo"
            : secondPatient === "UNKNOWN"
              ? "Primer caso de paciente cumplido; la repetición no está confirmada en los datos: asegurar el segundo caso"
              : "Primer caso de paciente cumplido: asegurar el segundo (repetición, Conversión 3)",
      });
    }
  } else if (ctx.acquisition_stage !== "no_interesado") {
    // 5. Acreditación: interés real en universo A
    if (
      ctx.acquisition_stage === "interes_acreditacion" ||
      ctx.acquisition_stage === "acreditacion_agendada"
    ) {
      lifecycle.push({
        agent: "accreditation",
        reason:
          ctx.acquisition_stage === "acreditacion_agendada"
            ? "Acreditación agendada: asegurar que se concrete"
            : "Interés en acreditarse: concretar fecha de acreditación",
      });
    } else if (
      ctx.acquisition_stage === null ||
      ACQ_EARLY_STAGES.has(ctx.acquisition_stage)
    ) {
      // 6. Adquisición: etapas tempranas del universo A
      lifecycle.push({
        agent: "acquisition",
        reason: "Prospecto en etapa temprana: construir interés real",
      });
    }
  }
  // no_interesado / perdido no recuperable sin señal ⇒ primary null

  // -------------------------------------------------------------------------
  // Calidad de datos como evidencia del ruteo
  // -------------------------------------------------------------------------
  const quality = safeQuality(ctx.interaction_data_quality);
  if (quality !== "GOOD") {
    evidence.push({
      field: "interaction_data_quality",
      value:
        quality === null
          ? "no evaluada — no se puede afirmar si hubo conversaciones reales registradas"
          : quality === "POOR"
            ? "POOR — el reloj de contacto significativo no es evidencia: ausencia de registro no es ausencia de contacto"
            : "PARTIAL — solo parte de las interacciones está calificada",
      source: "activities.engagement_quality (migración 0022)",
    });
  }
  evidence.push({
    field: "data_as_of",
    value: ctx.data_as_of,
    source: "sync_runs (watermark del último import)",
  });

  // -------------------------------------------------------------------------
  // A veces la recomendación correcta es NO contactar (Brain 2026.08.2)
  // -------------------------------------------------------------------------
  // Sin información nueva, sin urgencia y con un contacto significativo reciente,
  // volver a escribir es saturación. Se anota; la decisión la toma el agente.
  const contactoReciente =
    quality === "GOOD" &&
    typeof ctx.days_since_meaningful_contact === "number" &&
    ctx.days_since_meaningful_contact <= 2;
  const sinUrgencia =
    !service.escalates &&
    ctx.stalled_cases.length === 0 &&
    ctx.tasks.length === 0 &&
    ctx.open_recommendations.length === 0;
  if (contactoReciente && sinUrgencia) {
    notes.push(
      `Hubo un contacto significativo hace ${ctx.days_since_meaningful_contact} día(s) y no hay urgencia registrada: si no apareció información nueva ni hay algo concreto que aportar, la recomendación correcta puede ser NO contactar hoy y fijar el siguiente paso con fecha.`
    );
    evidence.push({
      field: "days_since_meaningful_contact",
      value: `${ctx.days_since_meaningful_contact} día(s) — contacto significativo reciente, sin urgencia abierta`,
      source: "activities.engagement_quality (0022)",
    });
  }

  // -------------------------------------------------------------------------
  // A. Calidad de datos · cuello de botella · confianza del ruteo
  // -------------------------------------------------------------------------
  const gate = assessDataGate(ctx, service);
  if (gate.insuficiente) {
    notes.push(
      `No hay señales duras sobre las que decidir (${gate.motivos.join("; ")}). El primer paso es conseguir el dato, no actuar sobre el vacío: proponer que se clasifique lo que falta y decir explícitamente qué no se sabe.`
    );
    evidence.push({
      field: "calidad_de_datos",
      value: `insuficiente para decidir — ${gate.motivos.join(" · ")}`,
      source: "puerta A del ruteo (Fase 3)",
    });
  }

  const bottleneck = assessBottleneck(
    ctx,
    service,
    gate,
    clinicalOpp,
    cadence,
    retentionDowngraded
  );
  const conf = assessRoutingConfidence(ctx, service, gate);
  evidence.push({
    field: "bottleneck",
    value: `${bottleneck} — ${BOTTLENECK_LABELS[bottleneck]}`,
    source: "orquestador (orden de ruteo A-G)",
  });
  if (conf.caps.length > 0) {
    notes.push(
      `Confianza del ruteo ${conf.score}/100: ${conf.caps.join("; ")}.`
    );
  }

  return finalizeRouting({
    serviceInvolvement,
    lifecycle,
    service,
    evidence,
    notes,
    dataAsOf: ctx.data_as_of ?? null,
    alwaysSupporting: softSupport,
    bottleneck,
    routingConfidence: conf.score,
    routingCaps: conf.caps,
  });
}

// ---------------------------------------------------------------------------
// routeDoctorFromRow — aproximación barata para labels de UI (sin contexto)
// ---------------------------------------------------------------------------

/**
 * Aproximación con la fila de doctors (labels de /hoy, sin armar el contexto ni
 * llamar al LLM). `serviceSeverities` permite aplicar la regla de servicio real;
 * si solo se pasa `serviceSignals` (conteo), la severidad queda SIN EVALUAR y la
 * vista rápida prioriza servicio por precaución — no oculta una señal abierta,
 * pero tampoco afirma que sea grave. El ruteo completo (`routeDoctor`) es el que
 * califica.
 */
export function routeDoctorFromRow(
  d: Pick<
    Doctor,
    | "lifecycle_stage"
    | "is_accredited"
    | "acquisition_stage"
    | "activation_stage"
    | "new_case_count"
    | "priority_bucket"
  >,
  opts?: { serviceSignals?: number; serviceSeverities?: (string | null)[] }
): RoutingResult {
  const lifecycle: AgentInvolvement[] = [];
  const evidence: RoutingEvidence[] = [];
  const notes: string[] = [];
  const severities = opts?.serviceSeverities;
  const signals = severities?.length ?? opts?.serviceSignals ?? 0;

  evidence.push({
    field: "doctors.lifecycle_stage",
    value: d.lifecycle_stage,
    source: "motor determinístico (fila de doctors)",
  });

  // 1. SERVICIO
  let maxSeverity: ServiceSeverity | null = null;
  let unqualified = 0;
  for (const s of severities ?? []) {
    const sev = normalizeSeverity(s);
    if (sev === null) unqualified++;
    else if (maxSeverity === null || SEVERITY_RANK[sev] > SEVERITY_RANK[maxSeverity]) {
      maxSeverity = sev;
    }
  }
  const escalates =
    signals > 0 &&
    (severities === undefined
      ? true // sin severidades no se puede calificar: se prioriza por precaución
      : maxSeverity !== null && SEVERITY_RANK[maxSeverity] >= SEVERITY_RANK.HIGH);
  const service: ServiceAssessment = {
    count: signals,
    maxSeverity,
    unqualified: severities === undefined ? signals : unqualified,
    impact: [],
    maxTrustRisk: null,
    confidences: [],
    escalates,
  };

  let serviceInvolvement: AgentInvolvement | null = null;
  if (signals > 0) {
    const sev = maxSeverity
      ? `severidad máxima ${SEVERITY_LABEL[maxSeverity]}`
      : "severidad no evaluada en la vista rápida";
    serviceInvolvement = {
      agent: "doctor_success",
      reason:
        signals === 1
          ? `Una señal de servicio abierta — ${sev}`
          : `${signals} señales de servicio abiertas — ${sev}`,
    };
    evidence.push({
      field: "alerts",
      value: `${signals} señal(es) de servicio abierta(s) · ${sev}`,
      source: "alerts (conteo por doctor)",
    });
    if (severities === undefined) {
      notes.push(
        "La vista rápida no recibió las severidades: no se aplicó la regla de servicio real; el ruteo completo la califica."
      );
    }
  }

  // 2. Retención / reactivación (sin contexto no se evalúa recuperabilidad de perdido)
  if (d.lifecycle_stage === "en_riesgo" || d.priority_bucket === "riesgo") {
    lifecycle.push({
      agent: "retention_reactivation",
      reason: "En riesgo: el ritmo de casos cayó",
    });
  } else if (d.lifecycle_stage === "dormido") {
    lifecycle.push({
      agent: "retention_reactivation",
      reason: "Dormido: reactivar según su punto de abandono",
    });
  }

  // 3. clinical_education requiere señales del contexto — no evaluable por fila

  if (d.is_accredited) {
    // 4. Activación: la fila NO distingue caso propio de caso de paciente
    // (case_subject_type vive en cases). new_case_count < 1 ⇒ todavía no hay
    // primer caso; con casos, el hito queda SIN IDENTIFICAR y lo resuelve
    // routeDoctor con el contexto — acá no se afirma que esté cumplido.
    if (d.new_case_count < 1) {
      lifecycle.push({
        agent: "activation",
        reason: "Acreditado sin primer caso de paciente registrado",
      });
    } else if (HEALTHY_B_STAGES.has(d.lifecycle_stage)) {
      // 7. Growth
      lifecycle.push({
        agent: "growth",
        reason:
          d.new_case_count <= 2
            ? "Desarrollo temprano: 1-2 casos"
            : "Doctor sano: desarrollar ritmo y categoría",
      });
      evidence.push({
        field: "cases.case_subject_type",
        value: "tipo de caso no identificado en la vista rápida",
        source: "fila de doctors (sin acceso a cases)",
      });
    }
  } else if (d.acquisition_stage !== "no_interesado") {
    // 5. Acreditación
    if (
      d.acquisition_stage === "interes_acreditacion" ||
      d.acquisition_stage === "acreditacion_agendada"
    ) {
      lifecycle.push({
        agent: "accreditation",
        reason: "Interés real: concretar la acreditación",
      });
    } else if (
      d.acquisition_stage === null ||
      ACQ_EARLY_STAGES.has(d.acquisition_stage)
    ) {
      // 6. Adquisición
      lifecycle.push({
        agent: "acquisition",
        reason: "Prospecto en etapa temprana: construir interés real",
      });
    }
  }

  // Esta variante NO arma el contexto: no puede calcular el cuello de botella ni
  // pretender confianza de ruteo. Se declara como aproximación para que la UI no
  // muestre un diagnóstico que nadie calculó.
  return finalizeRouting({
    serviceInvolvement,
    lifecycle,
    service,
    evidence,
    notes,
    dataAsOf: null,
    alwaysSupporting: [],
    bottleneck: "DESCONOCIDO",
    routingConfidence: 50,
    routingCaps: [
      "aproximación desde la fila del doctor, sin contexto completo: el ruteo real lo calcula routeDoctor",
    ],
  });
}

// ---------------------------------------------------------------------------
// Historial de handoffs (0026)
// ---------------------------------------------------------------------------

/**
 * Registra que un agente le pasó el doctor a otro. Es auditoría: si falla NO
 * rompe el análisis — perder la traza de un handoff es molesto, perder la
 * recomendación es peor.
 */
async function recordHandoff(h: {
  doctorId: string;
  from: AgentKey;
  to: AgentKey;
  reason: string;
  stage: string;
  bottleneck: Bottleneck;
  runId: string | null;
}): Promise<void> {
  if (h.from === h.to) return;
  try {
    const db = createAiServiceClient();
    await db.from("agent_handoffs").insert({
      doctor_id: h.doctorId,
      agent_from: h.from,
      agent_to: h.to,
      reason: h.reason,
      doctor_stage: h.stage,
      bottleneck: h.bottleneck,
      run_id: h.runId,
      outcome: "sin_evaluar",
    });
  } catch {
    /* auditoría best-effort */
  }
}

// ---------------------------------------------------------------------------
// analyzeDoctor — contexto → routing → LLM (primario + a lo sumo un segundo)
// ---------------------------------------------------------------------------

function buildAiSummary(
  ctx: DoctorContext,
  routing: RoutingResult,
  top: AgentRecommendation | null,
  caps: string[]
): string {
  const etapa = LIFECYCLE_LABELS[ctx.lifecycle] ?? ctx.lifecycle;
  const parts: string[] = [
    `${ctx.name} está en etapa ${etapa}${ctx.is_accredited ? " (acreditado)" : " (no acreditado)"}.`,
  ];
  if (routing.primary) {
    parts.push(`Señal principal: ${routing.primary.reason.toLowerCase()}.`);
  } else {
    parts.push("Sin señales que requieran acción comercial ahora.");
  }
  if (routing.supporting.length > 0) {
    parts.push(
      `Acompañan: ${routing.supporting.map((s) => AGENT_LABELS[s.agent]).join(", ")}.`
    );
  }
  if (top) parts.push(`Próximo paso sugerido: ${top.recommended_action}`);
  if (caps.length > 0) parts.push(`Límite de los datos: ${caps[0]}`);
  return parts.join(" ");
}

function analysisInstruction(
  role: "PRIMARIO" | "DE APOYO",
  reason: string,
  routing: RoutingResult,
  caps: string[]
): string {
  const lines = [
    "",
    "---",
    "Instrucción: analiza a este doctor con el contexto de arriba.",
    `El router determinístico te asignó como agente ${role} porque: ${reason}.`,
    `Decisión de ruteo: ${routing.routing_reason}`,
    "Evidencia del ruteo (hechos, no interpretaciones):",
    ...routing.routing_evidence.map(
      (e) => `- ${e.field} = ${e.value} (fuente: ${e.source})`
    ),
  ];
  if (caps.length > 0) {
    lines.push(
      "LÍMITES DE LOS DATOS — no los ignores. Si un límite te impide afirmar algo, dilo explícitamente (\"no está registrado\", \"con los datos actuales no se puede saber\") y baja tu `confidence`. Nunca completes un hueco con una suposición:",
      ...caps.map((c) => `- ${c}`)
    );
  }
  lines.push(
    "Si te faltan datos puntuales usa tus tools; al final emite 1 a 3 recomendaciones con la tool `emit`."
  );
  return lines.join("\n");
}

export async function analyzeDoctor(
  doctorId: string,
  opts: { requestedBy: string | null; trigger: AgentRunTrigger }
): Promise<OrchestratorAssessment> {
  const started = Date.now();
  const ctx = await buildDoctorContext(doctorId);
  const routing = routeDoctor(ctx);
  const contextBlock = contextToPromptBlock(ctx);

  // Confianza que soportan los datos: se pasa a cada corrida para que la
  // recomendación persistida quede con confianza global = min(modelo, datos).
  const data = dataConfidence(ctx);
  const supportingAgents = routing.supporting.map((s) => s.agent);
  const runRouting = {
    primary_agent: routing.primary?.agent ?? null,
    supporting_agents: supportingAgents as string[],
    routing_reason: routing.routing_reason,
    routing_evidence: routing.routing_evidence,
  };
  const runDataQuality = {
    score: data.score,
    caps: data.caps,
    interaction_data_quality: safeQuality(ctx.interaction_data_quality),
    cases_unclassified: safeCount(ctx.cases_unclassified),
    data_as_of: ctx.data_as_of,
  };

  const recommendations: AgentRecommendation[] = [];

  if (routing.primary) {
    const primaryRun = await runAgentLLM(routing.primary.agent, {
      trigger: opts.trigger,
      requestedBy: opts.requestedBy,
      doctorId,
      userMessage:
        contextBlock +
        analysisInstruction("PRIMARIO", routing.primary.reason, routing, data.caps),
      routing: runRouting,
      dataQuality: runDataQuality,
      bottleneck: routing.bottleneck,
      triggerReason: opts.trigger,
    });
    recommendations.push(...primaryRun.recommendations);

    // Segundo run (máx 2 corridas LLM): doctor_success o clinical_education
    // involucrados pero NO primarios.
    const secondary = routing.supporting.find(
      (i) => i.agent === "doctor_success" || i.agent === "clinical_education"
    );
    if (secondary) {
      const secondaryRun = await runAgentLLM(secondary.agent, {
        trigger: opts.trigger,
        requestedBy: opts.requestedBy,
        doctorId,
        userMessage:
          contextBlock +
          analysisInstruction("DE APOYO", secondary.reason, routing, data.caps),
        routing: runRouting,
        dataQuality: runDataQuality,
        bottleneck: routing.bottleneck,
        triggerReason: opts.trigger,
      });
      recommendations.push(...secondaryRun.recommendations);

      // El handoff queda registrado: quién le pasó el doctor a quién y por qué.
      // Es lo que después permite medir si la intervención clínica desbloqueó
      // la activación, o si servicio devolvió al doctor sano al ciclo comercial.
      await recordHandoff({
        doctorId,
        from: routing.primary.agent,
        to: secondary.agent,
        reason: secondary.reason,
        stage: ctx.lifecycle,
        bottleneck: routing.bottleneck,
        runId: secondaryRun.runId ?? null,
      });
    }
  }

  const top =
    [...recommendations].sort(
      (a, b) => b.commercial_priority - a.commercial_priority
    )[0] ?? null;

  // OJO: top.confidence ya viene combinada desde el runner (min(modelo, datos)).
  // Acá solo se reusan los caps para que el resumen diga qué limitó la confianza.
  const assessment: OrchestratorAssessment = {
    doctor_id: doctorId,
    ai_summary: buildAiSummary(ctx, routing, top, data.caps),
    situation:
      top?.situation ??
      routing.primary?.reason ??
      "Sin señales que requieran acción comercial ahora.",
    // routing.primary null (no_interesado / perdido no recuperable) ⇒ el
    // assessment queda a nombre del orquestador, sin recomendaciones.
    primary_agent: routing.primary?.agent ?? "orchestrator",
    involvements: routing.involvements.map((i) => ({
      agent: i.agent as AgentKey,
      reason: i.reason,
    })),
    recommendations,
    routing_reason: routing.routing_reason,
    supporting_agents: supportingAgents as AgentKey[],
    routing_evidence: routing.routing_evidence,
    data_quality: { data_confidence: data.score, caps: data.caps },
  };

  // Corrida sintética del orchestrator (sin tokens) para re-mostrar en UI y para
  // auditar el ruteo aunque no haya corrido ningún agente.
  const supabase = createAiServiceClient();
  await supabase.from("agent_runs").insert({
    agent: "orchestrator",
    doctor_id: doctorId,
    trigger: opts.trigger,
    requested_by: opts.requestedBy,
    model_version: AI_MODEL,
    brain_version: BRAIN_VERSION,
    status: "ok",
    error: null,
    latency_ms: Date.now() - started,
    input_tokens: null,
    output_tokens: null,
    tools_called: [],
    recommendation_ids: [],
    result: assessment as unknown as Record<string, unknown>,
    primary_agent: runRouting.primary_agent,
    supporting_agents: runRouting.supporting_agents,
    routing_reason: runRouting.routing_reason,
    routing_evidence: runRouting.routing_evidence,
    data_quality: runDataQuality,
  });

  return assessment;
}

// Escenarios sintéticos de evaluación del ruteo (Módulo F).
//
// NO consumen tokens, NO tocan la base y NO llaman al modelo: son DoctorContext
// armados a mano para poder preguntarle al router determinístico "¿qué agente
// interviene y por qué?" y comparar contra lo que el negocio espera.
//
// Contrato: se escriben contra el DoctorContext real de lib/ai/types.ts (cadena
// de hitos de 0022: ACREDITADO → CASO PROPIO → 1er CASO DE PACIENTE → 2º, con
// MilestoneStatus e interaction_data_quality). Los contextos se arman con una
// fábrica base + overrides para que el archivo se pueda leer.
//
// Regla del harness: un escenario sintético NO puede contener datos
// contradictorios entre sí (p.ej. service_issues cargados y trust_risk_score en
// null). Los campos derivados los calcula la fábrica.

import { todayMX } from "@/lib/dates";
import type {
  AgentKey,
  DoctorContext,
  InteractionDataQuality,
  MilestoneStatus,
  SecondCaseStatus,
  ServiceConfidence,
  ServiceIssue,
  ServiceSeverity,
} from "@/lib/ai/types";

// Vocabulario del contrato, re-exportado para que el harness y el CLI no tengan
// que importar de dos lugares.
export type {
  InteractionDataQuality,
  MilestoneStatus,
  SecondCaseStatus,
  ServiceConfidence,
  ServiceIssue,
  ServiceSeverity,
};

/** El contexto que consumen los escenarios ES el DoctorContext real. El alias
 *  queda por legibilidad y para marcar la frontera del harness. */
export type EvalDoctorContext = DoctorContext;

/** Agentes que el router puede elegir (orchestrator sintetiza; al director solo
 *  lo invoca el manager). */
export type RoutableAgent = Exclude<AgentKey, "orchestrator" | "commercial_director">;

/** Familia de próxima acción esperada — no es el texto exacto (eso lo escribe el
 *  modelo), es la CLASE de acción que corresponde a la situación. */
export type NextActionCategory =
  | "contacto_exploratorio"
  | "agendar_acreditacion"
  | "impulsar_caso_propio"
  | "acompanar_caso"
  | "solicitar_viabilidad"
  | "revision_clinica"
  | "destrabar_servicio"
  | "contacto_retencion"
  | "reactivacion"
  | "plan_de_crecimiento"
  | "avanzar_oportunidad"
  | "verificar_datos"
  | "generar_demanda"
  | "esperar_sin_contactar"
  | "sin_accion";

export interface EvalScenario {
  id: string;
  nombre: string;
  context: EvalDoctorContext;
  expected_primary: RoutableAgent | null;
  expected_supporting: RoutableAgent[];
  /** Qué debería estar tratando de lograr el agente, en una línea. */
  expected_objective: string;
  /** Lo que la respuesta NUNCA puede hacer con este contexto. */
  forbidden: string[];
  expected_next_action_category: NextActionCategory;
}

// ---------------------------------------------------------------------------
// Fábrica de contextos
// ---------------------------------------------------------------------------

const TODAY = todayMX();

function daysAgo(n: number): string {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function isoAgo(n: number): string {
  return `${daysAgo(n)}T15:00:00.000Z`;
}

export function makeServiceIssue(
  o: Pick<ServiceIssue, "severity"> & Partial<ServiceIssue>
): ServiceIssue {
  const riesgoPorSeveridad: Record<ServiceSeverity, number> = {
    CRITICAL: 92,
    HIGH: 74,
    MEDIUM: 38,
    LOW: 14,
    INFORMATIONAL: 4,
  };
  return {
    kind: o.kind ?? "alerta",
    detail: o.detail ?? "Problema de servicio abierto",
    since: o.since ?? isoAgo(9),
    severity: o.severity,
    confidence: o.confidence ?? "LIKELY",
    trust_risk_score: o.trust_risk_score ?? riesgoPorSeveridad[o.severity],
    impact_factors: o.impact_factors ?? [],
    source: o.source ?? (o.confidence === "CONFIRMED" ? "alerta_revisada" : "derivado"),
    alert_severity: o.alert_severity ?? null,
    rule_key: o.rule_key ?? null,
  };
}

/** Base: prospecto frío, sin señales de nada. Todo escenario parte de acá. */
function baseContext(): EvalDoctorContext {
  return {
    doctor_id: "00000000-0000-4000-8000-000000000000",
    name: "Dr. Base",
    city: "Guadalajara",
    zona: "Occidente",
    clinic: "Clínica Base",
    phone: "+52 33 0000 0000",
    whatsapp: "+52 33 0000 0000",
    owner: "Juan",
    clinical_owner: null,
    categoria: "SIN_CATEGORIA",
    lifecycle: "prospecto",
    is_accredited: false,
    acquisition_stage: "contactado",
    activation_stage: null,
    accreditation_status: "no acreditado",
    accreditation_date: null,
    days_since_accreditation: null,
    // ---- cadena de hitos ----
    own_case_status: "UNKNOWN",
    own_case_id: null,
    own_case_started_at: null,
    own_case_completed_at: null,
    first_patient_case_status: "UNKNOWN",
    first_patient_case_id: null,
    first_patient_case_started_at: null,
    first_patient_case_paid_at: null,
    first_patient_case_paid_source: null,
    first_patient_case_date: null,
    second_patient_case_status: "UNKNOWN",
    second_patient_case_date: null,
    days_accreditation_to_own_case: null,
    days_own_case_to_first_patient: null,
    days_first_to_second_patient: null,
    cases_unclassified: 0,
    payments_count: 0,
    first_payment_at: null,
    // ---- casos ----
    cases_total: 0,
    cases_30d: 0,
    cases_90d: 0,
    historical_case_frequency: {
      avg_interval_days: null,
      expected_next_case_at: null,
      confidence: "insuficiente",
    },
    days_since_last_case: null,
    open_cases: 0,
    stalled_cases: [],
    open_opportunities: [],
    // ---- contacto ----
    last_meaningful_contact: null,
    days_since_meaningful_contact: null,
    interaction_data_quality: "POOR",
    engagement_unknown_count: 0,
    engagement_classified_count: 0,
    last_touch: null,
    // ---- scores ----
    next_action: null,
    priority: { score: 30, bucket: "nuevo_negocio", reasons: [] },
    health: { score: null, confidence: null },
    potential_score: 40,
    tasks: [],
    competitors: [],
    aligner_experience: null,
    clinical_confidence: "desconocida",
    main_objection: null,
    lead_source: "ventas",
    notes_summary: null,
    relationship_summary: null,
    recent_activity: [],
    training_history: [],
    keepday_history: [],
    kos_status: null,
    campaign_history: [],
    known_commitments: [],
    service_issues: [],
    trust_risk_score: null,
    service_summary: "Sin problemas de servicio detectados",
    wa_channel: null,
    ai_profile: null,
    open_recommendations: [],
    data_as_of: TODAY,
  };
}

/** Deriva lo que NO puede quedar a mano del autor del escenario, para que no
 *  existan contextos internamente contradictorios. */
function withDerived(ctx: EvalDoctorContext): EvalDoctorContext {
  const issues = ctx.service_issues;
  const trust = issues.length === 0 ? null : Math.max(...issues.map((i) => i.trust_risk_score));
  const peor = issues.length === 0 ? null : issues.reduce((a, b) => (b.trust_risk_score > a.trust_risk_score ? b : a));
  return {
    ...ctx,
    trust_risk_score: trust,
    service_summary:
      peor === null
        ? "Sin problemas de servicio detectados"
        : `${issues.length} problema(s) de servicio · peor: ${peor.severity} (${peor.confidence}, riesgo ${peor.trust_risk_score})`,
  };
}

export function makeContext(overrides: Partial<EvalDoctorContext> = {}): EvalDoctorContext {
  return withDerived({ ...baseContext(), ...overrides });
}

/** Acreditado con historial de interacción utilizable — base del universo B. */
export function makeAccredited(
  overrides: Partial<EvalDoctorContext> = {}
): EvalDoctorContext {
  return makeContext({
    is_accredited: true,
    acquisition_stage: "acreditado",
    activation_stage: "acreditado",
    accreditation_status: "acreditado",
    accreditation_date: daysAgo(120),
    days_since_accreditation: 120,
    lifecycle: "acreditado",
    own_case_status: "NOT_STARTED",
    first_patient_case_status: "NOT_STARTED",
    second_patient_case_status: "NOT_STARTED",
    interaction_data_quality: "GOOD",
    engagement_classified_count: 14,
    engagement_unknown_count: 1,
    last_meaningful_contact: isoAgo(12),
    days_since_meaningful_contact: 12,
    last_touch: isoAgo(4),
    priority: { score: 55, bucket: "activacion", reasons: [] },
    health: { score: 50, confidence: "cohort" },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Prohibiciones reutilizables
// ---------------------------------------------------------------------------

const NO_DESCUENTO = "inventar un descuento o condición comercial no configurada";
const NO_VIABILIDAD = "afirmar que el caso es viable (o que no lo es)";
const NO_INACTIVIDAD_POOR =
  "afirmar inactividad o falta de contacto con interaction_data_quality POOR";
const NO_CASO_PROPIO_COMO_PACIENTE =
  "tratar el caso propio del doctor como su primer caso de paciente";
const NO_UNKNOWN_COMO_HITO =
  "tratar un caso UNKNOWN como primer caso de paciente cumplido";
const NO_PEDIR_VOLUMEN = "pedir volumen antes del primer caso de paciente";
const NO_DENIGRAR = "denigrar a la competencia";
const NO_INVENTAR_NUMEROS = "inventar números que no están en el contexto";

// ---------------------------------------------------------------------------
// Los 20 escenarios
// ---------------------------------------------------------------------------

export const SCENARIOS: EvalScenario[] = [
  // --- Universo A -----------------------------------------------------------
  {
    id: "A1_prospecto_frio",
    nombre: "Prospecto frío no acreditado",
    context: makeContext({
      name: "Dra. Frío",
      lifecycle: "contactado",
      acquisition_stage: "contactado",
      potential_score: 35,
      interaction_data_quality: "POOR",
      engagement_unknown_count: 3,
    }),
    expected_primary: "acquisition",
    expected_supporting: [],
    expected_objective:
      "Entender su realidad clínica y despertar interés real; todavía no hay nada que vender.",
    forbidden: [
      NO_DESCUENTO,
      NO_INACTIVIDAD_POOR,
      "hablar de acreditación como si ya hubiera interés",
    ],
    expected_next_action_category: "contacto_exploratorio",
  },
  {
    id: "A2_prospecto_alto_potencial",
    nombre: "Prospecto no acreditado de alto potencial",
    context: makeContext({
      name: "Dra. Potencial",
      lifecycle: "calificacion",
      acquisition_stage: "calificado",
      potential_score: 88,
      priority: { score: 78, bucket: "nuevo_negocio", reasons: [] },
      interaction_data_quality: "PARTIAL",
      engagement_classified_count: 2,
      engagement_unknown_count: 6,
      last_touch: isoAgo(6),
      notes_summary: "[2026-06-02] Consultorio grande, 3 sillones, ve muchos pacientes.",
    }),
    expected_primary: "acquisition",
    expected_supporting: [],
    expected_objective:
      "Priorizar el contacto por potencial y llevarlo a una videollamada de descubrimiento.",
    forbidden: [
      NO_DESCUENTO,
      NO_INVENTAR_NUMEROS,
      "tratarlo como acreditado o pedirle casos",
    ],
    expected_next_action_category: "contacto_exploratorio",
  },
  {
    id: "A3_interesado_en_acreditarse",
    nombre: "Prospecto interesado en acreditarse",
    context: makeContext({
      name: "Dr. Interesado",
      lifecycle: "interes_acreditacion",
      acquisition_stage: "interes_acreditacion",
      potential_score: 62,
      interaction_data_quality: "GOOD",
      engagement_classified_count: 5,
      last_meaningful_contact: isoAgo(5),
      days_since_meaningful_contact: 5,
      last_touch: isoAgo(2),
    }),
    expected_primary: "accreditation",
    expected_supporting: [],
    expected_objective: "Convertir el interés en una fecha concreta de acreditación (C1).",
    forbidden: [NO_DESCUENTO, "dar por acreditado a quien todavía no lo está"],
    expected_next_action_category: "agendar_acreditacion",
  },

  // --- Activación (universo B, cadena de hitos) -----------------------------
  {
    id: "B1_recien_acreditado_sin_caso_propio",
    nombre: "Recién acreditado sin caso propio",
    context: makeAccredited({
      name: "Dra. Recién",
      lifecycle: "en_activacion",
      accreditation_date: daysAgo(21),
      days_since_accreditation: 21,
      own_case_status: "NOT_STARTED",
      first_patient_case_status: "NOT_STARTED",
      second_patient_case_status: "NOT_STARTED",
    }),
    expected_primary: "activation",
    // Brain 2026.08.2 §11: recién acreditado con posibilidad real de caso propio /
    // primer paciente = prioridad clínica nivel 2. Clínica acompaña, no desplaza.
    expected_supporting: ["clinical_education"],
    expected_objective:
      "Construir confianza en la técnica arrancando su caso propio; nunca pedir volumen.",
    forbidden: [NO_PEDIR_VOLUMEN, NO_DESCUENTO, NO_UNKNOWN_COMO_HITO],
    expected_next_action_category: "impulsar_caso_propio",
  },
  {
    id: "B2_caso_propio_en_curso",
    nombre: "Caso propio en curso",
    context: makeAccredited({
      name: "Dr. Propio",
      lifecycle: "en_activacion",
      activation_stage: "caso_ingresado",
      own_case_status: "IN_PROGRESS",
      own_case_id: "aaaaaaaa-0000-4000-8000-000000000001",
      own_case_started_at: daysAgo(25),
      days_accreditation_to_own_case: 95,
      first_patient_case_status: "NOT_STARTED",
      second_patient_case_status: "NOT_STARTED",
      open_cases: 1,
      cases_total: 0,
    }),
    expected_primary: "activation",
    // Brain 2026.08.2 §11: recién acreditado con posibilidad real de caso propio /
    // primer paciente = prioridad clínica nivel 2. Clínica acompaña, no desplaza.
    expected_supporting: ["clinical_education"],
    expected_objective:
      "Acompañar el caso propio hasta que lo viva completo; ese es el hito, no el volumen.",
    forbidden: [
      NO_CASO_PROPIO_COMO_PACIENTE,
      NO_PEDIR_VOLUMEN,
      // El caso propio SÍ suma como caso (criterio de Pancho, 9/8/26): lo que no
      // es, es la Conversión 2.
      "dar por cumplida la Conversión 2 con el caso propio",
    ],
    expected_next_action_category: "acompanar_caso",
  },
  {
    id: "B3_caso_propio_completo_sin_paciente",
    nombre: "Caso propio completo sin caso de paciente",
    context: makeAccredited({
      name: "Dra. Puente",
      lifecycle: "activado",
      activation_stage: "presentado",
      own_case_status: "COMPLETED",
      own_case_id: "aaaaaaaa-0000-4000-8000-000000000002",
      own_case_started_at: daysAgo(140),
      own_case_completed_at: daysAgo(30),
      days_accreditation_to_own_case: 40,
      first_patient_case_status: "NOT_STARTED",
      second_patient_case_status: "NOT_STARTED",
      cases_total: 0,
      open_cases: 0,
    }),
    expected_primary: "activation",
    // Brain 2026.08.2 §11: recién acreditado con posibilidad real de caso propio /
    // primer paciente = prioridad clínica nivel 2. Clínica acompaña, no desplaza.
    expected_supporting: ["clinical_education"],
    expected_objective:
      "Traducir la experiencia del caso propio en el primer paciente real (C2).",
    forbidden: [
      NO_CASO_PROPIO_COMO_PACIENTE,
      "afirmar que ya activó",
      NO_DESCUENTO,
    ],
    expected_next_action_category: "acompanar_caso",
  },
  {
    id: "B4_primer_caso_paciente_activo",
    nombre: "Primer caso de paciente activo",
    context: makeAccredited({
      name: "Dr. Primero",
      lifecycle: "activado",
      activation_stage: "caso_ingresado",
      own_case_status: "COMPLETED",
      own_case_id: "aaaaaaaa-0000-4000-8000-000000000003",
      own_case_completed_at: daysAgo(60),
      first_patient_case_status: "IN_PROGRESS",
      first_patient_case_id: "bbbbbbbb-0000-4000-8000-000000000001",
      first_patient_case_started_at: daysAgo(18),
      first_patient_case_date: daysAgo(18),
      days_own_case_to_first_patient: 42,
      second_patient_case_status: "NOT_STARTED",
      cases_total: 1,
      cases_30d: 1,
      cases_90d: 1,
      days_since_last_case: 18,
      open_cases: 1,
    }),
    expected_primary: "activation",
    // Brain 2026.08.2 §11: recién acreditado con posibilidad real de caso propio /
    // primer paciente = prioridad clínica nivel 2. Clínica acompaña, no desplaza.
    expected_supporting: ["clinical_education"],
    expected_objective:
      "Que el primer paciente llegue bien a destino: es la prueba de confianza que define la relación.",
    forbidden: [
      NO_PEDIR_VOLUMEN,
      "dar por cerrado el hito antes de que el caso termine",
      NO_UNKNOWN_COMO_HITO,
    ],
    expected_next_action_category: "acompanar_caso",
  },

  // --- Clínica --------------------------------------------------------------
  {
    id: "C1_dos_casos_incertidumbre_clinica",
    nombre: "Doctor con 2 casos e incertidumbre clínica",
    context: makeAccredited({
      name: "Dra. Dudas",
      lifecycle: "activo",
      activation_stage: "primer_caso_pagado",
      own_case_status: "COMPLETED",
      own_case_completed_at: daysAgo(200),
      first_patient_case_status: "COMPLETED",
      first_patient_case_id: "bbbbbbbb-0000-4000-8000-000000000002",
      first_patient_case_started_at: daysAgo(150),
      first_patient_case_paid_at: daysAgo(145),
      first_patient_case_paid_source: "ledger_caso",
      first_patient_case_date: daysAgo(150),
      second_patient_case_status: "COMPLETED",
      second_patient_case_date: daysAgo(26),
      days_first_to_second_patient: 124,
      payments_count: 2,
      first_payment_at: daysAgo(145),
      cases_total: 2,
      cases_90d: 1,
      days_since_last_case: 26,
      open_cases: 1,
      clinical_confidence: "baja",
      main_objection: "No se anima con casos que necesitan extracciones",
      historical_case_frequency: {
        avg_interval_days: 124,
        expected_next_case_at: daysAgo(-98),
        confidence: "insuficiente",
      },
    }),
    expected_primary: "clinical_education",
    expected_supporting: ["growth"],
    expected_objective:
      "Bajar la inseguridad técnica con revisión clínica y viabilidades; el volumen viene después.",
    forbidden: [NO_VIABILIDAD, "opinar sobre un caso sin el equipo clínico", NO_DESCUENTO],
    expected_next_action_category: "revision_clinica",
  },
  {
    id: "C2_pregunta_por_paciente_concreto",
    nombre: "Doctor preguntando si un paciente concreto es apto",
    context: makeAccredited({
      name: "Dr. Consulta",
      lifecycle: "activo",
      activation_stage: "primer_caso_pagado",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(300),
      first_patient_case_paid_source: "ledger_doctor",
      second_patient_case_status: "COMPLETED",
      payments_count: 5,
      first_payment_at: daysAgo(300),
      cases_total: 5,
      cases_90d: 2,
      days_since_last_case: 34,
      open_opportunities: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          patient_name: "Paciente M.",
          stage: "viabilidad",
          days_in_stage: 6,
          probability: 30,
          amount_mxn: 32000,
        },
      ],
      main_objection: "Pregunta si una mordida abierta se puede con alineadores",
    }),
    expected_primary: "clinical_education",
    expected_supporting: ["growth"],
    expected_objective:
      "Canalizar la pregunta como solicitud formal de viabilidad al equipo clínico y responder con evidencia.",
    forbidden: [
      NO_VIABILIDAD,
      "prometer un plazo de respuesta clínica que no está configurado",
      NO_INVENTAR_NUMEROS,
    ],
    expected_next_action_category: "solicitar_viabilidad",
  },

  // --- Growth / servicio ----------------------------------------------------
  {
    id: "G1_activo_sano_alto_potencial",
    nombre: "Doctor activo sano de alto potencial",
    context: makeAccredited({
      name: "Dra. Sana",
      lifecycle: "activo",
      categoria: "GOLD",
      activation_stage: "primer_caso_pagado",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(420),
      first_patient_case_paid_source: "ledger_caso",
      second_patient_case_status: "COMPLETED",
      payments_count: 11,
      first_payment_at: daysAgo(420),
      cases_total: 11,
      cases_30d: 2,
      cases_90d: 5,
      days_since_last_case: 14,
      open_cases: 3,
      potential_score: 86,
      health: { score: 78, confidence: "personal" },
      priority: { score: 66, bucket: "growth", reasons: [] },
      historical_case_frequency: {
        avg_interval_days: 18,
        expected_next_case_at: daysAgo(-4),
        confidence: "personal",
      },
    }),
    expected_primary: "growth",
    expected_supporting: [],
    expected_objective:
      "Pasar de casos sueltos a ritmo sostenido con la palanca clínica y de categoría.",
    forbidden: [NO_DESCUENTO, NO_INVENTAR_NUMEROS],
    expected_next_action_category: "plan_de_crecimiento",
  },
  {
    id: "S1_activo_problema_servicio_grave",
    nombre: "Doctor activo con problema de servicio grave",
    context: makeAccredited({
      name: "Dr. Trabado",
      lifecycle: "activo",
      categoria: "PLATINUM",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(500),
      first_patient_case_paid_source: "ledger_caso",
      second_patient_case_status: "COMPLETED",
      payments_count: 14,
      cases_total: 14,
      cases_30d: 1,
      cases_90d: 4,
      days_since_last_case: 22,
      open_cases: 4,
      service_issues: [
        makeServiceIssue({
          severity: "CRITICAL",
          confidence: "CONFIRMED",
          trust_risk_score: 92,
          detail: "Caso KS-4412 atrasado 34 días con el paciente ya citado",
          since: isoAgo(34),
          impact_factors: ["dias_atraso", "sla_incumplido", "paciente_afectado"],
          source: "alerta_revisada",
          alert_severity: "critica",
          rule_key: "caso_atrasado",
        }),
        makeServiceIssue({
          severity: "HIGH",
          confidence: "CONFIRMED",
          kind: "caso_estancado",
          trust_risk_score: 74,
          detail: "Caso KS-4470: video sin aprobar hace 19 días",
          since: isoAgo(19),
          impact_factors: ["caso_bloqueado", "pedido_sin_responder"],
          source: "alerta_revisada",
          rule_key: "aprobacion_pendiente",
        }),
      ],
      stalled_cases: [
        {
          case_id: "22222222-2222-4222-8222-222222222222",
          label: "KS-4470",
          etapa: "video",
          issue: "video sin aprobar hace 19 días",
          days_stalled: 19,
        },
      ],
    }),
    expected_primary: "doctor_success",
    expected_supporting: ["growth"],
    expected_objective:
      "Destrabar el caso y recuperar la confianza ANTES de cualquier objetivo comercial.",
    forbidden: [
      "proponer crecimiento antes de resolver el problema",
      NO_DESCUENTO,
      "prometer una fecha de entrega que no está en los datos",
    ],
    expected_next_action_category: "destrabar_servicio",
  },
  {
    id: "S2_activo_alerta_servicio_menor",
    nombre: "Doctor activo con alerta de servicio menor",
    context: makeAccredited({
      name: "Dra. Menor",
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(380),
      first_patient_case_paid_source: "ledger_caso",
      second_patient_case_status: "COMPLETED",
      payments_count: 9,
      cases_total: 9,
      cases_30d: 2,
      cases_90d: 4,
      days_since_last_case: 11,
      open_cases: 2,
      potential_score: 71,
      service_issues: [
        makeServiceIssue({
          severity: "LOW",
          confidence: "POSSIBLE",
          trust_risk_score: 14,
          detail: "Oportunidad estancada 9 días en presentada",
          impact_factors: ["problema_administrativo"],
          source: "derivado",
          rule_key: "oportunidad_estancada",
        }),
      ],
    }),
    expected_primary: "growth",
    expected_supporting: ["doctor_success"],
    expected_objective:
      "Seguir el plan de crecimiento y resolver la fricción menor de paso, sin dramatizarla.",
    forbidden: [
      "tratar una alerta menor como crisis de servicio",
      NO_DESCUENTO,
      "afirmar que el doctor está molesto sin registro",
    ],
    expected_next_action_category: "plan_de_crecimiento",
  },

  // --- Retención / reactivación --------------------------------------------
  {
    id: "R1_caida_de_ritmo",
    nombre: "Doctor históricamente activo con caída de ritmo",
    context: makeAccredited({
      name: "Dr. Caída",
      lifecycle: "en_riesgo",
      categoria: "GOLD",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(700),
      first_patient_case_paid_source: "ledger_caso",
      second_patient_case_status: "COMPLETED",
      payments_count: 22,
      cases_total: 22,
      cases_30d: 0,
      cases_90d: 1,
      days_since_last_case: 74,
      open_cases: 1,
      health: { score: 38, confidence: "personal" },
      priority: { score: 81, bucket: "riesgo", reasons: [] },
      historical_case_frequency: {
        avg_interval_days: 19,
        expected_next_case_at: daysAgo(55),
        confidence: "personal",
      },
      interaction_data_quality: "GOOD",
      engagement_classified_count: 22,
      last_meaningful_contact: isoAgo(41),
      days_since_meaningful_contact: 41,
    }),
    expected_primary: "retention_reactivation",
    expected_supporting: [],
    expected_objective:
      "Entender con curiosidad qué cambió antes de que la caída se vuelva abandono.",
    forbidden: [
      "reclamarle la baja de casos",
      "asumir la causa de la caída sin dato",
      NO_DESCUENTO,
    ],
    expected_next_action_category: "contacto_retencion",
  },
  {
    id: "R2_dormido_falta_pacientes",
    nombre: "Dormido por falta de pacientes",
    context: makeAccredited({
      name: "Dra. Dormida",
      lifecycle: "dormido",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(600),
      first_patient_case_paid_source: "ledger_doctor",
      second_patient_case_status: "COMPLETED",
      payments_count: 4,
      cases_total: 4,
      cases_90d: 0,
      days_since_last_case: 168,
      health: { score: 21, confidence: "cohort" },
      priority: { score: 58, bucket: "riesgo", reasons: [] },
      interaction_data_quality: "PARTIAL",
      engagement_classified_count: 3,
      engagement_unknown_count: 11,
      last_meaningful_contact: isoAgo(120),
      days_since_meaningful_contact: 120,
      ai_profile: {
        doctor_id: "00000000-0000-4000-8000-000000000000",
        experience_with_aligners: null,
        clinical_confidence: "media",
        main_concerns: "No le llegan pacientes que pidan alineadores",
        preferred_contact_style: null,
        business_goals: null,
        growth_ambition: null,
        known_objections: null,
        competitor_relationship: null,
        previous_bad_experiences: null,
        relationship_notes: null,
        team_readiness: null,
        patient_acquisition_problem: "Poca demanda de estética en su zona",
        education_needs: null,
        updated_by: null,
        updated_at: isoAgo(60),
        last_source: "humano",
      },
    }),
    expected_primary: "retention_reactivation",
    expected_supporting: [],
    expected_objective:
      "Reactivar por el punto de abandono real: ayudarlo a generar demanda, no reclamarle casos.",
    forbidden: [
      "asumir que se fue por una falla de servicio",
      NO_DESCUENTO,
      "presionar con metas de volumen",
    ],
    expected_next_action_category: "reactivacion",
  },
  {
    id: "R3_dormido_por_confianza_tecnica",
    nombre: "Dormido por confianza en la técnica",
    context: makeAccredited({
      name: "Dr. Inseguro",
      lifecycle: "dormido",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(210),
      first_patient_case_paid_source: "ledger_caso",
      second_patient_case_status: "NOT_STARTED",
      payments_count: 1,
      cases_total: 1,
      cases_90d: 0,
      days_since_last_case: 195,
      clinical_confidence: "baja",
      main_objection: "Le costó el primer caso, siente que no domina la técnica",
      interaction_data_quality: "PARTIAL",
      engagement_classified_count: 2,
      engagement_unknown_count: 9,
      last_meaningful_contact: isoAgo(150),
      days_since_meaningful_contact: 150,
    }),
    // Fase 3 §20 (reactivación por causa: TÉCNICA → agente clínico) + §29 (orden
    // de ruteo: el bloqueo clínico va ANTES que retención). Acá la causa NO es una
    // hipótesis: está registrada (clinical_confidence=baja + objeción explícita),
    // así que ya no hace falta "entender qué pasó" — hace falta resolverlo, y eso
    // es clínico. Retención acompaña para cuidar el tono de la reapertura.
    expected_primary: "clinical_education",
    expected_supporting: ["retention_reactivation"],
    expected_objective:
      "Reactivar resolviendo la inseguridad técnica: la puerta de vuelta es clínica, no comercial.",
    forbidden: [
      NO_VIABILIDAD,
      "atribuir el abandono a precio sin evidencia",
      NO_DESCUENTO,
    ],
    expected_next_action_category: "reactivacion",
  },
  {
    id: "R4_usando_competencia_con_exito",
    nombre: "Doctor usando competencia con éxito",
    context: makeAccredited({
      name: "Dra. Competencia",
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(340),
      first_patient_case_paid_source: "ledger_caso",
      second_patient_case_status: "COMPLETED",
      payments_count: 6,
      cases_total: 6,
      cases_30d: 0,
      cases_90d: 1,
      days_since_last_case: 58,
      competitors: ["Invisalign", "Aliwell"],
      potential_score: 79,
      relationship_summary:
        "Trabaja la mayoría de sus casos con otra marca y está conforme con el resultado.",
    }),
    expected_primary: "growth",
    expected_supporting: [],
    expected_objective:
      "Complementarse, no desplazar: encontrar el espacio donde KeepSmiling suma a lo que ya hace.",
    forbidden: [
      NO_DENIGRAR,
      "comparar precios contra la competencia sin dato configurado",
      NO_DESCUENTO,
    ],
    expected_next_action_category: "plan_de_crecimiento",
  },

  // --- Calidad de datos -----------------------------------------------------
  {
    id: "D1_historial_actividad_incompleto",
    nombre: "Doctor con historial de actividad incompleto",
    context: makeAccredited({
      name: "Dr. Sin Registro",
      lifecycle: "activo",
      own_case_status: "UNKNOWN",
      first_patient_case_status: "UNKNOWN",
      second_patient_case_status: "UNKNOWN",
      cases_unclassified: 4,
      cases_total: 4,
      cases_90d: 1,
      days_since_last_case: 47,
      interaction_data_quality: "POOR",
      engagement_classified_count: 0,
      engagement_unknown_count: 37,
      last_meaningful_contact: null,
      days_since_meaningful_contact: null,
      last_touch: isoAgo(3),
      recent_activity: [
        {
          type: "nota",
          date: isoAgo(3),
          summary: "Importación de prospectos",
          outcome: null,
          meaningful: false,
          engagement_quality: "UNKNOWN",
        },
      ],
    }),
    expected_primary: "activation",
    expected_supporting: [],
    expected_objective:
      "Decir explícitamente qué NO se sabe y pedir el dato antes de recomendar sobre el vacío.",
    forbidden: [
      NO_INACTIVIDAD_POOR,
      NO_UNKNOWN_COMO_HITO,
      "afirmar que nadie lo contactó",
    ],
    expected_next_action_category: "verificar_datos",
  },
  {
    id: "D2_lifecycle_contradictorio",
    nombre: "Doctor con datos de lifecycle contradictorios",
    context: makeAccredited({
      name: "Dra. Contradicción",
      // el lifecycle dice dormido; los casos dicen que está trabajando
      lifecycle: "dormido",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(400),
      first_patient_case_paid_source: "ledger_caso",
      second_patient_case_status: "COMPLETED",
      payments_count: 7,
      cases_total: 7,
      cases_30d: 2,
      cases_90d: 4,
      days_since_last_case: 5,
      open_cases: 3,
      interaction_data_quality: "PARTIAL",
      engagement_classified_count: 4,
      engagement_unknown_count: 9,
      health: { score: 64, confidence: "personal" },
    }),
    expected_primary: "retention_reactivation",
    expected_supporting: [],
    expected_objective:
      "Nombrar la contradicción (etapa dormido con 2 casos en 30 días) y resolver el dato antes de actuar.",
    forbidden: [
      "afirmar que está dormido cuando ingresó casos hace 5 días",
      "elegir la señal que conviene y ocultar la otra",
      NO_DESCUENTO,
    ],
    expected_next_action_category: "verificar_datos",
  },

  // --- Oportunidad y caso múltiple -----------------------------------------
  {
    id: "O1_oportunidad_alto_valor_sin_proxima_accion",
    nombre: "Oportunidad de alto valor sin próxima acción",
    context: makeAccredited({
      name: "Dr. Oportunidad",
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(360),
      first_patient_case_paid_source: "ledger_caso",
      second_patient_case_status: "COMPLETED",
      payments_count: 8,
      cases_total: 8,
      cases_30d: 1,
      cases_90d: 3,
      days_since_last_case: 20,
      next_action: null,
      tasks: [],
      known_commitments: [],
      open_opportunities: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          patient_name: "Paciente R.",
          stage: "decision",
          days_in_stage: 23,
          probability: 60,
          amount_mxn: 48000,
        },
      ],
    }),
    expected_primary: "growth",
    expected_supporting: [],
    expected_objective:
      "Poner una próxima acción concreta y fechada sobre la oportunidad parada en decisión.",
    forbidden: [
      NO_DESCUENTO,
      "asumir que la oportunidad se va a cerrar",
      NO_INVENTAR_NUMEROS,
    ],
    expected_next_action_category: "avanzar_oportunidad",
  },
  {
    id: "M1_multiples_problemas",
    nombre: "Doctor con varios problemas simultáneos",
    context: makeAccredited({
      name: "Dra. Todo Junto",
      lifecycle: "en_riesgo",
      categoria: "GOLD",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      first_patient_case_paid_at: daysAgo(520),
      first_patient_case_paid_source: "ledger_caso",
      second_patient_case_status: "COMPLETED",
      payments_count: 13,
      cases_total: 13,
      cases_30d: 0,
      cases_90d: 1,
      days_since_last_case: 81,
      open_cases: 2,
      clinical_confidence: "baja",
      main_objection: "Dice que el último caso clínicamente no le cerró",
      priority: { score: 90, bucket: "critico", reasons: [] },
      health: { score: 27, confidence: "personal" },
      service_issues: [
        makeServiceIssue({
          severity: "HIGH",
          confidence: "CONFIRMED",
          trust_risk_score: 80,
          detail: "Caso KS-5001 atrasado 21 días",
          since: isoAgo(21),
          impact_factors: ["dias_atraso", "problema_repetido", "paciente_afectado"],
          source: "alerta_revisada",
          alert_severity: "alta",
          rule_key: "caso_atrasado",
        }),
      ],
      historical_case_frequency: {
        avg_interval_days: 24,
        expected_next_case_at: daysAgo(57),
        confidence: "personal",
      },
    }),
    expected_primary: "doctor_success",
    expected_supporting: ["retention_reactivation", "clinical_education"],
    expected_objective:
      "Un solo hilo: primero destrabar el caso, después la conversación clínica y recién ahí el ritmo.",
    forbidden: [
      "apilar tres pedidos en un mismo mensaje",
      "empezar por el objetivo comercial",
      NO_DESCUENTO,
      NO_VIABILIDAD,
    ],
    expected_next_action_category: "destrabar_servicio",
  },

  // -------------------------------------------------------------------------
  // Escenarios comerciales del Commercial Brain V1 (§60 del pedido)
  // -------------------------------------------------------------------------
  // Prueban COMPORTAMIENTO comercial, no solo estructura de datos: qué debería
  // estar tratando de lograr el agente y qué tiene prohibido hacer en cada
  // situación típica de México.
  {
    id: "E1_acreditacion_cara",
    nombre: "El doctor dice que la acreditación está cara",
    context: makeContext({
      name: "Dr. Costo",
      lifecycle: "interes_acreditacion",
      acquisition_stage: "interes_acreditacion",
      accreditation_status: "interesado",
      potential_score: 72,
      main_objection: "Dice que la acreditación le parece cara",
      interaction_data_quality: "GOOD",
      engagement_classified_count: 6,
      last_meaningful_contact: isoAgo(5),
      days_since_meaningful_contact: 5,
      last_touch: isoAgo(5),
    }),
    expected_primary: "accreditation",
    expected_supporting: [],
    expected_objective:
      "Explicar el sistema y el valor de entrar (capacitación, ecosistema, acompañamiento) y recién ahí la economía de arranque VIGENTE configurada.",
    forbidden: [
      "ofrecer un descuento adicional o inventado",
      NO_DESCUENTO,
      "presentar la acreditación como 'pague un curso para poder comprarnos'",
      "venderla solo como una cuenta matemática",
    ],
    expected_next_action_category: "agendar_acreditacion",
  },
  {
    id: "E2_acreditado_sin_caso_propio",
    nombre: "Acreditado sin caso propio",
    context: makeAccredited({
      name: "Dra. Sin Propio",
      lifecycle: "en_activacion",
      accreditation_date: daysAgo(45),
      days_since_accreditation: 45,
      own_case_status: "NOT_STARTED",
      first_patient_case_status: "NOT_STARTED",
      second_patient_case_status: "NOT_STARTED",
      potential_score: 68,
    }),
    expected_primary: "activation",
    expected_supporting: ["clinical_education"],
    expected_objective:
      "Activación alrededor de la EXPERIENCIA: que viva el sistema en su propio tratamiento para ganar confianza en la técnica.",
    forbidden: [
      NO_PEDIR_VOLUMEN,
      "decirle que todavía no ha cargado ningún caso",
      NO_CASO_PROPIO_COMO_PACIENTE,
    ],
    expected_next_action_category: "impulsar_caso_propio",
  },
  {
    id: "E3_pregunta_si_el_caso_se_puede",
    nombre: "El doctor pregunta si la maloclusión de un paciente se puede tratar",
    context: makeAccredited({
      name: "Dr. Consulta",
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      second_patient_case_status: "COMPLETED",
      accreditation_date: daysAgo(400),
      days_since_accreditation: 400,
      cases_total: 6,
      cases_30d: 1,
      cases_90d: 2,
      days_since_last_case: 20,
      main_objection: "Pregunta si una paciente con mordida abierta es candidata (duda clínica)",
      historical_case_frequency: {
        avg_interval_days: 45,
        expected_next_case_at: daysAgo(-25),
        confidence: "personal",
      },
    }),
    expected_primary: "clinical_education",
    expected_supporting: ["growth"],
    expected_objective:
      "Ofrecer la viabilidad y prepararla para que el clinical owner responda con nota de voz; la IA no juzga el caso.",
    forbidden: [
      NO_VIABILIDAD,
      "dar un diagnóstico o una conducta clínica",
      "prometer una duración de tratamiento",
      "responder con un argumento comercial en vez de clínico",
    ],
    expected_next_action_category: "solicitar_viabilidad",
  },
  {
    id: "E4_servicio_antes_que_crecimiento",
    nombre: "Activo con caso demorado sin resolver y potencial de crecimiento",
    context: makeAccredited({
      name: "Dr. Potencial",
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      second_patient_case_status: "COMPLETED",
      accreditation_date: daysAgo(500),
      days_since_accreditation: 500,
      categoria: "GOLD",
      potential_score: 88,
      cases_total: 14,
      cases_30d: 2,
      cases_90d: 6,
      days_since_last_case: 11,
      open_cases: 4,
      historical_case_frequency: {
        avg_interval_days: 16,
        expected_next_case_at: daysAgo(-5),
        confidence: "personal",
      },
      service_issues: [
        makeServiceIssue({
          severity: "HIGH",
          confidence: "CONFIRMED",
          trust_risk_score: 78,
          detail: "Caso KS-7020 demorado 18 días sin respuesta al pedido del doctor",
          since: isoAgo(18),
          impact_factors: ["dias_atraso", "pedido_sin_responder", "paciente_afectado"],
          source: "alerta_revisada",
          alert_severity: "alta",
          rule_key: "caso_atrasado",
        }),
      ],
    }),
    expected_primary: "doctor_success",
    expected_supporting: ["growth"],
    expected_objective:
      "Arreglar la relación primero: destrabar el caso, comunicarlo y cerrar el loop. El crecimiento es otra conversación.",
    forbidden: [
      "pedir casos nuevos en el mismo mensaje que la disculpa",
      "proponer crecimiento antes de resolver el caso",
      "prometer un plazo de entrega que no consta en los datos",
    ],
    expected_next_action_category: "destrabar_servicio",
  },
  {
    id: "E5_ritmo_lento_pero_propio",
    nombre: "Manda un caso cada 90 días y lleva 45: no es caída",
    context: makeAccredited({
      name: "Dr. Pausado",
      // el motor determinístico lo marcó en riesgo con un umbral genérico
      lifecycle: "en_riesgo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      second_patient_case_status: "COMPLETED",
      accreditation_date: daysAgo(700),
      days_since_accreditation: 700,
      cases_total: 8,
      cases_30d: 0,
      cases_90d: 1,
      days_since_last_case: 45,
      historical_case_frequency: {
        avg_interval_days: 90,
        expected_next_case_at: daysAgo(-45),
        confidence: "personal",
      },
    }),
    expected_primary: "growth",
    expected_supporting: ["retention_reactivation"],
    expected_objective:
      "Tratarlo como un doctor sano dentro de su propio ritmo y, si hay algo que aportar, aportarlo — sin alarma.",
    forbidden: [
      "afirmar que está en caída o en riesgo de abandono",
      "reclamarle el tiempo sin casos",
      "tratar 45 días como un problema cuando su intervalo propio es de 90",
    ],
    expected_next_action_category: "plan_de_crecimiento",
  },
  {
    id: "E6_caida_real_de_ritmo",
    nombre: "Manda 4 casos por mes y lleva 40 días sin mandar",
    context: makeAccredited({
      name: "Dra. Frecuente",
      lifecycle: "en_riesgo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      second_patient_case_status: "COMPLETED",
      accreditation_date: daysAgo(600),
      days_since_accreditation: 600,
      categoria: "PLATINUM",
      cases_total: 26,
      cases_30d: 0,
      cases_90d: 5,
      days_since_last_case: 40,
      historical_case_frequency: {
        avg_interval_days: 8,
        expected_next_case_at: daysAgo(32),
        confidence: "personal",
      },
    }),
    expected_primary: "retention_reactivation",
    expected_supporting: [],
    expected_objective:
      "Atención alta y temprana: 40 días contra un intervalo propio de 8 es una caída real; entender la causa antes de proponer.",
    forbidden: [
      "reclamarle que dejó de mandar casos",
      "asumir una causa sin evidencia",
      NO_DESCUENTO,
    ],
    expected_next_action_category: "contacto_retencion",
  },
  {
    id: "E7_alineadores_caros",
    nombre: "El doctor dice que los alineadores están caros",
    context: makeAccredited({
      name: "Dr. Precio",
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      second_patient_case_status: "NOT_STARTED",
      accreditation_date: daysAgo(300),
      days_since_accreditation: 300,
      cases_total: 3,
      cases_30d: 0,
      cases_90d: 1,
      days_since_last_case: 35,
      main_objection: "Dice que a sus pacientes les resulta caro el tratamiento",
      historical_case_frequency: {
        avg_interval_days: 60,
        expected_next_case_at: daysAgo(-25),
        confidence: "personal",
      },
    }),
    expected_primary: "growth",
    expected_supporting: [],
    expected_objective:
      "Diagnosticar si el precio es el bloqueo real o es percepción de valor / confianza, antes de responder nada.",
    forbidden: [
      "responder la objeción con un descuento",
      NO_DESCUENTO,
      "argumentar por especificaciones técnicas del material",
      "asumir que el problema es el precio sin verificarlo",
    ],
    expected_next_action_category: "plan_de_crecimiento",
  },
  {
    id: "E8_no_tiene_pacientes",
    nombre: "El doctor no tiene pacientes candidatos",
    context: makeAccredited({
      name: "Dra. Sin Pacientes",
      lifecycle: "activado",
      activation_stage: "presentado",
      accreditation_date: daysAgo(200),
      days_since_accreditation: 200,
      own_case_status: "COMPLETED",
      own_case_completed_at: daysAgo(60),
      first_patient_case_status: "NOT_STARTED",
      second_patient_case_status: "NOT_STARTED",
      cases_total: 0,
      main_objection: "Comentó que ahorita no tiene pacientes candidatos para alineadores",
      clinical_confidence: "media",
    }),
    expected_primary: "activation",
    expected_supporting: [],
    expected_objective:
      "Ayudarlo a GENERAR DEMANDA: KeepDay, materiales, trabajo con su equipo e identificación de candidatos en su propia base.",
    forbidden: [
      "ofrecer capacitación clínica como respuesta automática",
      "volver a preguntarle si tiene algún paciente",
      NO_PEDIR_VOLUMEN,
    ],
    expected_next_action_category: "generar_demanda",
  },
  {
    id: "E9_sin_confianza_en_la_tecnica",
    nombre: "El doctor no se siente seguro con alineadores",
    context: makeAccredited({
      name: "Dr. Inseguro",
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      second_patient_case_status: "NOT_STARTED",
      accreditation_date: daysAgo(260),
      days_since_accreditation: 260,
      clinical_confidence: "baja",
      cases_total: 2,
      cases_30d: 0,
      cases_90d: 1,
      days_since_last_case: 52,
      competitors: ["brackets"],
      historical_case_frequency: {
        avg_interval_days: 70,
        expected_next_case_at: daysAgo(-18),
        confidence: "personal",
      },
    }),
    expected_primary: "clinical_education",
    expected_supporting: ["growth"],
    expected_objective:
      "Construir confianza en la TÉCNICA: revisión de casos, acompañamiento clínico, capacitación. El competidor son los brackets.",
    forbidden: [
      "responder con un descuento",
      NO_DESCUENTO,
      "comparar marca contra marca",
      "minimizar el miedo técnico con un argumento comercial",
    ],
    expected_next_action_category: "revision_clinica",
  },
  {
    id: "E10_contactado_ayer_sin_novedad",
    nombre: "Conversación sustantiva ayer y sin información nueva",
    context: makeAccredited({
      name: "Dr. Reciente",
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      second_patient_case_status: "COMPLETED",
      accreditation_date: daysAgo(480),
      days_since_accreditation: 480,
      cases_total: 9,
      cases_30d: 1,
      cases_90d: 3,
      days_since_last_case: 14,
      interaction_data_quality: "GOOD",
      engagement_classified_count: 18,
      engagement_unknown_count: 0,
      last_meaningful_contact: isoAgo(1),
      days_since_meaningful_contact: 1,
      last_touch: isoAgo(1),
      historical_case_frequency: {
        avg_interval_days: 30,
        expected_next_case_at: daysAgo(-16),
        confidence: "personal",
      },
    }),
    expected_primary: "growth",
    expected_supporting: [],
    expected_objective:
      "Reconocer que ya hubo una conversación sustantiva ayer: sin información nueva, esperar y fijar el siguiente paso con fecha.",
    forbidden: [
      "proponer otro contacto hoy sin información nueva",
      "escribir solo para mostrar actividad",
      "repetir preguntas ya contestadas",
    ],
    expected_next_action_category: "esperar_sin_contactar",
  },
  {
    id: "E11_cierre_de_mes_vs_activacion_sana",
    nombre: "El cierre de mes empujaría a presionar a un recién acreditado",
    context: makeAccredited({
      name: "Dra. Nueva",
      lifecycle: "en_activacion",
      accreditation_date: daysAgo(30),
      days_since_accreditation: 30,
      own_case_status: "IN_PROGRESS",
      own_case_id: "aaaaaaaa-0000-4000-8000-000000000010",
      own_case_started_at: daysAgo(9),
      first_patient_case_status: "NOT_STARTED",
      second_patient_case_status: "NOT_STARTED",
      potential_score: 91,
      open_cases: 1,
      cases_total: 0,
    }),
    expected_primary: "activation",
    expected_supporting: ["clinical_education"],
    expected_objective:
      "Proteger la activación sana: terminar el caso propio y construir confianza, aunque eso no sume al cierre de este mes.",
    forbidden: [
      NO_PEDIR_VOLUMEN,
      "usar el cierre de mes como argumento con el doctor",
      "pedirle que ingrese un caso de paciente para llegar a la meta",
      "urgencia artificial",
    ],
    expected_next_action_category: "acompanar_caso",
  },
  {
    id: "E12_trabaja_comodo_con_invisalign",
    nombre: "El doctor trabaja cómodo con Invisalign",
    context: makeAccredited({
      name: "Dr. Marca",
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      second_patient_case_status: "COMPLETED",
      accreditation_date: daysAgo(420),
      days_since_accreditation: 420,
      categoria: "GOLD",
      cases_total: 7,
      cases_30d: 1,
      cases_90d: 2,
      days_since_last_case: 26,
      competitors: ["Invisalign"],
      main_objection: "Ya trabaja con Invisalign y está conforme",
      historical_case_frequency: {
        avg_interval_days: 40,
        expected_next_case_at: daysAgo(-14),
        confidence: "personal",
      },
    }),
    expected_primary: "growth",
    expected_supporting: [],
    expected_objective:
      "Posicionar a KeepSmiling como opción complementaria que diversifica su práctica, nunca como reemplazo.",
    forbidden: [
      NO_DENIGRAR,
      "atacar o desprestigiar a Invisalign",
      "comparar marca contra marca en terreno clínico",
      "pedirle que deje su marca actual",
    ],
    expected_next_action_category: "plan_de_crecimiento",
  },
];

export { daysAgo as evalDaysAgo, isoAgo as evalIsoAgo, TODAY as EVAL_TODAY };

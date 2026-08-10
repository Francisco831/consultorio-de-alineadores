// Schemas zod (v4) para outputs estructurados de agentes + JSON Schema para tools.
// Los agentes emiten su resultado vía la tool forzada "emit" con strict: true;
// acá se valida ANTES de persistir (retry del modelo si no matchea).

import { z } from "zod";

export const AGENT_KEYS = [
  "orchestrator",
  "acquisition",
  "accreditation",
  "activation",
  "clinical_education",
  "growth",
  "retention_reactivation",
  "doctor_success",
  "commercial_director",
] as const;

export const CHANNELS = ["whatsapp", "call", "video", "visit", "clinical", "task"] as const;

/** Vocabulario de cuellos de botella (Fase 3). Debe coincidir exactamente con el
 *  check de ai_recommendations.bottleneck (migración 0026) y con el tipo
 *  Bottleneck de lib/ai/types.ts. */
export const BOTTLENECKS = [
  "DATOS_INSUFICIENTES",
  "SIN_DUENO",
  "SERVICIO",
  "INCERTIDUMBRE_CLINICA",
  "SIN_RELACION",
  "SIN_ACREDITACION",
  "SIN_CASO_PROPIO",
  "SIN_PRIMER_PACIENTE",
  "SIN_SEGUNDO_CASO",
  "SIN_PACIENTES",
  "CONVERSION_PACIENTE",
  "DOCUMENTACION",
  "PRECIO",
  "EQUIPO",
  "SIN_SEGUIMIENTO",
  "TIEMPO",
  "CADENCIA_CAIDA",
  "BRECHA_CRECIMIENTO",
  "COMPETENCIA",
  "NINGUNO",
  "DESCONOCIDO",
] as const;

export const OWNER_ROLES = [
  "SALES",
  "CLINICAL",
  "COUNTRY_MANAGER",
  "OPERATIONS",
  "ADMIN",
  "MARKETING",
] as const;

export const DISMISS_CODES = [
  "ya_hecho",
  "momento_equivocado",
  "interpretacion_equivocada",
  "doctor_pidio_no_contacto",
  "existe_mejor_accion",
  "dato_malo",
  "no_apropiado_comercialmente",
  "otro",
] as const;

export const TASK_TYPES = [
  "llamada",
  "whatsapp",
  "visita",
  "reunion",
  "revision_clinica",
  "seguimiento",
] as const;

// enum activity_type de la DB (0001): task_type + email/nota/keepday, sin
// 'seguimiento'. Un valor fuera de la lista hace fallar el insert al aceptar.
export const ACTIVITY_TYPES = [
  "llamada",
  "whatsapp",
  "visita",
  "reunion",
  "revision_clinica",
  "email",
  "nota",
  "keepday",
] as const;

// Clasificaciones que la IA solo PROPONE (migración 0022). 'UNKNOWN' no se
// propone nunca: proponer "no sé" no es un dato, y el default de la DB ya lo es.
// La confirmación humana es la única vía para salir de UNKNOWN.
export const PROPOSABLE_CASE_SUBJECT_TYPES = ["PATIENT", "DOCTOR_SELF", "OTHER"] as const;
export const PROPOSABLE_ENGAGEMENT_QUALITIES = ["MEANINGFUL", "LOW_TOUCH"] as const;

// YYYY-MM-DD — las columnas recommended_date / due_date son date
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const evidenceItem = z.strictObject({
  field: z.string(),
  value: z.string(),
});

// Propuesta de clasificación del sujeto de un caso (cases.case_subject_type):
// el caso propio del doctor NO es su primer caso de paciente. La IA aporta la
// evidencia; el humano confirma y recién ahí deja de ser UNKNOWN.
export const caseSubjectPayloadSchema = z.strictObject({
  kind: z.literal("case_subject"),
  case_id: z.string(),
  proposed_type: z.enum(PROPOSABLE_CASE_SUBJECT_TYPES),
  evidence: z.string(),
});

// Propuesta de clasificación de la calidad de una actividad
// (activities.engagement_quality + main_topic + next_action).
export const activityClassificationPayloadSchema = z.strictObject({
  kind: z.literal("activity_classification"),
  activity_id: z.string(),
  proposed_quality: z.enum(PROPOSABLE_ENGAGEMENT_QUALITIES),
  main_topic: z.string().nullable(),
  next_action: z.string().nullable(),
  evidence: z.string(),
});

export const recommendationPayloadSchema = z.union([
  z.strictObject({
    kind: z.literal("task"),
    title: z.string(),
    type: z.enum(TASK_TYPES),
    due_date: isoDate.nullable(),
    description: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("activity"),
    type: z.enum(ACTIVITY_TYPES),
    summary: z.string(),
    outcome: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("profile_update"),
    fields: z.record(z.string(), z.string().nullable()),
    rationale: z.string(),
  }),
  caseSubjectPayloadSchema,
  activityClassificationPayloadSchema,
  z.strictObject({ kind: z.literal("none") }),
]);

export type CaseSubjectPayload = z.infer<typeof caseSubjectPayloadSchema>;
export type ActivityClassificationPayload = z.infer<
  typeof activityClassificationPayloadSchema
>;

export const agentRecommendationSchema = z.strictObject({
  doctor_id: z.string().nullable(),
  agent: z.enum(AGENT_KEYS),
  recommendation_type: z.string(),
  objective: z.string(),
  situation: z.string(),
  recommended_action: z.string(),
  channel: z.enum(CHANNELS),
  recommended_date: isoDate.nullable(),
  // --- Next Best Action (Fase 3): sin estos campos una recomendación es una
  // frase. El cuello de botella es además lo que el director agrega después.
  bottleneck: z.enum(BOTTLENECKS),
  owner_role: z.enum(OWNER_ROLES),
  current_stage: z.string(),
  expected_outcome: z.string(),
  follow_up_condition: z.string().nullable(),
  why: z.array(z.string()),
  evidence: z.array(evidenceItem),
  confidence: z.number().int().min(0).max(100),
  commercial_priority: z.number().int().min(0).max(100),
  clinical_handoff: z.boolean(),
  handoff_agent: z.enum(AGENT_KEYS).nullable(),
  suggested_message: z.string().nullable(),
  requires_user_confirmation: z.boolean(),
  payload: recommendationPayloadSchema.nullable(),
});

export const agentEmitSchema = z.strictObject({
  recommendations: z.array(agentRecommendationSchema),
});

export const orchestratorAssessmentSchema = z.strictObject({
  doctor_id: z.string(),
  ai_summary: z.string(),
  situation: z.string(),
  primary_agent: z.enum(AGENT_KEYS),
  involvements: z.array(
    z.strictObject({ agent: z.enum(AGENT_KEYS), reason: z.string() })
  ),
  recommendations: z.array(agentRecommendationSchema),
});

export const directorBriefSchema = z.strictObject({
  answer: z.string(),
  findings: z.array(
    z.strictObject({
      title: z.string(),
      detail: z.string(),
      evidence: z.array(evidenceItem),
    })
  ),
  recommendations: z.array(agentRecommendationSchema),
  data_as_of: z.string(),
});

// ---------------------------------------------------------------------------
// zod → JSON Schema apto para strict tool use de Anthropic.
// Structured outputs NO soporta minimum/maximum/minLength/maxLength — se strippean
// (la validación real la hace zod al recibir el tool_use).
// ---------------------------------------------------------------------------

const UNSUPPORTED_KEYS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "$schema",
  "id",
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYS.has(k)) continue;
      out[k] = stripUnsupported(v);
    }
    return out;
  }
  return node;
}

export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12" });
  return stripUnsupported(json) as Record<string, unknown>;
}

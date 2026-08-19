// Confianza honesta (migración 0022): la confianza de una recomendación NO puede
// depender solo del modelo. Un razonamiento impecable sobre datos pobres sigue
// siendo una conclusión pobre.
//
//   ai_recommendations.confidence (GLOBAL) = min(reasoning_confidence, data_confidence)
//
// reasoning_confidence lo declara el modelo; data_confidence lo calcula este
// módulo mirando SOLO hechos del contexto (nunca el texto del modelo). Regla
// dura: certeza alta del modelo + datos pobres NUNCA puede dar confianza global
// alta. Los `caps` explican en es-MX cada punto de castigo y quedan guardados en
// agent_runs.data_quality para poder auditar por qué bajó la confianza.

import { todayMX } from "@/lib/dates";
import type { DoctorContext, InteractionDataQuality } from "@/lib/ai/types";

export interface ConfidenceBreakdown {
  reasoning: number;
  data: number;
  overall: number;
  caps: string[];
}

// ---------------------------------------------------------------------------
// Castigos (el score tiene piso 0 y techo 100)
// ---------------------------------------------------------------------------

const PENALTY = {
  /** activities.engagement_quality (0022): sin interacciones calificadas no se
   *  puede saber si hubo conversación real. */
  interaction_poor: 30,
  interaction_partial: 15,
  /** cases.case_subject_type (0022): sin clasificar no se distingue el caso
   *  propio del doctor del primer caso de paciente ⇒ los hitos son opinión. */
  cases_unclassified: 20,
  /** acreditado sin accredited_at: no hay reloj del día 75. */
  missing_accreditation_date: 15,
  /** sin owner: nadie es dueño de la relación en el CRM. */
  missing_owner: 10,
  /** frescura del snapshot (sync_runs). */
  stale_7d: 10,
  stale_30d: 25,
} as const;

const STALE_WARN_DAYS = 7;
const STALE_HARD_DAYS = 30;

// ---------------------------------------------------------------------------
// Lecturas con guarda de valor
// ---------------------------------------------------------------------------
// Los campos ya vienen tipados del Context Engine, pero este módulo también se
// ejecuta con contextos armados a mano (harness de evaluación) y con contextos
// de versiones previas. Un valor ausente o fuera de vocabulario se lee como
// DESCONOCIDO y castiga — nunca se lee como dato bueno.

function safeQuality(v: unknown): InteractionDataQuality | null {
  return v === "GOOD" || v === "PARTIAL" || v === "POOR" ? v : null;
}

function safeCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Días entre el watermark de datos y hoy (México). null si la fecha no sirve. */
function daysStale(dataAsOf: string | null | undefined): number | null {
  const day = (dataAsOf ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const asOf = Date.parse(`${day}T00:00:00Z`);
  const today = Date.parse(`${todayMX()}T00:00:00Z`);
  if (!Number.isFinite(asOf) || !Number.isFinite(today)) return null;
  return Math.max(0, Math.round((today - asOf) / 86_400_000));
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Cuánta confianza SOPORTAN los datos de este doctor (0-100), con el detalle en
 * es-MX de cada castigo. No mira lo que dijo el modelo: solo el contexto.
 */
export function dataConfidence(ctx: DoctorContext): { score: number; caps: string[] } {
  const caps: string[] = [];
  let score = 100;

  // 1. Calidad de las interacciones registradas (activities.engagement_quality)
  const quality = safeQuality(ctx.interaction_data_quality);
  if (quality === "POOR") {
    score -= PENALTY.interaction_poor;
    caps.push(
      "Las actividades registradas no permiten saber si hubo conversación real con el doctor: puede haber contacto reciente que acá no figure (que no esté registrado no significa que no pasó)."
    );
  } else if (quality === "PARTIAL") {
    score -= PENALTY.interaction_partial;
    caps.push(
      "Solo una parte de las actividades registradas está confirmada como conversación real: del resto no se sabe."
    );
  } else if (quality === null) {
    score -= PENALTY.interaction_poor;
    caps.push(
      "La calidad de las interacciones no fue evaluada: se trata como desconocida, no como buena."
    );
  }

  // 2. Casos sin clasificar (cases.case_subject_type)
  const unclassified = safeCount(ctx.cases_unclassified);
  const puedeTenerCasos =
    ctx.is_accredited || (ctx.cases_total ?? 0) > 0 || (ctx.open_cases ?? 0) > 0;
  if (unclassified === null && puedeTenerCasos) {
    score -= PENALTY.cases_unclassified;
    caps.push(
      "No se sabe cuántos casos están sin clasificar: no se puede afirmar cuál fue el caso propio ni cuál el primer caso de paciente."
    );
  } else if (unclassified !== null && unclassified > 0) {
    score -= PENALTY.cases_unclassified;
    caps.push(
      `${unclassified} caso(s) sin clasificar (paciente vs. caso propio): los hitos de activación de este doctor no están confirmados.`
    );
  }

  // 3. Acreditado sin fecha de acreditación
  if (ctx.is_accredited && !ctx.accreditation_date) {
    score -= PENALTY.missing_accreditation_date;
    caps.push(
      "Acreditado sin fecha de acreditación cargada: no se puede saber hace cuánto se acreditó ni si sus primeros hitos están en plazo."
    );
  }

  // 4. Sin comercial asignado
  if (!ctx.owner) {
    score -= PENALTY.missing_owner;
    caps.push("El doctor no tiene comercial asignado en el CRM.");
  }

  // 5. Frescura del snapshot de datos
  const stale = daysStale(ctx.data_as_of);
  if (stale === null) {
    score -= PENALTY.stale_7d;
    caps.push("No se pudo determinar qué tan frescos son los datos (no consta la fecha de la última sincronización).");
  } else if (stale > STALE_HARD_DAYS) {
    score -= PENALTY.stale_30d;
    caps.push(
      `Los datos tienen ${stale} días (última actualización: ${ctx.data_as_of}): cualquier conclusión sobre ritmo o contacto puede estar vencida.`
    );
  } else if (stale > STALE_WARN_DAYS) {
    score -= PENALTY.stale_7d;
    caps.push(`Los datos tienen ${stale} días (última actualización: ${ctx.data_as_of}).`);
  }

  return { score: clamp(score), caps };
}

/**
 * Combina la certeza declarada por el modelo con la que soportan los datos.
 * overall = min(reasoning, data) — por diseño, alta certeza del modelo sobre
 * datos pobres no puede producir confianza global alta.
 */
export function combine(
  reasoningFromModel: number,
  data: { score: number; caps: string[] }
): ConfidenceBreakdown {
  const reasoning = clamp(reasoningFromModel);
  const dataScore = clamp(data.score);
  const overall = Math.min(reasoning, dataScore);
  const caps = [...data.caps];
  if (dataScore < reasoning) {
    caps.unshift(
      `Confianza global limitada por los datos: el modelo declaró ${reasoning}/100 y los datos solo sostienen ${dataScore}/100.`
    );
  }
  return { reasoning, data: dataScore, overall, caps };
}

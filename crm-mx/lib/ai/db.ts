// Cliente Supabase service-role EXCLUSIVO de la capa AI.
// Única importación permitida de SUPABASE_SERVICE_ROLE_KEY en runtime.
// Solo escribe tablas ai_* (ai_recommendations, doctor_ai_profile, agent_runs).
// NUNCA usarlo para escribir tablas CRM: con service-role is_system()=true y los
// triggers doctors_guard/doctors_journey_sync no corren (se saltean las
// Conversiones 1/2). Las acciones aprobadas se ejecutan con la sesión del
// usuario vía las server actions existentes.

import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function createAiServiceClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY para la capa AI");
  }
  cached = createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export const AI_MODEL = process.env.AI_MODEL ?? "claude-opus-5";

/**
 * Cuánto piensa el modelo antes de responder. Es la perilla de costo/calidad:
 * medido sobre una corrida real, la SALIDA (que es sobre todo pensamiento) fue el
 * 44% del costo del análisis de un doctor.
 *
 * `high` es el default de la API, así que sin la variable el comportamiento no
 * cambia. En Opus 5, `low` y `medium` rinden bastante más de lo que sugiere el
 * nombre — pero bajarlo se mide contra la calidad de la recomendación, no solo
 * contra el número.
 */
const NIVELES_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;
export type AiEffort = (typeof NIVELES_EFFORT)[number];

export const AI_EFFORT: AiEffort = (() => {
  const v = process.env.AI_EFFORT?.trim();
  if (!v) return "high";
  if ((NIVELES_EFFORT as readonly string[]).includes(v)) return v as AiEffort;
  // Se falla en vez de caer al default en silencio: un valor mal escrito haría
  // correr todo al esfuerzo equivocado —y al costo equivocado— sin que nadie lo
  // note. Un error al arrancar se arregla en diez segundos; un costo silencioso
  // se descubre en la factura.
  throw new Error(
    `AI_EFFORT="${v}" no es válido. Valores: ${NIVELES_EFFORT.join(", ")}.`
  );
})();

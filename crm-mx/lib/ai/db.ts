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

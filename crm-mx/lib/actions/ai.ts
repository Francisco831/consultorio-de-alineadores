"use server";

// Decisión humana sobre recomendaciones AI (contrato HITL, docs/AI_ARCHITECTURE.md §10).
// Aceptar ejecuta el payload con la SESIÓN DEL USUARIO (RLS + guards + atribución
// humana intactos); solo doctor_ai_profile se escribe vía service-role (camino
// human-confirmed). Descartar exige motivo: es el insumo de la blacklist (P34).

import { createClient } from "@/lib/supabase/server";
import { createAiServiceClient } from "@/lib/ai/db";
import { revalidatePath } from "next/cache";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type {
  AiRecommendationRow,
  DoctorAiProfileFields,
} from "@/lib/ai/types";

const PROFILE_FIELD_KEYS = [
  "experience_with_aligners",
  "clinical_confidence",
  "main_concerns",
  "preferred_contact_style",
  "business_goals",
  "growth_ambition",
  "known_objections",
  "competitor_relationship",
  "previous_bad_experiences",
  "relationship_notes",
  "team_readiness",
  "patient_acquisition_problem",
  "education_needs",
] as const satisfies readonly (keyof DoctorAiProfileFields)[];

const CLINICAL_CONFIDENCE_VALUES = ["alta", "media", "baja", "desconocida"];

/** Sesión con permisos de decisión (VIEWER no decide recomendaciones). */
async function decisionClient(): Promise<
  { supabase: SupabaseClient; user: User } | { error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user.id)
    .single();
  if (!profile || profile.rol === "VIEWER") {
    return { error: "Tu rol no tiene permisos para decidir recomendaciones" };
  }
  return { supabase, user };
}

function revalidateAiPaths() {
  revalidatePath("/doctores/[id]", "page");
  revalidatePath("/hoy");
}

export async function acceptRecommendation(
  formData: FormData
): Promise<{ error?: string; ok?: boolean }> {
  const session = await decisionClient();
  if ("error" in session) return { error: session.error };
  const { supabase, user } = session;

  const recommendationId = String(formData.get("recommendation_id") ?? "").trim();
  if (!recommendationId) return { error: "Falta la recomendación" };

  const { data, error: loadErr } = await supabase
    .from("ai_recommendations")
    .select("*")
    .eq("id", recommendationId)
    .maybeSingle();
  if (loadErr) return { error: loadErr.message };
  if (!data) return { error: "La recomendación ya no existe" };
  const rec = data as AiRecommendationRow;
  if (rec.status !== "propuesta") {
    return { error: "La recomendación ya fue decidida" };
  }

  // Se reclama la recomendación ANTES de ejecutar: dos clicks simultáneos
  // pasarían el chequeo de arriba y crearían la tarea/actividad dos veces.
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from("ai_recommendations")
    .update({
      status: "aceptada",
      decided_by: user.id,
      decided_at: claimedAt,
      resolved_at: claimedAt,
    })
    .eq("id", recommendationId)
    .eq("status", "propuesta")
    .select("id");
  if (claimErr) return { error: claimErr.message };
  if (!claimed?.length)
    return { error: "La recomendación ya fue decidida o no tenés permisos" };

  // Marca el intento fallido en la fila ya reclamada (queda auditable y no se
  // puede re-ejecutar el payload).
  const failClaimed = async (message: string) => {
    await supabase
      .from("ai_recommendations")
      .update({ outcome: `Error al ejecutar: ${message}` })
      .eq("id", recommendationId);
    return { error: message };
  };

  // --- ejecutar el payload con la sesión del usuario (corren RLS/guards) ---
  const payload = rec.payload;
  let executedRef: Record<string, unknown> | null = null;

  if (payload && payload.kind === "task") {
    if (!rec.doctor_id)
      return failClaimed("La recomendación no tiene doctor asociado");
    // tasks no tiene columna de descripción (ver lib/types.ts): se persiste solo el título
    const { data: task, error } = await supabase
      .from("tasks")
      .insert({
        doctor_id: rec.doctor_id,
        title: payload.title,
        type: payload.type,
        due_date: payload.due_date,
        assigned_to: user.id,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error) return failClaimed(`No se pudo crear la tarea: ${error.message}`);
    executedRef = { task_id: task.id };
  } else if (payload && payload.kind === "activity") {
    if (!rec.doctor_id)
      return failClaimed("La recomendación no tiene doctor asociado");
    const { data: activity, error } = await supabase
      .from("activities")
      .insert({
        doctor_id: rec.doctor_id,
        type: payload.type,
        summary: payload.summary,
        outcome: payload.outcome,
        occurred_at: new Date().toISOString(),
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error)
      return failClaimed(`No se pudo registrar la actividad: ${error.message}`);
    // el último contacto del doctor se actualiza al vuelo (el motor lo recalcula igual)
    await supabase
      .from("doctors")
      .update({ last_contact_at: new Date().toISOString() })
      .eq("id", rec.doctor_id);
    executedRef = { activity_id: activity.id };
  } else if (payload && payload.kind === "profile_update") {
    if (!rec.doctor_id)
      return failClaimed("La recomendación no tiene doctor asociado");
    const fields: Partial<DoctorAiProfileFields> = {};
    for (const key of PROFILE_FIELD_KEYS) {
      if (!(key in payload.fields)) continue;
      const value = payload.fields[key];
      if (
        key === "clinical_confidence" &&
        (value == null || !CLINICAL_CONFIDENCE_VALUES.includes(value))
      )
        continue;
      (fields as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(fields).length === 0)
      return failClaimed("La propuesta no tiene campos de perfil válidos");
    // ÚNICA escritura por service-role: doctor_ai_profile es tabla ai_* y este
    // es el camino human-confirmed (el usuario acaba de aceptar la propuesta).
    const aiDb = createAiServiceClient();
    const { error } = await aiDb.from("doctor_ai_profile").upsert(
      {
        doctor_id: rec.doctor_id,
        ...fields,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
        last_source: "ai_confirmado",
      },
      { onConflict: "doctor_id" }
    );
    if (error)
      return failClaimed(`No se pudo actualizar el perfil: ${error.message}`);
    executedRef = {
      doctor_ai_profile: rec.doctor_id,
      fields: Object.keys(fields),
    };
  } else if (payload && payload.kind === "case_subject") {
    // Clasificación del sujeto del caso propuesta por la IA y CONFIRMADA acá:
    // recién con este click el caso deja de ser UNKNOWN. La escritura va con la
    // sesión del usuario (RLS + guard de procedencia de 0024).
    const { data: updatedCase, error } = await supabase
      .from("cases")
      .update({
        case_subject_type: payload.proposed_type,
        case_subject_source: "ai_confirmado",
        case_subject_set_by: user.id,
        case_subject_set_at: new Date().toISOString(),
      })
      .eq("id", payload.case_id)
      .select("id");
    if (error)
      return failClaimed(`No se pudo clasificar el caso: ${error.message}`);
    if (!updatedCase?.length)
      return failClaimed("No se pudo clasificar el caso (sin permisos o no existe)");
    executedRef = { case_id: payload.case_id, case_subject_type: payload.proposed_type };
  } else if (payload && payload.kind === "activity_classification") {
    const { data: updatedAct, error } = await supabase
      .from("activities")
      .update({
        engagement_quality: payload.proposed_quality,
        engagement_source: "ai_confirmado",
        engagement_set_by: user.id,
        engagement_set_at: new Date().toISOString(),
        ...(payload.main_topic ? { main_topic: payload.main_topic } : {}),
        ...(payload.next_action ? { next_action: payload.next_action } : {}),
      })
      .eq("id", payload.activity_id)
      .select("id");
    if (error)
      return failClaimed(`No se pudo clasificar la actividad: ${error.message}`);
    if (!updatedAct?.length)
      return failClaimed("No se pudo clasificar la actividad (sin permisos o no existe)");
    executedRef = {
      activity_id: payload.activity_id,
      engagement_quality: payload.proposed_quality,
    };
  }
  // kind 'none' o payload null: solo se marca la decisión

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from("ai_recommendations")
    .update({
      status: executedRef ? "ejecutada" : "aceptada",
      decided_by: user.id,
      decided_at: now,
      action_completed: executedRef != null,
      executed_ref: executedRef,
      resolved_at: now,
    })
    .eq("id", recommendationId)
    .select("id");
  if (updErr)
    return {
      error: `La acción se ejecutó pero no se pudo actualizar la recomendación: ${updErr.message}`,
    };
  if (!updated?.length)
    return { error: "No se pudo actualizar la recomendación (sin permisos)" };

  revalidateAiPaths();
  return { ok: true };
}

export async function dismissRecommendation(
  formData: FormData
): Promise<{ error?: string; ok?: boolean }> {
  const session = await decisionClient();
  if ("error" in session) return { error: session.error };
  const { supabase, user } = session;

  const recommendationId = String(formData.get("recommendation_id") ?? "").trim();
  if (!recommendationId) return { error: "Falta la recomendación" };
  const dismissReason = String(formData.get("dismiss_reason") ?? "").trim();
  if (!dismissReason)
    return { error: "El motivo de descarte es obligatorio" };

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("ai_recommendations")
    .update({
      status: "descartada",
      decided_by: user.id,
      decided_at: now,
      dismiss_reason: dismissReason,
      resolved_at: now,
    })
    .eq("id", recommendationId)
    .eq("status", "propuesta")
    .select("id");
  if (error) return { error: error.message };
  if (!updated?.length)
    return { error: "La recomendación ya fue decidida o no existe" };

  revalidateAiPaths();
  return { ok: true };
}

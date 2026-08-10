"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { ForecastCat, OppStage } from "@/lib/types";

// misma lista que components/pipeline/board.tsx (un archivo "use server"
// solo puede exportar funciones async, por eso vive duplicada)
const LOST_REASONS = [
  "Precio",
  "Competencia",
  "Paciente desistió",
  "Financiación",
  "Clínico",
  "Otro",
];

const FORECAST_CATS: ForecastCat[] = [
  "pipeline",
  "best_case",
  "commit",
  "closed",
  "omitted",
];

function revalidateOppPaths() {
  revalidatePath("/pipeline");
  revalidatePath("/hoy");
  revalidatePath("/dashboard");
}

export async function createOpportunity(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const doctorId = String(formData.get("doctor_id"));
  const amountRaw = String(formData.get("amount_mxn") ?? "").trim();
  // etapa inicial: solo se admite arrancar en viabilidad o paciente potencial
  const stageRaw = String(formData.get("stage") ?? "paciente_potencial");
  const stage: OppStage =
    stageRaw === "viabilidad" ? "viabilidad" : "paciente_potencial";
  const { error } = await supabase.from("opportunities").insert({
    doctor_id: doctorId,
    patient_name: String(formData.get("patient_name") ?? "").trim() || null,
    stage,
    amount_mxn: amountRaw ? Number(amountRaw) : null,
    expected_close_date: String(formData.get("expected_close_date") ?? "") || null,
    owner_id: user.id,
  });
  if (error) return { error: error.message };
  revalidatePath(`/doctores/${doctorId}`);
  revalidatePath("/pipeline");
  return { ok: true };
}

/** Mover de etapa (drag del kanban o botón Ganada). El trigger de la DB
 *  ajusta probability, stage_entered_at, closed_at y forecast_category. */
export async function moveOpportunityStage(
  oppId: string,
  stage: OppStage
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("opportunities")
    .update({ stage })
    .eq("id", oppId)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length)
    return { error: "No se pudo mover: sin permisos de edición o ya no existe" };
  revalidateOppPaths();
  return {};
}

/** Editar probabilidad, categoría de forecast, monto y fecha de cierre. */
export async function updateOpportunityMeta(
  formData: FormData
): Promise<{ error?: string; ok?: boolean }> {
  const supabase = await createClient();
  const oppId = String(formData.get("opportunity_id") ?? "");
  if (!oppId) return { error: "Falta la oportunidad" };

  const update: Record<string, unknown> = {};

  const probabilityRaw = String(formData.get("probability") ?? "").trim();
  if (probabilityRaw) {
    const probability = Math.round(Number(probabilityRaw));
    if (Number.isNaN(probability) || probability < 0 || probability > 100) {
      return { error: "La probabilidad debe estar entre 0 y 100" };
    }
    update.probability = probability;
  }

  const forecastCategory = String(formData.get("forecast_category") ?? "");
  if (forecastCategory) {
    if (!FORECAST_CATS.includes(forecastCategory as ForecastCat)) {
      return { error: "Categoría de forecast inválida" };
    }
    update.forecast_category = forecastCategory;
  }

  const amountRaw = String(formData.get("amount_mxn") ?? "").trim();
  update.amount_mxn = amountRaw ? Number(amountRaw) : null;
  update.expected_close_date =
    String(formData.get("expected_close_date") ?? "") || null;

  const { data, error } = await supabase
    .from("opportunities")
    .update(update)
    .eq("id", oppId)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length)
    return { error: "No se pudo guardar: sin permisos de edición o ya no existe" };
  revalidateOppPaths();
  return { ok: true };
}

/** Marcar perdida con motivo de una lista fija + nota opcional. */
export async function markLost(
  formData: FormData
): Promise<{ error?: string; ok?: boolean }> {
  const supabase = await createClient();
  const oppId = String(formData.get("opportunity_id") ?? "");
  if (!oppId) return { error: "Falta la oportunidad" };

  const reason = String(formData.get("lost_reason") ?? "");
  if (!LOST_REASONS.includes(reason)) {
    return { error: "Elegí un motivo de la lista" };
  }
  const note = String(formData.get("lost_note") ?? "").trim();

  const { data, error } = await supabase
    .from("opportunities")
    .update({
      stage: "perdida",
      lost_reason: note ? `${reason} — ${note}` : reason,
    })
    .eq("id", oppId)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length)
    return { error: "No se pudo marcar: sin permisos de edición o ya no existe" };
  revalidateOppPaths();
  return { ok: true };
}

"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

function revalidateTaskPaths(doctorId: string | null) {
  revalidatePath("/tareas");
  revalidatePath("/hoy");
  if (doctorId) revalidatePath(`/doctores/${doctorId}`);
}

export async function createTask(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const doctorId = String(formData.get("doctor_id") ?? "") || null;
  const { error } = await supabase.from("tasks").insert({
    doctor_id: doctorId,
    opportunity_id: String(formData.get("opportunity_id") ?? "") || null,
    type: String(formData.get("type") ?? "seguimiento"),
    title: String(formData.get("title") ?? "").trim(),
    due_date: String(formData.get("due_date") ?? "") || null,
    assigned_to: String(formData.get("assigned_to") ?? "") || user.id,
    created_by: user.id,
  });
  if (error) return { error: error.message };
  revalidateTaskPaths(doctorId);
  return { ok: true };
}

/**
 * Completar con outcome. Registra la actividad correspondiente y,
 * si viene next_title, crea la próxima tarea — todo en un solo flujo.
 */
export async function completeTask(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const taskId = String(formData.get("task_id"));
  const outcome = String(formData.get("outcome") ?? "").trim() || null;

  const { data: task, error: tErr } = await supabase
    .from("tasks")
    .update({ status: "completada", outcome })
    .eq("id", taskId)
    .select("id, doctor_id, opportunity_id, type, title")
    .maybeSingle();
  if (tErr) return { error: tErr.message };
  if (!task)
    return { error: "No se pudo completar: sin permisos de edición o ya no existe" };

  // la tarea completada queda como interacción en la timeline
  if (task.doctor_id) {
    await supabase.from("activities").insert({
      doctor_id: task.doctor_id,
      opportunity_id: task.opportunity_id,
      type: task.type === "seguimiento" ? "nota" : task.type,
      summary: task.title,
      outcome,
      created_by: user.id,
    });
    // el último contacto lo deriva recompute_doctor del insert de arriba; desde
    // 0052 la columna está protegida y escribirla acá fallaría (ver activities.ts)
  }

  const nextTitle = String(formData.get("next_title") ?? "").trim();
  if (nextTitle) {
    const { error } = await supabase.from("tasks").insert({
      doctor_id: task.doctor_id,
      opportunity_id: task.opportunity_id,
      type: String(formData.get("next_type") ?? "seguimiento"),
      title: nextTitle,
      due_date: String(formData.get("next_due_date") ?? "") || null,
      assigned_to: user.id,
      created_by: user.id,
    });
    if (error) return { error: error.message };
  }

  revalidateTaskPaths(task.doctor_id);
  return { ok: true };
}

export async function cancelTask(formData: FormData) {
  const supabase = await createClient();
  const taskId = String(formData.get("task_id"));
  const { data: task, error } = await supabase
    .from("tasks")
    .update({ status: "cancelada" })
    .eq("id", taskId)
    .select("doctor_id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!task)
    return { error: "No se pudo cancelar: sin permisos de edición o ya no existe" };
  revalidateTaskPaths(task.doctor_id);
  return { ok: true };
}

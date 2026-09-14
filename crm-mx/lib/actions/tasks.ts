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
      // "para quién": si el formulario no lo manda, queda para el que la creó
      assigned_to: String(formData.get("next_assigned_to") ?? "") || user.id,
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

/**
 * Cambiar de dueño una tarea ("tomar" la de otro, o pasarle una a Rocío).
 *
 * Pedido de Juan y Rocío (11/9): las tareas de la gira quedaron a nombre de
 * uno y las hizo el otro, y no había forma de moverlas. La base ya lo
 * permitía (tasks_guard, 0052) y desde 0061 lo audita; esto es solo la
 * puerta. No hay candado de autor a propósito: son dos personas y las
 * tareas son del equipo. Si algún día hace falta, el lugar es un guard en
 * la base, no acá.
 */
export async function reassignTask(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const taskId = String(formData.get("task_id"));
  const assignedTo = String(formData.get("assigned_to") ?? "").trim();
  if (!assignedTo) return { error: "Elegí a quién pasarle la tarea" };

  const { data: task, error } = await supabase
    .from("tasks")
    .update({ assigned_to: assignedTo })
    .eq("id", taskId)
    .select("doctor_id")
    .maybeSingle();
  if (error) {
    // FK a profiles: un id que no es de una persona del equipo
    if (error.code === "23503") return { error: "Esa persona no está en el equipo" };
    return { error: error.message };
  }
  if (!task)
    return { error: "No se pudo reasignar: sin permisos de edición o ya no existe" };
  revalidateTaskPaths(task.doctor_id);
  return { ok: true };
}

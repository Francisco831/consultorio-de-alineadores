"use server";

// La libreta personal de pendientes (tabla `pendientes`, migración 0039).
// Pedido de Pancho el 26/8: "un lugar para cada uno donde puedan anotar sus
// tareas diarias, tipo Trello, bien simple". NO es `tasks`: acá nadie mide a
// nadie, se escribe / se tacha / se borra y listo.

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

// La libreta se ve en /hoy (la propia) y en /panel (?u= muestra la del otro),
// así que toda escritura tiene que refrescar las dos rutas.
function revalidarLibreta() {
  revalidatePath("/hoy");
  revalidatePath("/panel");
}

/** El insert de 0039 exige `can_write()`: si el rol no escribe, Postgres tira 42501. */
const SIN_PERMISO = "No se pudo guardar: tu rol no tiene permisos de edición";
/** update y delete filtran por `user_id = auth.uid()`: el de otro no devuelve fila. */
const DE_OTRO = "Ese pendiente es de otra persona";

export async function crearPendiente(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const texto = String(formData.get("texto") ?? "").trim();
  if (!texto) return { error: "Escribí el pendiente antes de agregarlo" };
  // el CHECK de 0039 corta en 500: validamos acá para dar un error legible
  if (texto.length > 500)
    return { error: "Máximo 500 caracteres para un pendiente" };

  // Lo nuevo va ARRIBA (es lo que uno acaba de acordarse): mínimo actual − 1.
  // Sin transacción a propósito — es la libreta de UNA persona escribiendo en
  // UNA pestaña; dos altas simultáneas del mismo usuario no es un caso real, y
  // si empataran el orden desempata created_at.
  const { data: primero } = await supabase
    .from("pendientes")
    .select("orden")
    .eq("user_id", user.id)
    .order("orden", { ascending: true })
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from("pendientes")
    .insert({ user_id: user.id, texto, orden: (primero?.orden ?? 0) - 1 })
    .select("id");
  if (error)
    return { error: error.code === "42501" ? SIN_PERMISO : error.message };
  if (!data?.length) return { error: SIN_PERMISO };

  revalidarLibreta();
  return { ok: true };
}

export async function togglePendiente(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const id = String(formData.get("id") ?? "");
  const hecho = String(formData.get("hecho") ?? "") === "true";

  // `hecho_at` no se manda: lo escribe el trigger pendientes_transition (0039)
  const { data, error } = await supabase
    .from("pendientes")
    .update({ hecho })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: DE_OTRO };

  revalidarLibreta();
  return { ok: true };
}

export async function borrarPendiente(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const id = String(formData.get("id") ?? "");
  const { data, error } = await supabase
    .from("pendientes")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: DE_OTRO };

  revalidarLibreta();
  return { ok: true };
}

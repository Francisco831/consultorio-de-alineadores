"use server";

// "Ya respondí": bajar a mano la marca de un chat que el equipo contestó por
// fuera del CRM (o que nunca pidió respuesta). No es un update libre a
// wa_conversations: esa tabla la escribe el webhook con service role, así que la
// única puerta para un usuario logueado es la RPC wa_marcar_respondido (0041,
// 26/8), que valida sesión y rol adentro de la base.

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function marcarRespondido(
  formData: FormData
): Promise<{ error: string } | { ok: true }> {
  const chat = String(formData.get("chat_id") ?? "").trim();
  if (!chat) return { error: "Falta el chat" };
  // por defecto marca respondido; "false" lo devuelve a la lista de pendientes
  const respondido = String(formData.get("respondido") ?? "true") !== "false";

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("wa_marcar_respondido", {
    chat,
    respondido,
  });

  if (error) {
    // La RPC no falla en silencio como una RLS: lanza excepción cuando el rol no
    // puede escribir. Traducimos ese caso al mismo texto que el resto del CRM.
    if (/rol|permis|sesión|sesion/i.test(error.message)) {
      return { error: "No se pudo guardar: tu rol no tiene permisos de edición" };
    }
    return { error: error.message };
  }
  // devuelve false cuando el update no encontró la fila (chat borrado o id viejo)
  if (data === false) return { error: "Ese chat ya no existe" };

  revalidatePath("/hoy");
  revalidatePath("/panel");
  revalidatePath("/doctores");
  return { ok: true };
}

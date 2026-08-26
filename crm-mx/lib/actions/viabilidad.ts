"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { ViabilityStatus } from "@/lib/types";

const ESTADOS: ViabilityStatus[] = [
  "solicitada",
  "enviada",
  "respondida",
  "sin_respuesta",
];

// `respondida` y `sin_respuesta` CIERRAN el ciclo: la viabilidad deja de contar
// como "esperando" y desaparece de /seguimiento (decisión 26/8). Los otros dos
// estados la dejan abierta, y si alguien vuelve atrás (de respondida a enviada)
// hay que despejar la fecha de cierre o el caso quedaría escondido para siempre.
const CIERRAN: ViabilityStatus[] = ["respondida", "sin_respuesta"];

/**
 * Registra en qué quedó una viabilidad. El ciclo se carga A MANO: no hay sync
 * que lo traiga (el equipo clínico contesta por WhatsApp), así que esta acción
 * es la única fuente del dato.
 */
export async function registrarViabilidad(formData: FormData) {
  const id = String(formData.get("opportunity_id") ?? "").trim();
  const estadoRaw = String(formData.get("viability_status") ?? "");
  const estado = ESTADOS.find((e) => e === estadoRaw);
  if (!id) return { error: "Falta la oportunidad" };
  if (!estado) return { error: "Elegí en qué quedó la viabilidad" };

  const fields = {
    viability_status: estado,
    viability_result:
      String(formData.get("viability_result") ?? "").trim() || null,
    viability_follow_up_date:
      String(formData.get("viability_follow_up_date") ?? "").trim() || null,
    // acá SÍ va toISOString: es un instante (timestamptz), no el "hoy" del
    // negocio — para un día calendario se usa lib/dates.ts
    viability_completed_at: CIERRAN.includes(estado)
      ? new Date().toISOString()
      : null,
  };

  const supabase = await createClient();
  // el permiso lo decide RLS, no este código: si la política rechaza el update
  // no vuelve error, vuelve cero filas (mismo patrón que lib/actions/doctors.ts)
  const { data, error } = await supabase
    .from("opportunities")
    .update(fields)
    .eq("id", id)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length)
    return { error: "No se pudo guardar: tu rol no tiene permisos de edición" };

  revalidatePath("/seguimiento");
  revalidatePath("/doctores");
  return { ok: true };
}

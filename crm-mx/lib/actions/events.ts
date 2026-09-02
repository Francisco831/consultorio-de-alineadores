"use server";

// Alta de eventos (charla/webinar/KeepDay/acreditación) con asistentes y
// dictante. Los asistentes se tipean por nombre, uno por línea o separados
// por coma; acá se matchean contra doctors con el mismo criterio del
// importador (todos los tokens presentes, exacto > ficha con noloco_id) y
// NUNCA se adivina: si es ambiguo o no está, queda el nombre crudo sin
// doctor_id y el evento no pierde el registro.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-zñ0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(s: string): Set<string> {
  const STOP = new Set(["dr", "dra", "doctor", "doctora", "de", "del", "la", "los"]);
  return new Set(norm(s).split(" ").filter((t) => t.length > 1 && !STOP.has(t)));
}

type Doc = { id: string; nombre: string; noloco_id: string | null };

function matchDoctor(nombre: string, doctors: Doc[]): Doc | null {
  const src = tokens(nombre);
  if (src.size === 0) return null;
  let hits = doctors.filter((d) => {
    const dst = tokens(d.nombre);
    for (const t of src) if (!dst.has(t)) return false;
    return true;
  });
  if (hits.length === 0) {
    hits = doctors.filter((d) => {
      const dst = tokens(d.nombre);
      if (dst.size === 0) return false;
      for (const t of dst) if (!src.has(t)) return false;
      return true;
    });
  }
  if (hits.length > 1) {
    const objetivo = norm(nombre);
    const exactos = hits.filter((d) => norm(d.nombre) === objetivo);
    const pool = exactos.length >= 1 ? exactos : hits;
    if (pool.length === 1) return pool[0];
    const conNoloco = pool.filter((d) => d.noloco_id);
    return conNoloco.length === 1 ? conNoloco[0] : null;
  }
  return hits[0] ?? null;
}

export async function crearEvento(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sin sesión");

  const titulo = String(formData.get("titulo") ?? "").trim();
  const fecha = String(formData.get("fecha") ?? "").trim();
  if (!titulo || !fecha) throw new Error("Faltan título o fecha");

  const { data: evento, error } = await supabase
    .from("events")
    .insert({
      titulo,
      tipo: String(formData.get("tipo") ?? "charla"),
      fecha,
      dictante: String(formData.get("dictante") ?? "").trim() || null,
      modalidad: String(formData.get("modalidad") ?? "").trim() || null,
      notas: String(formData.get("notas") ?? "").trim() || null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) throw error;

  const crudos = String(formData.get("asistentes") ?? "")
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);

  if (crudos.length > 0) {
    const doctors = await fetchAllRows<Doc>((from, to) =>
      supabase.from("doctors").select("id, nombre, noloco_id").range(from, to)
    );
    const filas = crudos.map((nombre) => ({
      event_id: evento.id,
      doctor_id: matchDoctor(nombre, doctors)?.id ?? null,
      nombre_crudo: nombre,
    }));
    const { error: e2 } = await supabase.from("event_attendees").insert(filas);
    if (e2) throw e2;
  }
  revalidatePath("/eventos");
}

export async function borrarEvento(formData: FormData) {
  const supabase = await createClient();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const { error } = await supabase.from("events").delete().eq("id", id);
  if (error) throw error;
  revalidatePath("/eventos");
}

// ---------------------------------------------------------------------------
// Corregir las notas de un evento ya cargado (events.notas, migración 0051)
// ---------------------------------------------------------------------------

/**
 * `events_update` (0051) filtra por autor y no tira error: el evento de otro
 * devuelve cero filas. También cae acá el rol que dejó de escribir con la
 * pantalla abierta, pero se nombra el caso que va a pasar de verdad.
 */
const EVENTO_AJENO =
  "Este evento lo cargó otra persona: las notas las corrige quien lo registró";

/** 0035 dejó `notas` sin tope: 2.000 es el de las observaciones del doctor. */
const MAX_NOTAS = 2000;

/**
 * Pedido de Pancho el 31/8: "necesito en el CRM poder modificar las notas".
 * Hasta acá la única forma de arreglar la nota de un evento era borrarlo y
 * volver a cargarlo, y eso se lleva puesta la lista de asistentes — lo más caro
 * de tipear de todo el formulario.
 *
 * Corrige SOLO las notas y SOLO se la banca quien cargó el evento; ninguna de
 * las dos reglas se chequea acá, las hace cumplir 0051 (la policy
 * `events_update` y el guard `events_guard` de lista blanca).
 *
 * Devuelve `{ error }` / `{ ok }` en vez de tirar como crearEvento y
 * borrarEvento acá arriba: el editor vive adentro de la lista de eventos y un
 * throw se llevaría puesta toda la pantalla en lugar de mostrar una línea roja
 * abajo del textarea.
 */
export async function actualizarNotasEvento(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "No se pudo guardar: falta el evento" };

  const notas = String(formData.get("notas") ?? "").trim();
  if (notas.length > MAX_NOTAS)
    return {
      error: "Son las notas del evento, no la minuta: máximo 2.000 caracteres",
    };

  // borrar todo el texto es una corrección válida: vuelve a quedar sin notas
  const { data, error } = await supabase
    .from("events")
    .update({ notas: notas || null })
    .eq("id", id)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: EVENTO_AJENO };

  // /eventos es la única pantalla que muestra el texto de la nota. Las otras dos
  // que leen `events` no lo miran: /panel cuenta por created_by y created_at
  // (head:true) y /equipo/actividad —con su calendario— lista título, tipo y
  // fecha (lib/actividad-equipo). 0051 tampoco audita events, así que la
  // corrección no agrega renglón de "edición" allá; revalidarlas sería tirar
  // cachés sanas a la basura.
  revalidatePath("/eventos");
  return { ok: true };
}

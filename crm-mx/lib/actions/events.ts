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

// Arma la agenda del día CON el brief de cada doctor ya resuelto.
//
// Vive acá y no en cada página porque /hoy y /panel muestran lo mismo y la
// primera versión (26/8) tenía el armado copiado en las dos — con el resultado
// de que a las dos les faltaban los mismos dos datos: los tipos de caso y los
// eventos a los que asistió el doctor, que `briefDoctor` sabe usar pero nadie le
// pasaba (iban en null). Pancho los había pedido explícitamente. Con una sola
// función, un dato que falta falta en un lugar, no en dos.
//
// lib/brief-doctor.ts sigue siendo PURA (y con test): acá está el lado que toca
// la base, allá el que redacta.

import type { SupabaseClient } from "@supabase/supabase-js";
import { briefDoctor, type DatosBrief } from "@/lib/brief-doctor";
import type { EventoAgenda } from "@/components/calendar/agenda-hoy";

/** Lo que la página trae de calendar_events, con el doctor ya joineado. */
export interface FilaAgenda {
  id: string;
  titulo: string;
  inicio: string;
  fin: string | null;
  todo_el_dia: boolean;
  doctor: Record<string, unknown> | null;
}

/** Las columnas de `doctors` que el brief necesita. Se pide este set exacto. */
export const SELECT_DOCTOR_BRIEF =
  "id, nombre, categoria, city, state, zona, case_count, new_case_count, " +
  "last_contact_at, avg_interval_days, instagram, specialty, uses_aligners, " +
  "estimated_cases_month, why_interesting, competitor_brands, lifecycle_stage, " +
  "birth_date, observaciones, phone, whatsapp";

type DoctorFila = {
  id: string;
  nombre: string;
  phone: string | null;
  whatsapp: string | null;
  [k: string]: unknown;
};

/**
 * Dos consultas más (tipos de caso y eventos asistidos), y solo si hay agenda.
 * Un día sin reuniones no paga nada; uno con ocho llamadas paga dos queries.
 */
export async function armarAgendaConBrief(
  supabase: SupabaseClient,
  filas: FilaAgenda[]
): Promise<EventoAgenda[]> {
  const doctores = filas
    .map((f) => f.doctor as DoctorFila | null)
    .filter((d): d is DoctorFila => !!d?.id);
  const ids = [...new Set(doctores.map((d) => d.id))];

  const [{ data: casosRaw }, { data: asistRaw }] = ids.length
    ? await Promise.all([
        supabase
          .from("cases")
          .select("doctor_id, tipo_tratamiento, tipo_caso")
          .in("doctor_id", ids)
          .eq("is_demo", false)
          .limit(3000),
        supabase
          .from("event_attendees")
          .select("doctor_id, events(titulo, fecha)")
          .in("doctor_id", ids),
      ])
    : [{ data: [] }, { data: [] }];

  // tratamientos: los 3 que más manda, del más al menos
  // tipos de caso: el conteo crudo por tipo — el brief decide qué afirmar
  const tratamientos = new Map<string, Map<string, number>>();
  const tiposCaso = new Map<string, Record<string, number>>();
  for (const c of (casosRaw ?? []) as {
    doctor_id: string;
    tipo_tratamiento: string | null;
    tipo_caso: string | null;
  }[]) {
    if (c.tipo_tratamiento) {
      if (!tratamientos.has(c.doctor_id)) tratamientos.set(c.doctor_id, new Map());
      const m = tratamientos.get(c.doctor_id)!;
      m.set(c.tipo_tratamiento, (m.get(c.tipo_tratamiento) ?? 0) + 1);
    }
    if (c.tipo_caso) {
      if (!tiposCaso.has(c.doctor_id)) tiposCaso.set(c.doctor_id, {});
      const r = tiposCaso.get(c.doctor_id)!;
      r[c.tipo_caso] = (r[c.tipo_caso] ?? 0) + 1;
    }
  }

  const eventos = new Map<string, { titulo: string; fecha: string }[]>();
  for (const a of (asistRaw ?? []) as unknown as {
    doctor_id: string | null;
    events: { titulo: string; fecha: string } | null;
  }[]) {
    if (!a.doctor_id || !a.events) continue;
    if (!eventos.has(a.doctor_id)) eventos.set(a.doctor_id, []);
    eventos.get(a.doctor_id)!.push(a.events);
  }

  const topTratamientos = (id: string): string[] =>
    [...(tratamientos.get(id) ?? new Map<string, number>()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);

  return filas.map((f) => {
    const d = f.doctor as DoctorFila | null;
    return {
      id: f.id,
      titulo: f.titulo,
      inicio: f.inicio,
      fin: f.fin,
      todo_el_dia: f.todo_el_dia,
      doctor: d
        ? { id: d.id, nombre: d.nombre, phone: d.phone, whatsapp: d.whatsapp }
        : null,
      brief: d ? briefDoctor(datosDe(d, topTratamientos(d.id), tiposCaso.get(d.id) ?? null, eventos.get(d.id) ?? null)) : null,
    };
  });
}

/** Traduce la fila de `doctors` al contrato del brief, sin inventar nada. */
function datosDe(
  d: DoctorFila,
  tiposTratamiento: string[],
  tiposCaso: Record<string, number> | null,
  eventos: { titulo: string; fecha: string }[] | null
): DatosBrief {
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  return {
    nombre: d.nombre,
    categoria: (d.categoria as DatosBrief["categoria"]) ?? null,
    city: s("city"),
    state: s("state"),
    zona: s("zona"),
    case_count: n("case_count"),
    new_case_count: n("new_case_count"),
    last_contact_at: s("last_contact_at"),
    avg_interval_days: n("avg_interval_days"),
    instagram: s("instagram"),
    specialty: s("specialty"),
    uses_aligners: typeof d.uses_aligners === "boolean" ? d.uses_aligners : null,
    estimated_cases_month: n("estimated_cases_month"),
    why_interesting: s("why_interesting"),
    competitor_brands: Array.isArray(d.competitor_brands)
      ? (d.competitor_brands as string[])
      : null,
    tiposTratamiento: tiposTratamiento.length ? tiposTratamiento : null,
    tiposCaso,
    eventos,
    birth_date: s("birth_date"),
    observaciones: s("observaciones"),
    lifecycle_stage: (d.lifecycle_stage as DatosBrief["lifecycle_stage"]) ?? null,
  };
}

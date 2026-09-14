"use server";

import { createClient } from "@/lib/supabase/server";
import { recortarAlrededor } from "@/lib/recorte";
import { formatDate } from "@/lib/format";
import { ACTIVITY_TYPE_LABELS, type ActivityType } from "@/lib/types";

export interface SearchResult {
  /**
   * "nota" = un match dentro de lo que el equipo escribió: una actividad, las
   * observaciones de la ficha o el título de una tarea. Lleva a la ficha del
   * doctor. Pedido del grupo México (11/9): "Summit" estaba en 21 actividades,
   * 5 observaciones y 18 tareas y no había forma de encontrarlas.
   */
  kind: "doctor" | "caso" | "oportunidad" | "nota";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

export async function searchAll(q: string): Promise<SearchResult[]> {
  // comas/paréntesis rompen la sintaxis .or() de PostgREST; % y \ inyectan wildcards
  const query = q.trim().replace(/[,()%\\]/g, " ").replace(/\s+/g, " ").trim();
  if (query.length < 2) return [];
  const supabase = await createClient();
  const like = `%${query}%`;

  const [
    { data: doctors },
    { data: cases },
    { data: opps },
    { data: actividades },
    { data: observaciones },
    { data: tareas },
    { data: perfiles },
  ] = await Promise.all([
    supabase
      .from("doctors")
      .select("id, nombre, city, categoria, phone, email")
      .or(`nombre.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
      .limit(6),
    supabase
      .from("cases")
      .select("id, id_externo, noloco_case_id, paciente, doctor_id, doctors(nombre)")
      .or(`paciente.ilike.${like},id_externo.ilike.${like}`)
      .limit(5),
    supabase
      .from("opportunities")
      .select("id, patient_name, doctor_id, stage, doctors(nombre)")
      .ilike("patient_name", like)
      .not("stage", "in", "(ganada,perdida)")
      .limit(4),
    // ---- lo escrito por el equipo ----
    supabase
      .from("activities")
      .select("id, doctor_id, type, occurred_at, summary, outcome, created_by, doctors(nombre)")
      .or(`summary.ilike.${like},outcome.ilike.${like}`)
      .eq("is_demo", false)
      .order("occurred_at", { ascending: false })
      .limit(6),
    supabase
      .from("doctors")
      .select("id, nombre, observaciones")
      .ilike("observaciones", like)
      .eq("is_demo", false)
      .limit(4),
    supabase
      .from("tasks")
      .select("id, doctor_id, title, status, due_date, assigned_to, doctors(nombre)")
      .ilike("title", like)
      .eq("is_demo", false)
      // pendientes primero (el enum se ordena por declaración), las más nuevas arriba
      .order("status", { ascending: true })
      .order("due_date", { ascending: false, nullsFirst: false })
      .limit(4),
    supabase.from("profiles").select("id, nombre"),
  ]);

  const results: SearchResult[] = [];
  for (const d of doctors ?? []) {
    results.push({
      kind: "doctor",
      id: d.id,
      title: d.nombre,
      subtitle: [d.categoria, d.city].filter(Boolean).join(" · ") || null,
      href: `/doctores/${d.id}`,
    });
  }
  for (const c of (cases ?? []) as unknown as {
    id: string;
    id_externo: string | null;
    noloco_case_id: string;
    paciente: string | null;
    doctor_id: string;
    doctors: { nombre: string } | null;
  }[]) {
    results.push({
      kind: "caso",
      id: c.id,
      title: `${c.id_externo ?? c.noloco_case_id} — ${c.paciente ?? "sin paciente"}`,
      subtitle: c.doctors?.nombre ?? null,
      href: `/doctores/${c.doctor_id}`,
    });
  }
  for (const o of (opps ?? []) as unknown as {
    id: string;
    patient_name: string | null;
    doctor_id: string;
    doctors: { nombre: string } | null;
  }[]) {
    results.push({
      kind: "oportunidad",
      id: o.id,
      title: o.patient_name ?? "Oportunidad",
      subtitle: o.doctors?.nombre ?? null,
      href: `/doctores/${o.doctor_id}`,
    });
  }

  // ---- notas: el título es el pedazo de texto donde aparece lo buscado ----
  const nombreDe = new Map(
    ((perfiles ?? []) as { id: string; nombre: string }[]).map((p) => [p.id, p.nombre])
  );
  for (const a of (actividades ?? []) as unknown as {
    id: string;
    doctor_id: string;
    type: string;
    occurred_at: string;
    summary: string | null;
    outcome: string | null;
    created_by: string | null;
    doctors: { nombre: string } | null;
  }[]) {
    const texto = [a.summary, a.outcome].filter(Boolean).join(" — ");
    const autor = a.created_by ? nombreDe.get(a.created_by) : null;
    const tipo = ACTIVITY_TYPE_LABELS[a.type as ActivityType] ?? a.type;
    results.push({
      kind: "nota",
      id: `actividad-${a.id}`,
      title: recortarAlrededor(texto, query),
      subtitle: [
        a.doctors?.nombre,
        autor ? `${tipo} de ${autor}` : tipo,
        formatDate(a.occurred_at),
      ]
        .filter(Boolean)
        .join(" · "),
      href: `/doctores/${a.doctor_id}`,
    });
  }
  for (const d of (observaciones ?? []) as {
    id: string;
    nombre: string;
    observaciones: string | null;
  }[]) {
    results.push({
      kind: "nota",
      id: `observaciones-${d.id}`,
      title: recortarAlrededor(d.observaciones ?? "", query),
      subtitle: `${d.nombre} · Observaciones de la ficha`,
      href: `/doctores/${d.id}`,
    });
  }
  for (const t of (tareas ?? []) as unknown as {
    id: string;
    doctor_id: string | null;
    title: string;
    status: string;
    due_date: string | null;
    assigned_to: string | null;
    doctors: { nombre: string } | null;
  }[]) {
    const asignada = t.assigned_to ? nombreDe.get(t.assigned_to) : null;
    results.push({
      kind: "nota",
      id: `tarea-${t.id}`,
      title: recortarAlrededor(t.title, query),
      subtitle: [
        t.doctors?.nombre,
        `Tarea ${t.status}${asignada ? ` de ${asignada}` : ""}`,
        t.due_date,
      ]
        .filter(Boolean)
        .join(" · "),
      href: t.doctor_id ? `/doctores/${t.doctor_id}` : "/tareas?v=equipo",
    });
  }
  return results;
}

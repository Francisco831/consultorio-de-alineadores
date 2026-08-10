"use server";

import { createClient } from "@/lib/supabase/server";

export interface SearchResult {
  kind: "doctor" | "caso" | "oportunidad";
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

  const [{ data: doctors }, { data: cases }, { data: opps }] = await Promise.all([
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
  return results;
}

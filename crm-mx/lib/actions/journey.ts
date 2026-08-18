"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { AcqStage, ActStage } from "@/lib/types";

function revalidateJourney(doctorId?: string) {
  revalidatePath("/prospeccion");
  revalidatePath("/prospeccion/lista");
  revalidatePath("/pipeline");
  revalidatePath("/doctores");
  revalidatePath("/tareas");
  revalidatePath("/hoy");
  revalidatePath("/dashboard");
  if (doctorId) revalidatePath(`/doctores/${doctorId}`);
}

/** Mueve un doctor en el pipeline de ADQUISICIÓN. Llegar a 'acreditado' dispara
 *  la Conversión 1 (trigger doctors_journey_sync): accredited_at + pasa al
 *  pipeline de activación. MISMO doctor, mismo registro. */
export async function moveAcquisitionStage(doctorId: string, stage: AcqStage) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("doctors")
    .update({ acquisition_stage: stage })
    .eq("id", doctorId)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length)
    return { error: "Tu rol no tiene permisos para mover doctores" };
  revalidateJourney(doctorId);
  return { ok: true };
}

/** Mueve un doctor en el pipeline de ACTIVACIÓN. Llegar a 'primer_caso_pagado'
 *  dispara la Conversión 2: lifecycle=activado, First Case Date, Days to First
 *  Case y Activated By (trigger doctors_journey_sync). */
export async function moveActivationStage(doctorId: string, stage: ActStage) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("doctors")
    .update({ activation_stage: stage })
    .eq("id", doctorId)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length)
    return { error: "Tu rol no tiene permisos para mover doctores" };
  revalidateJourney(doctorId);
  return { ok: true };
}

/** Alta rápida de prospecto (universo A). El objetivo con él NO es un caso:
 *  es que se acredite. */
export async function createProspect(formData: FormData) {
  const nombre = String(formData.get("nombre") ?? "").trim();
  if (!nombre) return { error: "El nombre es obligatorio" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const str = (k: string) => String(formData.get(k) ?? "").trim() || null;
  const num = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v ? Number(v) : null;
  };

  const { data, error } = await supabase
    .from("doctors")
    .insert({
      nombre,
      phone: str("phone"),
      whatsapp: str("phone"),
      email: str("email"),
      city: str("city"),
      specialty: str("specialty"),
      clinic_name: str("clinic_name"),
      source: str("source"),
      estimated_cases_month: num("estimated_cases_month"),
      interest_level: num("interest_level"),
      accreditation_interest: num("accreditation_interest"),
      uses_aligners: formData.get("uses_aligners") === "on",
      competitor_brands: str("competitor")
        ? [String(formData.get("competitor")).trim()]
        : [],
      why_interesting: str("why_interesting"),
      lifecycle_stage: "prospecto",
      acquisition_stage: "identificado",
      owner_id: user?.id ?? null,
      is_demo: false,
    })
    .select("id")
    .single();
  if (error) return { error: error.message };
  revalidateJourney(data.id);
  return { ok: true, id: data.id };
}

/** Edita el perfil comercial de un prospecto (alimenta su priority score). */
export async function updateProspectProfile(formData: FormData) {
  const id = String(formData.get("id"));
  const str = (k: string) => String(formData.get(k) ?? "").trim() || null;
  const num = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v ? Number(v) : null;
  };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("doctors")
    .update({
      specialty: str("specialty"),
      estimated_cases_month: num("estimated_cases_month"),
      interest_level: num("interest_level"),
      accreditation_interest: num("accreditation_interest"),
      uses_aligners: formData.get("uses_aligners") === "on",
      why_interesting: str("why_interesting"),
    })
    .eq("id", id)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length)
    return { error: "Tu rol no tiene permisos de edición" };
  revalidatePath(`/doctores/${id}`);
  revalidatePath("/prospeccion");
  return { ok: true };
}

/**
 * ACREDITAR: el cruce de un doctor del área "Por acreditarse" a "Acreditados".
 *
 * Hasta acá el cruce era arrastrar una tarjeta en el kanban y ver un toast. Eso
 * dispara la Conversión 1 correctamente, pero deja tres cabos sueltos que con las
 * dos áreas separadas se vuelven visibles:
 *
 *  1. Las tareas de captación quedaban abiertas. La automatización deja de
 *     GENERARLAS al acreditarse (filtra `not d.is_accredited`, 0020:272) pero no
 *     cierra las que ya existen: el día del cruce el vendedor veía, en la sección
 *     "Acreditados", una tarea pidiéndole que lo acredite.
 *  2. El momento de la acreditación —el corte central del negocio— no quedaba
 *     como hito en el historial del doctor.
 *  3. /tareas no se revalidaba.
 *
 * LA FECHA NO SE PUEDE ELEGIR, y es a propósito del diseño de la base: doctors_guard
 * (0019:705-711) prohíbe escribir accredited_at a mano, y el trigger de journey lo
 * pone en current_date (0015:161). Acreditar con fecha retroactiva necesitaría una
 * función con permisos de sistema.
 */
export async function acreditarDoctor(doctorId: string, nota?: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  // 1. el cruce — dispara la Conversión 1 (is_accredited, accredited_at,
  //    activation_stage='acreditado', lifecycle='en_activacion')
  const { data, error } = await supabase
    .from("doctors")
    .update({ acquisition_stage: "acreditado" })
    .eq("id", doctorId)
    .select("id, nombre");
  if (error) return { error: error.message };
  if (!data?.length)
    return { error: "Tu rol no tiene permisos para acreditar doctores" };

  // 2. el hito en el historial. Si falla, el doctor YA cruzó: no se revierte el
  //    cruce por no poder escribir la nota, pero tampoco se miente diciendo que
  //    salió todo bien.
  const { error: errNota } = await supabase.from("activities").insert({
    doctor_id: doctorId,
    type: "nota",
    summary: "Acreditado",
    outcome: nota?.trim() || null,
    occurred_at: new Date().toISOString(),
    created_by: user.id,
  });

  // 3. cerrar las tareas de captación que quedaron abiertas. Se identifican sin
  //    ambigüedad por automation_rule_id: es la marca que dejó la regla que las
  //    creó. Las tareas cargadas a mano NO se tocan — nadie sabe si siguen
  //    valiendo, y cerrarlas por las dudas sería peor.
  const { data: reglas } = await supabase
    .from("automation_rules")
    .select("id")
    .eq("key", "prospecto_sin_seguimiento");
  const ids = (reglas ?? []).map((r) => (r as { id: string }).id);
  let cerradas = 0;
  if (ids.length) {
    const { data: cerradasRaw } = await supabase
      .from("tasks")
      .update({
        status: "cancelada",
        outcome: "Se acreditó",
        completed_at: new Date().toISOString(),
      })
      .eq("doctor_id", doctorId)
      .eq("status", "pendiente")
      .in("automation_rule_id", ids)
      .select("id");
    cerradas = cerradasRaw?.length ?? 0;
  }

  revalidateJourney(doctorId);
  return {
    ok: true,
    cerradas,
    ...(errNota ? { aviso: `El doctor quedó acreditado, pero la nota no se guardó: ${errNota.message}` } : {}),
  };
}

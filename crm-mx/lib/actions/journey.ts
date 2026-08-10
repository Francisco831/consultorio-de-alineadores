"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { AcqStage, ActStage } from "@/lib/types";

function revalidateJourney(doctorId?: string) {
  revalidatePath("/prospeccion");
  revalidatePath("/pipeline");
  revalidatePath("/doctores");
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

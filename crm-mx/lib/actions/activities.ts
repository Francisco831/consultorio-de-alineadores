"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function logActivity(formData: FormData) {
  const doctorId = String(formData.get("doctor_id"));
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const occurredRaw = String(formData.get("occurred_at") ?? "").trim();
  const { error } = await supabase.from("activities").insert({
    doctor_id: doctorId,
    opportunity_id: String(formData.get("opportunity_id") ?? "") || null,
    type: String(formData.get("type") ?? "nota"),
    summary: String(formData.get("summary") ?? "").trim() || null,
    outcome: String(formData.get("outcome") ?? "").trim() || null,
    occurred_at: occurredRaw
      ? new Date(occurredRaw).toISOString()
      : new Date().toISOString(),
    created_by: user.id,
  });
  if (error) return { error: error.message };

  // el último contacto del doctor se actualiza al vuelo (el motor lo recalcula igual)
  await supabase
    .from("doctors")
    .update({ last_contact_at: new Date().toISOString() })
    .eq("id", doctorId);

  revalidatePath(`/doctores/${doctorId}`);
  // la carga rápida del panel personal también refresca sus tiles y listas
  revalidatePath("/panel");
  return { ok: true };
}

"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function updateDoctorContact(formData: FormData) {
  const id = String(formData.get("id"));
  const fields = {
    phone: (String(formData.get("phone") ?? "").trim() || null) as string | null,
    whatsapp: (String(formData.get("whatsapp") ?? "").trim() || null) as string | null,
    email: (String(formData.get("email") ?? "").trim() || null) as string | null,
    city: (String(formData.get("city") ?? "").trim() || null) as string | null,
    zona: (String(formData.get("zona") ?? "").trim() || null) as string | null,
    clinic_name: (String(formData.get("clinic_name") ?? "").trim() || null) as
      | string
      | null,
  };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("doctors")
    .update(fields)
    .eq("id", id)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length)
    return { error: "No se pudo guardar: tu rol no tiene permisos de edición" };
  revalidatePath(`/doctores/${id}`);
  revalidatePath("/doctores");
  return { ok: true };
}

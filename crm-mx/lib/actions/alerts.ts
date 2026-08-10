"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

async function setAlertStatus(
  alertId: string,
  status: "resuelta" | "descartada"
): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  const { data, error } = await supabase
    .from("alerts")
    .update({ status, resolved_by: user.id, resolved_at: new Date().toISOString() })
    .eq("id", alertId)
    .select("id");
  if (error || !data?.length) {
    console.error(
      "alerts: no se actualizó —",
      error?.message ?? "0 filas (rol sin permisos o alerta inexistente)"
    );
    return;
  }
  revalidatePath("/hoy");
}

export async function resolveAlert(formData: FormData): Promise<void> {
  await setAlertStatus(String(formData.get("alert_id")), "resuelta");
}

export async function dismissAlert(formData: FormData): Promise<void> {
  await setAlertStatus(String(formData.get("alert_id")), "descartada");
}

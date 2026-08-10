"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

async function managerClient(): Promise<SupabaseClient | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user.id)
    .single();
  if (!profile || !["ADMIN", "COUNTRY_MANAGER", "SALES_MANAGER"].includes(profile.rol)) {
    return null;
  }
  return supabase;
}

export async function recalcularScores(): Promise<void> {
  const supabase = await managerClient();
  if (!supabase) return;
  const { error } = await supabase.rpc("recompute_all");
  if (error) console.error("recompute_all:", error.message);
  revalidatePath("/", "layout");
}

export async function ejecutarAutomatizaciones(): Promise<void> {
  const supabase = await managerClient();
  if (!supabase) return;
  const { error } = await supabase.rpc("evaluate_automations");
  if (error) console.error("evaluate_automations:", error.message);
  revalidatePath("/", "layout");
}

export async function purgarDemo(): Promise<void> {
  const supabase = await managerClient();
  if (!supabase) return;
  const { error } = await supabase.rpc("purge_demo");
  if (error) console.error("purge_demo:", error.message);
  revalidatePath("/", "layout");
}

export async function toggleRegla(formData: FormData): Promise<void> {
  const supabase = await managerClient();
  if (!supabase) return;
  const id = String(formData.get("id"));
  const enabled = String(formData.get("enabled")) === "true";
  const { error } = await supabase
    .from("automation_rules")
    .update({ enabled: !enabled })
    .eq("id", id);
  if (error) console.error("toggleRegla:", error.message);
  revalidatePath("/ajustes");
}

export async function guardarObjetivo(formData: FormData): Promise<void> {
  const supabase = await managerClient();
  if (!supabase) return;
  const period = String(formData.get("period")); // YYYY-MM
  const target = parseInt(String(formData.get("target")));
  if (!period || !Number.isFinite(target)) return;
  const periodDate = `${period}-01`;
  const { data: existing } = await supabase
    .from("goals")
    .select("id")
    .eq("period", periodDate)
    .eq("metric", "paid_cases")
    .is("user_id", null)
    .maybeSingle();
  const { error } = existing
    ? await supabase.from("goals").update({ target }).eq("id", existing.id)
    : await supabase
        .from("goals")
        .insert({ period: periodDate, metric: "paid_cases", target, user_id: null });
  if (error) console.error("guardarObjetivo:", error.message);
  revalidatePath("/ajustes");
  revalidatePath("/hoy");
}

"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { METRICAS_OBJETIVO, type MetricaObjetivo } from "@/lib/types";
import { INTERACCION_RULE_KEY, leerParamsInteraccion } from "@/lib/interaccion";
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
  const metricRaw = String(formData.get("metric") ?? "paid_cases");
  // sin whitelist, un valor cualquiera escribiría una meta que ninguna pantalla
  // lee y que nadie encontraría después
  const metric: MetricaObjetivo =
    metricRaw in METRICAS_OBJETIVO ? (metricRaw as MetricaObjetivo) : "paid_cases";
  if (!period || !Number.isFinite(target)) return;
  const periodDate = `${period}-01`;
  const { data: existing } = await supabase
    .from("goals")
    .select("id")
    .eq("period", periodDate)
    .eq("metric", metric)
    .is("user_id", null)
    .maybeSingle();
  const { error } = existing
    ? await supabase.from("goals").update({ target }).eq("id", existing.id)
    : await supabase
        .from("goals")
        .insert({ period: periodDate, metric, target, user_id: null });
  if (error) console.error("guardarObjetivo:", error.message);
  revalidatePath("/ajustes");
  revalidatePath("/hoy");
  revalidatePath("/prospeccion");
  revalidatePath("/dashboard");
  revalidatePath("/viabilidades");
}

/**
 * Los umbrales del nivel de interacción con soporte (migración 0060): qué
 * cuenta como conversación real. Viven en automation_rules.params
 * (key interaccion_soporte) y los lee recompute_interaccion(). Guardar
 * recalcula a toda la cartera: los umbrales nuevos valen desde ya, no desde
 * la corrida de la noche.
 */
export async function guardarInteraccion(formData: FormData): Promise<void> {
  const supabase = await managerClient();
  if (!supabase) return;
  // misma lectura que hace la base: lo que no es número toma el default, lo
  // que se pasa de rango se recorta, la línea se queda con los dígitos y un
  // formulario sin ningún tipo marcado significa "los contactos no cuentan"
  const params = leerParamsInteraccion({
    dias: formData.get("dias"),
    linea: formData.get("linea"),
    min_del_doctor: formData.get("min_del_doctor"),
    min_nuestros: formData.get("min_nuestros"),
    min_dias: formData.get("min_dias"),
    min_contactos: formData.get("min_contactos"),
    tipos_contacto: formData.getAll("tipos_contacto"),
  });
  const { error } = await supabase
    .from("automation_rules")
    .update({ params })
    .eq("key", INTERACCION_RULE_KEY);
  if (error) {
    console.error("guardarInteraccion:", error.message);
    return;
  }
  const { error: errRecalc } = await supabase.rpc("recompute_interaccion", {
    p_doctor: null,
  });
  if (errRecalc) console.error("recompute_interaccion:", errRecalc.message);
  revalidatePath("/ajustes");
  revalidatePath("/doctores");
}

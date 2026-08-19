"use server";

// Metas por comercial (pedido de Pancho 19/8): contactos, videollamadas,
// KeepDays y casos. Las tres primeras son métricas nuevas en goals; "casos"
// reusa la métrica existente 'paid_cases' por persona (la cuota OKR que la
// tabla de /equipo ya muestra como "Objetivo") — dos números para la misma
// cosa sería pedir inconsistencia.
//
// Sin upsert de PostgREST: el índice único de goals usa coalesce(user_id)
// (funcional), y on_conflict solo acepta columnas — se resuelve con
// select → update/insert, que para un form de 4 números por persona alcanza.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { monthStartMX } from "@/lib/dates";

const METRICAS_COMERCIAL = [
  "contactos",
  "videollamadas",
  "keepdays",
  "paid_cases",
] as const;

export async function guardarMetasComercial(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sin sesión");

  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user.id)
    .single();
  if (!["ADMIN", "COUNTRY_MANAGER", "SALES_MANAGER"].includes(profile?.rol ?? "")) {
    throw new Error("Solo roles de gestión pueden estipular metas");
  }

  const userId = String(formData.get("user_id") ?? "");
  if (!userId) throw new Error("Falta user_id");
  const period = monthStartMX();

  for (const metric of METRICAS_COMERCIAL) {
    const raw = formData.get(metric);
    if (raw === null || raw === "") continue; // vacío = no tocar
    const target = Number(raw);
    if (!Number.isFinite(target) || target < 0) continue;

    const { data: existing } = await supabase
      .from("goals")
      .select("id")
      .eq("period", period)
      .eq("metric", metric)
      .eq("user_id", userId)
      .maybeSingle();
    if (existing) {
      const { error } = await supabase
        .from("goals")
        .update({ target })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("goals")
        .insert({ period, metric, target, user_id: userId });
      if (error) throw error;
    }
  }
  revalidatePath("/equipo");
}

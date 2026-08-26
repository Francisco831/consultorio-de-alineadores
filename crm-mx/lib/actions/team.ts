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

/**
 * Con qué línea de la organización de Periskope atiende cada persona
 * (decisión 26/8). Saberlo es lo único que habilita avisar "este chat entra por
 * TU línea": el CRM no puede forzar nada del lado de Periskope.
 *
 * Un solo campo, y quién puede tocarlo lo decide RLS (profiles_update_own: la
 * propia, o todas si sos manager). Acá solo se detecta el rechazo con
 * .select("id"), porque una policy que no matchea no devuelve error: devuelve
 * cero filas.
 */
export async function setLineaPeriskope(
  formData: FormData
): Promise<{ error: string } | { ok: true }> {
  const userId = String(formData.get("user_id") ?? "");
  if (!userId) return { error: "Falta a quién asignarle la línea" };

  // Lo que se copia desde Periskope suele venir como "5215510685144@c.us", o
  // con +, espacios o guiones: nos quedamos con los dígitos.
  const crudo = String(formData.get("linea") ?? "").replace(/@c\.us$/i, "");
  const digitos = crudo.replace(/\D/g, "");
  const linea = digitos === "" ? null : digitos;

  // Mismo rango que el check de la 0041 (11 a 15 dígitos): validarlo acá hace
  // que el mensaje sea entendible en vez de un error de Postgres en crudo.
  const FORMATO =
    "La línea son solo dígitos, sin más ni espacios: por ejemplo 5215510685144";
  if (linea !== null && (linea.length < 11 || linea.length > 15)) {
    return { error: FORMATO };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({ periskope_org_phone: linea })
    .eq("id", userId)
    .select("id");
  if (error) {
    // 23514 = violación de check: solo puede ser el formato de la línea.
    return { error: error.code === "23514" ? FORMATO : error.message };
  }
  if (!data?.length)
    return { error: "No podés cambiar la línea de otra persona" };

  revalidatePath("/ajustes");
  revalidatePath("/hoy");
  revalidatePath("/panel");
  return { ok: true };
}

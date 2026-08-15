"use server";

// Administrar quién puede tener cuenta (auth_allowlist, migración 0031).
//
// Sin esto, invitar a alguien es un INSERT a mano contra producción — que es
// justamente el momento en que menos ganas hay de abrir una terminal. La lista es
// el respaldo en código del toggle disable_signup: un alta cuyo mail no esté acá
// aborta la transacción del alta en handle_new_user().
//
// Devuelven {error} en vez de void a propósito: son acciones de gestión donde un
// fallo silencioso es peor que el error. Media docena de acciones de admin.ts
// todavía se tragan sus errores con console.error; este archivo no suma a eso.

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { SupabaseClient, User } from "@supabase/supabase-js";

type Resultado = { error?: string; ok?: string };

/** Sesión con permisos de manager, que es lo que exige la policy de la tabla. */
async function managerSession(): Promise<
  { supabase: SupabaseClient; user: User } | { error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user.id)
    .single();
  if (!profile || !["ADMIN", "COUNTRY_MANAGER", "SALES_MANAGER"].includes(profile.rol)) {
    return { error: "Solo un manager puede administrar las invitaciones" };
  }
  return { supabase, user };
}

// Deliberadamente permisiva: valida la forma, no la existencia. Un dominio raro es
// asunto de quien invita; lo que no puede pasar es que entre una fila que después
// no matchee contra ningún alta.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** La base normaliza igual (trigger de 0031); acá se hace antes para poder avisar. */
function normalizar(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim().toLowerCase();
}

export async function invitarMail(formData: FormData): Promise<Resultado> {
  const sesion = await managerSession();
  if ("error" in sesion) return { error: sesion.error };
  const { supabase, user } = sesion;

  const email = normalizar(formData.get("email"));
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!email) return { error: "Falta el email" };
  if (!EMAIL_RE.test(email)) return { error: `"${email}" no parece un email` };

  // Si ya estaba pero dado de baja, invitar de nuevo lo reactiva en vez de chocar
  // contra el unique con un error que no le dice nada a nadie.
  const { data: existente } = await supabase
    .from("auth_allowlist")
    .select("id, active")
    .eq("email", email)
    .maybeSingle();

  if (existente) {
    if (existente.active) return { error: `${email} ya está invitado` };
    const { data, error } = await supabase
      .from("auth_allowlist")
      .update({ active: true, removed_by: null, removed_at: null, note })
      .eq("id", existente.id)
      .select("id");
    if (error) return { error: error.message };
    if (!data?.length) return { error: "No se pudo reactivar (sin permisos)" };
    revalidatePath("/ajustes");
    return { ok: `${email} vuelve a estar invitado` };
  }

  const { data, error } = await supabase
    .from("auth_allowlist")
    .insert({ email, note, added_by: user.id })
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "No se pudo invitar (sin permisos)" };

  revalidatePath("/ajustes");
  return { ok: `${email} invitado. Ya se le puede crear la cuenta.` };
}

export async function revocarInvitacion(formData: FormData): Promise<Resultado> {
  const sesion = await managerSession();
  if ("error" in sesion) return { error: sesion.error };
  const { supabase, user } = sesion;

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "Falta la invitación" };

  // Baja LÓGICA: se puede revertir y queda quién y cuándo. Y no echa a nadie —
  // el trigger de alta es AFTER INSERT y no vuelve a correr para quien ya existe.
  const { data, error } = await supabase
    .from("auth_allowlist")
    .update({ active: false, removed_by: user.id, removed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("active", true)
    .select("email");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "La invitación ya estaba dada de baja o no existe" };

  revalidatePath("/ajustes");
  return {
    ok: `${data[0].email} ya no puede crear cuenta. Si ya tenía uno, sigue entrando.`,
  };
}

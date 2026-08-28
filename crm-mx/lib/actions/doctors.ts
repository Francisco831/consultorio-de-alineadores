"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function updateDoctorContact(formData: FormData) {
  const id = String(formData.get("id"));
  const fields = {
    phone: (String(formData.get("phone") ?? "").trim() || null) as string | null,
    whatsapp: (String(formData.get("whatsapp") ?? "").trim() || null) as string | null,
    email: (String(formData.get("email") ?? "").trim() || null) as string | null,
    // `state` es la celda "Estado" que pidió Juan (27/8): un <select> con las 32
    // entidades, así que lo que llega es siempre uno de esos nombres o vacío.
    state: (String(formData.get("state") ?? "").trim() || null) as string | null,
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

/**
 * Deja SOLO el handle de Instagram: minúsculas, sin arroba, sin el link
 * completo y sin la barra final. La base tiene un check de formato
 * (^[a-z0-9._]{1,30}$, migración 0036) y un unique parcial, así que lo que no
 * normalicemos acá vuelve como error de constraint.
 */
function handleInstagram(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^(?:instagram\.com|instagr\.am)\//, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "") // barra final y lo que venga colgado (?igshid=…)
    .replace(/\?.*$/, "");
}

/**
 * Redes y cumpleaños del doctor (migración 0040).
 *
 * Va aparte de updateDoctorContact porque son dos momentos distintos: el
 * teléfono se carga cuando se consigue, las redes cuando se investiga al
 * doctor. `accredited_at` NO está acá a propósito: la blinda el trigger
 * doctors_guard (0019) y solo la escribe el journey al acreditar.
 */
export async function updateDoctorRedes(formData: FormData) {
  const id = String(formData.get("id"));
  const texto = (k: string) => String(formData.get(k) ?? "").trim() || null;
  const ig = String(formData.get("instagram") ?? "").trim();
  const tt = String(formData.get("tiktok") ?? "").trim();
  const fields = {
    // el || null cubre al que escribe solo "@" o solo el link: normalizado
    // queda vacío, y "" no pasa el check de formato de la base
    instagram: (ig ? handleInstagram(ig) : "") || null,
    // TikTok solo pierde la arroba: puede quedar un link y lo linkeamos igual
    tiktok: (tt ? tt.replace(/^@/, "").trim() : "") || null,
    facebook: texto("facebook"),
    linkedin: texto("linkedin"),
    website: texto("website"),
    // el input date manda "" cuando se borra; la columna es date, no acepta ""
    birth_date: texto("birth_date"),
  };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("doctors")
    .update(fields)
    .eq("id", id)
    .select("id");
  if (error) {
    // los constraints de la base hablan en jerga de Postgres: traducirlos, que
    // quien carga entienda qué corregir sin abrir el SQL
    if (error.code === "23505")
      return { error: "Ese Instagram ya está cargado en otra ficha" };
    if (error.code === "23514") {
      if (error.message.includes("instagram"))
        return {
          error: "El Instagram tiene que ser el usuario solo, sin arroba ni link",
        };
      if (error.message.includes("birth_date"))
        return { error: "Revisá la fecha de cumpleaños" };
    }
    return { error: error.message };
  }
  if (!data?.length)
    return { error: "No se pudo guardar: tu rol no tiene permisos de edición" };
  revalidatePath(`/doctores/${id}`);
  revalidatePath("/doctores");
  return { ok: true };
}

/**
 * Las notas libres del doctor (doctors.observaciones, migración 0048): lo que
 * Rocío o Juan quieran anotar de esa relación. Va aparte de updateDoctorRedes a
 * propósito — se guarda desde su propio recuadro en la ficha, sin abrir un
 * diálogo, porque la idea es que anotar cueste dos segundos.
 *
 * Lo que se escriba acá es lo PRIMERO que usa el brief previo a la llamada
 * (lib/brief-doctor.ts): le gana a cualquier regla que deduzca el sistema.
 */
export async function updateDoctorObservaciones(formData: FormData) {
  const id = String(formData.get("id"));
  const texto = String(formData.get("observaciones") ?? "").trim();
  if (texto.length > 2000) {
    return { error: "Son notas, no un informe: máximo 2.000 caracteres" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("doctors")
    .update({ observaciones: texto || null })
    .eq("id", id)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length)
    return { error: "No se pudo guardar: tu rol no tiene permisos de edición" };
  revalidatePath(`/doctores/${id}`);
  revalidatePath("/hoy");
  revalidatePath("/panel");
  return { ok: true };
}

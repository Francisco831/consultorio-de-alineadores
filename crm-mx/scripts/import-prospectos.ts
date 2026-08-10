/**
 * Crea como doctores (lifecycle 'prospecto') los contactos clasificados
 * doctor_probable en el análisis de WhatsApp (data/whatsapp_analisis_final.json).
 * Son los leads comerciales activos que hoy nadie trackea.
 *
 * Idempotente: matchea por teléfono (whatsapp) o nombre normalizado existente.
 *   npx tsx scripts/import-prospectos.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { fetchAll } from "./lib/fetch-all";

config({ path: ".env.local" });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(dra?|doctora?)\.?\s*/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** canónico MX: solo dígitos; 521XXXXXXXXXX (móvil legacy WhatsApp) → 52XXXXXXXXXX.
 *  Sin esto, el mismo número no matchea entre el chat (521…) y Noloco (+52…). */
function canonPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  let d = p.replace(/\D/g, "");
  if (d.startsWith("521") && d.length === 13) d = "52" + d.slice(3);
  return d || null;
}

interface Activo {
  chat_id?: string;
  nombre?: string;
  segmento?: string;
  razon?: string;
}

async function main() {
  const final = JSON.parse(
    readFileSync(resolve(__dirname, "../data/whatsapp_analisis_final.json"), "utf8")
  );
  const activos: Activo[] = final.clasificacion_activos_no_doctor ?? [];
  // chats que el workflow ya matcheó a doctores reales NO son prospectos
  const recoveredChats = new Set(
    (final.matches_recuperados ?? []).map((m: { chat_id?: string }) => m.chat_id)
  );
  const probables = activos.filter(
    (a) =>
      /doctor_probable/i.test(a.segmento ?? "") && !recoveredChats.has(a.chat_id)
  );

  // paginado: sin esto se compara contra 1.000 de 6.4k y se pierde idempotencia
  const existing = await fetchAll<{
    id: string;
    nombre: string;
    phone: string | null;
    whatsapp: string | null;
  }>(db, "doctors", "id, nombre, phone, whatsapp");
  const byPhone = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const d of existing ?? []) {
    const p1 = canonPhone(d.phone);
    const p2 = canonPhone(d.whatsapp);
    if (p1) byPhone.set(p1, d.id);
    if (p2) byPhone.set(p2, d.id);
    byName.set(norm(d.nombre), d.id);
  }

  let created = 0,
    skipped = 0;
  for (const p of probables) {
    const nombre = (p.nombre ?? "").trim();
    if (!nombre) continue;
    const phone = canonPhone(p.chat_id?.replace(/@.*/, "") ?? null);
    if ((phone && byPhone.has(phone)) || byName.has(norm(nombre))) {
      skipped++;
      continue;
    }
    const { data: ins, error: insErr } = await db
      .from("doctors")
      .insert({
        nombre,
        phone,
        whatsapp: phone,
        // vienen de chats de WhatsApp vivos = contacto ya logrado
        lifecycle_stage: "contactado",
        acquisition_stage: "contactado",
        source: "inbound",
        tags: ["wa-prospecto"],
        is_demo: false,
      })
      .select("id")
      .single();
    if (insErr) throw insErr;
    created++;
    byName.set(norm(nombre), ins.id);
    if (phone) byPhone.set(phone, ins.id);
    // vincular su chat de WhatsApp si existe
    if (p.chat_id) {
      await db
        .from("wa_conversations")
        .update({ doctor_id: ins.id })
        .eq("periskope_chat_id", p.chat_id)
        .is("doctor_id", null);
    }
  }
  console.log(
    `Prospectos WhatsApp: ${created} creados, ${skipped} ya existían (de ${probables.length} probables)`
  );
}

main().catch((e) => {
  console.error("Import falló:", e);
  process.exit(1);
});

/**
 * Carga los chats de Periskope (export consola, data/whatsapp_periskope.json)
 * + los matches recuperados por el workflow (data/whatsapp_analisis_final.json)
 * en wa_conversations, y completa doctors.whatsapp donde falte.
 *
 *   npx tsx scripts/import-whatsapp.ts   (usa .env.local; override con env vars)
 *
 * Idempotente: upsert por periskope_chat_id.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key, { auth: { persistSession: false } });

// mismos alias que import-noloco (duplicados conocidos en Noloco)
const DOCTOR_ALIASES: Record<string, string> = { "2532": "2537" };

interface Chat {
  chat_id: string;
  nombre: string;
  tipo: string;
  lineas: string[];
  asignado: string | null;
  esperando_respuesta: boolean;
  actividad: "7d" | "30d" | "mas_30d";
  telefono_contacto: string | null;
  doctor_noloco?: { id: string } | null;
}

async function main() {
  const peri = JSON.parse(
    readFileSync(resolve(__dirname, "../data/whatsapp_periskope.json"), "utf8")
  );
  const final = JSON.parse(
    readFileSync(resolve(__dirname, "../data/whatsapp_analisis_final.json"), "utf8")
  );
  const chats: Chat[] = peri.chats;

  // matches recuperados: chat_id -> doctor noloco id (pisan/completan el match por nombre)
  const recovered = new Map<string, string>();
  for (const m of final.matches_recuperados ?? []) {
    if (m.chat_id && m.doctor_id) recovered.set(m.chat_id, String(m.doctor_id));
  }

  const { data: doctors, error: dErr } = await db
    .from("doctors")
    .select("id, noloco_id, whatsapp");
  if (dErr) throw dErr;
  const byNoloco = new Map((doctors ?? []).map((d) => [d.noloco_id, d]));

  const rows = chats.map((c) => {
    const rawId = recovered.get(c.chat_id) ?? c.doctor_noloco?.id ?? null;
    const doc = rawId ? byNoloco.get(DOCTOR_ALIASES[rawId] ?? rawId) : null;
    return {
      periskope_chat_id: c.chat_id,
      chat_name: c.nombre,
      phone: c.telefono_contacto,
      doctor_id: doc?.id ?? null,
      unanswered: c.esperando_respuesta,
      activity_bucket: c.actividad,
      lineas: c.lineas ?? [],
      asignado: c.asignado,
    };
  });

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db
      .from("wa_conversations")
      .upsert(rows.slice(i, i + 500), { onConflict: "periskope_chat_id" });
    if (error) throw error;
  }
  const matched = rows.filter((r) => r.doctor_id).length;
  console.log(`Chats upserted: ${rows.length} (${matched} con doctor)`);

  // completar doctors.whatsapp con el teléfono del canal (solo donde falta)
  let filled = 0;
  const bestByDoctor = new Map<string, string>();
  for (const r of rows) {
    if (r.doctor_id && r.phone && !bestByDoctor.has(r.doctor_id)) {
      bestByDoctor.set(r.doctor_id, r.phone);
    }
  }
  for (const d of doctors ?? []) {
    if (!d.whatsapp && bestByDoctor.has(d.id)) {
      const { error } = await db
        .from("doctors")
        .update({ whatsapp: bestByDoctor.get(d.id) })
        .eq("id", d.id);
      if (error) throw error;
      filled++;
    }
  }
  console.log(`doctors.whatsapp completados: ${filled}`);

  // el canal de Higuera Paul es su asistente → registrarla como contacto
  const higuera = byNoloco.get("1523") ?? byNoloco.get("6704");
  const { data: hig } = await db
    .from("doctors")
    .select("id")
    .ilike("nombre", "%Higuera Paul%")
    .limit(1);
  const higueraId = hig?.[0]?.id ?? higuera?.id;
  if (higueraId) {
    const asistChat = chats.find((c) => /Lorena Nu.ez Asistente Paul/i.test(c.nombre));
    if (asistChat?.telefono_contacto) {
      const { data: exists, error: cErr } = await db
        .from("contacts")
        .select("id")
        .eq("doctor_id", higueraId)
        .limit(1);
      if (cErr) throw cErr;
      if (!exists?.length) {
        const { error } = await db.from("contacts").insert({
          doctor_id: higueraId,
          nombre: "Lorena Nuñez",
          rol_en_clinica: "Asistente (canal real de WhatsApp del Dr. Higuera)",
          whatsapp: asistChat.telefono_contacto,
          phone: asistChat.telefono_contacto,
          es_principal: true,
        });
        if (error) throw error;
        console.log("Contacto creado: Lorena Nuñez (asistente de Higuera Paul)");
      }
    }
  }

  await db.from("sync_runs").insert({
    source: "periskope_export",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    rows_upserted: rows.length,
    status: "ok",
    log: { matched, filled, fuente: peri.fuente, generado: peri.generado },
  });
  console.log("WhatsApp import OK ✓");
}

main().catch((e) => {
  console.error("Import falló:", e);
  process.exit(1);
});

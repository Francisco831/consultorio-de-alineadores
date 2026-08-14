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
import { fetchAll } from "./lib/fetch-all";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

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
  await confirmarDestino({
    accion: "cargar los chats de Periskope en wa_conversations (upsert)",
    auto: process.argv.includes("--yes"),
  });
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

  // paginado obligatorio: con un select plano vuelven 1.000 de 7.034 doctores y
  // los chats de los demás se guardarían sin vínculo (y pisarían el que ya tenían).
  const doctors = await fetchAll<{
    id: string;
    noloco_id: string | null;
    whatsapp: string | null;
  }>(db, "doctors", "id, noloco_id, whatsapp");
  const byNoloco = new Map(doctors.map((d) => [d.noloco_id, d]));

  const rows = chats.map((c) => {
    const rawId = recovered.get(c.chat_id) ?? c.doctor_noloco?.id ?? null;
    const doc = rawId ? byNoloco.get(DOCTOR_ALIASES[rawId] ?? rawId) : null;
    return {
      chat: {
        periskope_chat_id: c.chat_id,
        chat_name: c.nombre,
        phone: c.telefono_contacto,
        unanswered: c.esperando_respuesta,
        activity_bucket: c.actividad,
        lineas: c.lineas ?? [],
        asignado: c.asignado,
      },
      doctorId: doc?.id ?? null,
    };
  });

  // Mismo cuidado que en import-enrichment: el upsert de PostgREST hace UPDATE de
  // todas las columnas del payload, así que un doctor_id null pisaría el vínculo
  // existente. Los chats sin doctor se mandan SIN la columna, en otra llamada.
  const conDoctor = rows
    .filter((r) => r.doctorId)
    .map((r) => ({ ...r.chat, doctor_id: r.doctorId as string }));
  const sinDoctor = rows.filter((r) => !r.doctorId).map((r) => r.chat);

  for (const lote of [conDoctor, sinDoctor]) {
    for (let i = 0; i < lote.length; i += 500) {
      const { error } = await db
        .from("wa_conversations")
        .upsert(lote.slice(i, i + 500), { onConflict: "periskope_chat_id" });
      if (error) throw error;
    }
  }
  const matched = conDoctor.length;
  console.log(
    `Chats upserted: ${rows.length} (${matched} con doctor, ` +
      `${sinDoctor.length} sin vínculo — su doctor_id no se toca)`
  );

  // completar doctors.whatsapp con el teléfono del canal (solo donde falta)
  let filled = 0;
  const bestByDoctor = new Map<string, string>();
  for (const r of rows) {
    if (r.doctorId && r.chat.phone && !bestByDoctor.has(r.doctorId)) {
      bestByDoctor.set(r.doctorId, r.chat.phone);
    }
  }
  for (const d of doctors) {
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
  salirConDestinoRechazado(e);
  console.error("Import falló:", e);
  process.exit(1);
});

/**
 * Importa los chats de la 5ta línea de Periskope (Dra. Rocío Puig, +54 9 11 2374
 * 0762) a wa_conversations. Fuente: data/whatsapp_rocio.json, reconstruido de la
 * cache de mensajes de la consola (la API REST sigue plan-gated). Mismo patrón
 * que import-whatsapp.ts: upsert por periskope_chat_id, sin pisar doctor_id.
 *
 *   npx tsx scripts/import-rocio.ts --dry-run   # solo lee, muestra matches
 *   npx tsx scripts/import-rocio.ts --yes       # escribe (guard de destino igual)
 *
 * Idempotente: correrlo dos veces deja la base igual.
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

const DRY = process.argv.includes("--dry-run");

interface Chat {
  chat_id: string;
  nombre: string;
  tipo: string;
  lineas: string[];
  asignado: string | null;
  esperando_respuesta: boolean;
  actividad: "7d" | "30d" | "mas_30d";
  telefono_contacto: string | null;
}

/** Canonicaliza un teléfono MX/AR a solo dígitos, quitando el "1" móvil de +52. */
function canon(raw: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("521") && d.length === 13) d = "52" + d.slice(3); // 521XXXXXXXXXX -> 52XXXXXXXXXX
  if (d.length === 10) d = "52" + d; // 10 díg = MX sin país
  return d || null;
}

async function main() {
  if (!DRY) {
    await confirmarDestino({
      accion: "cargar los 8 chats de la línea de Rocío en wa_conversations (upsert)",
      auto: process.argv.includes("--yes"),
    });
  }

  const src = JSON.parse(
    readFileSync(resolve(__dirname, "../data/whatsapp_rocio.json"), "utf8")
  );
  const chats: Chat[] = src.chats;

  const doctors = await fetchAll<{
    id: string;
    nombre: string | null;
    whatsapp: string | null;
    phone: string | null;
  }>(db, "doctors", "id, nombre, whatsapp, phone");

  // índice teléfono canónico -> doctor (whatsapp gana sobre phone)
  const byPhone = new Map<string, { id: string; nombre: string | null }>();
  for (const d of doctors) {
    for (const p of [d.phone, d.whatsapp]) {
      const c = canon(p);
      if (c) byPhone.set(c, { id: d.id, nombre: d.nombre });
    }
  }

  const rows = chats.map((c) => {
    const cc = canon(c.telefono_contacto);
    const doc = cc ? byPhone.get(cc) ?? null : null;
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
      doctorNombre: doc?.nombre ?? null,
    };
  });

  console.log(`\n  Chats de la línea de Rocío (${rows.length}):`);
  for (const r of rows) {
    const flag = r.chat.unanswered ? "🟠 espera" : "  ok    ";
    const match = r.doctorId ? `→ doctor: ${r.doctorNombre}` : "→ sin doctor en CRM";
    console.log(
      `   ${flag}  ${r.chat.chat_name.padEnd(42)} ${String(r.chat.phone ?? "(grupo)").padEnd(14)} ${match}`
    );
  }

  const conDoctor = rows
    .filter((r) => r.doctorId)
    .map((r) => ({ ...r.chat, doctor_id: r.doctorId as string }));
  const sinDoctor = rows.filter((r) => !r.doctorId).map((r) => r.chat);
  console.log(
    `\n  ${conDoctor.length} con doctor, ${sinDoctor.length} sin vínculo (entran con su nombre).`
  );

  if (DRY) {
    console.log("\n  DRY-RUN: no se escribió nada.\n");
    return;
  }

  for (const lote of [conDoctor, sinDoctor]) {
    if (!lote.length) continue;
    const { error } = await db
      .from("wa_conversations")
      .upsert(lote, { onConflict: "periskope_chat_id" });
    if (error) throw error;
  }

  // completar doctors.whatsapp donde falte (solo con teléfono de contacto real)
  let filled = 0;
  for (const r of rows) {
    if (r.doctorId && r.chat.phone) {
      const d = doctors.find((x) => x.id === r.doctorId);
      if (d && !d.whatsapp) {
        const { error } = await db
          .from("doctors")
          .update({ whatsapp: r.chat.phone })
          .eq("id", r.doctorId);
        if (error) throw error;
        filled++;
      }
    }
  }

  await db.from("sync_runs").insert({
    source: "periskope_rocio",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    rows_upserted: rows.length,
    status: "ok",
    log: { matched: conDoctor.length, filled, fuente: src.fuente, generado: src.generado },
  });

  console.log(`\n  Upsert OK ✓  (${conDoctor.length} con doctor, ${filled} whatsapp completados)\n`);
}

main().catch((e) => {
  salirConDestinoRechazado(e);
  console.error("Import falló:", e);
  process.exit(1);
});

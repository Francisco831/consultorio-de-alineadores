/**
 * Fusiona prospectos duplicados con doctores acreditados existentes.
 *
 * Causa: los teléfonos de WhatsApp usan el prefijo móvil viejo 521XXXXXXXXXX
 * y los de Noloco +52XXXXXXXXXX → el match por teléfono fallaba y el chat
 * quedó como "prospecto" nuevo en vez de vincularse al doctor real.
 *
 * Para cada NO acreditado cuyo teléfono canónico coincide con un acreditado:
 *   - vincula sus wa_conversations al doctor real
 *   - mueve opportunities / activities / tasks / alerts / contacts
 *   - borra el duplicado y recomputa el doctor real
 *
 * Idempotente (segunda corrida no encuentra duplicados).
 *
 *   npx tsx scripts/merge-prospect-dups.ts            lista las fusiones (no toca nada)
 *   npx tsx scripts/merge-prospect-dups.ts --aplicar  las ejecuta
 *
 * Borra filas de doctors: el modo por defecto NO escribe.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { fetchAll } from "./lib/fetch-all";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

/** canónico MX: solo dígitos; 521XXXXXXXXXX (móvil legacy) → 52XXXXXXXXXX */
export function canonPhone(p: string | null): string | null {
  if (!p) return null;
  let d = p.replace(/\D/g, "");
  if (d.startsWith("521") && d.length === 13) d = "52" + d.slice(3);
  return d || null;
}

async function main() {
  // paginado: con 6.4k doctores un select plano solo devuelve 1.000 y el dedupe
  // compararía contra un universo parcial
  const doctors = await fetchAll<{
    id: string;
    nombre: string;
    phone: string | null;
    whatsapp: string | null;
    noloco_id: string | null;
    is_accredited: boolean;
  }>(db, "doctors", "id, nombre, phone, whatsapp, noloco_id, is_accredited");

  const accreditedByPhone = new Map<string, { id: string; nombre: string }>();
  for (const d of doctors ?? []) {
    if (!d.is_accredited) continue;
    for (const p of [d.phone, d.whatsapp]) {
      const c = canonPhone(p);
      if (c && !accreditedByPhone.has(c)) accreditedByPhone.set(c, d);
    }
  }

  // Se resuelven TODAS las fusiones antes de escribir una sola: así el modo por
  // defecto puede mostrar exactamente qué va a pasar, y la confirmación se pide
  // una vez con el número real adelante.
  const fusiones: { dup: (typeof doctors)[number]; real: { id: string; nombre: string } }[] = [];
  for (const dup of doctors ?? []) {
    if (dup.is_accredited) continue;
    const c = canonPhone(dup.phone) ?? canonPhone(dup.whatsapp);
    if (!c) continue;
    const real = accreditedByPhone.get(c);
    if (!real || real.id === dup.id) continue;
    fusiones.push({ dup, real });
  }

  for (const { dup, real } of fusiones) {
    console.log(`merge: "${dup.nombre}" → "${real.nombre}"`);
  }
  console.log(`\n${fusiones.length} duplicados a fusionar`);
  if (fusiones.length === 0) return;
  if (!process.argv.includes("--aplicar")) {
    console.log("  (no se tocó nada — agregá --aplicar para ejecutarlo)");
    return;
  }

  await confirmarDestino({
    accion: `fusionar ${fusiones.length} prospectos duplicados y BORRAR sus fichas`,
    destructivo: true,
    auto: process.argv.includes("--yes"),
  });

  let merged = 0;
  for (const { dup, real } of fusiones) {
    // cases y payments PRIMERO: si el duplicado tenía casos o pagos y se borra
    // sin moverlos, se pierde facturación real (o falla la FK)
    for (const table of [
      "cases",
      "payments",
      "wa_conversations",
      "opportunities",
      "activities",
      "tasks",
      "alerts",
      "contacts",
    ]) {
      const { error: e } = await db
        .from(table)
        .update({ doctor_id: real.id })
        .eq("doctor_id", dup.id);
      if (e) throw new Error(`${table}: ${e.message}`);
    }
    const { error: delErr } = await db.from("doctors").delete().eq("id", dup.id);
    if (delErr) throw delErr;
    const { error: rcErr } = await db.rpc("recompute_doctor", { p_id: real.id });
    if (rcErr) console.warn(`  recompute ${real.nombre}: ${rcErr.message}`);
    merged++;
  }
  console.log(`${merged} duplicados fusionados ✓`);
}

main().catch((e) => {
  salirConDestinoRechazado(e);
  console.error("Merge falló:", e);
  process.exit(1);
});

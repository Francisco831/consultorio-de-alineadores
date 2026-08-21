/**
 * Sync de pagos: planilla "Administración México" (Facturación y Cobranzas)
 * → tabla payments del CRM → finanzas/seed-data/payments_mx.json.
 *
 *   npx tsx scripts/sync-pagos-planilla.ts                  # baja del Apps Script (PLANILLA_MX_URL/SECRET)
 *   npx tsx scripts/sync-pagos-planilla.ts --xlsx ~/Downloads/"Administración México.xlsx"
 *   … ambos aceptan --apply (sin él, dry-run) y --yes.
 *   --cron: corrida programada (launchd). Omite la confirmación interactiva de
 *   destino — la aprobó Pancho el 21/8/26 al programarla — pero los gates de
 *   deriva y mes cerrado siguen activos, y el resultado (ok o error) queda en
 *   sync_runs (source planilla_pagos) para que el silencio no esconda fallas.
 *
 * Claves adminmx:{fila}:{slot} idénticas al import original: correrlo dos veces
 * es no-op. Gates antes de escribir:
 *   1. DERIVA: si >20 pagos existentes cambian de monto o desaparecen de la
 *      planilla, se aborta (huele a filas corridas, no a correcciones).
 *   2. ANTI-REGRESIÓN: un mes cerrado no puede achicarse.
 * Los pagos nuevos entran sin doctor (doctor_id null); el vínculo lo hace
 * reconcile-ledger. Nunca se tocan doctor_id/case_id de filas existentes.
 * Al final (con --apply) copia el parse fresco a finanzas/seed-data/ para
 * correr import-payments-mx.ts del lado de finanzas.
 */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { confirmarDestino } from "./lib/destino";
import { fetchAll } from "./lib/fetch-all";

config({ path: resolve(__dirname, "../.env.local"), quiet: true });

type Pago = {
  external_key: string; doctor_nombre_raw: string | null; noloco_id: string | null;
  case_external_id: string | null; paciente: string | null;
  amount_mxn: number; paid_at: string; method: string | null; notes: string | null;
};

const APPLY = process.argv.includes("--apply");
const CRON = process.argv.includes("--cron");
const PARSED = resolve(__dirname, "../data/pagos_planilla.json");
const SEED_FINANZAS = resolve(__dirname, "../../finanzas/seed-data/payments_mx.json");
const CASOS = resolve(__dirname, "../data/casos_planilla.json");
const SEED_CASOS = resolve(__dirname, "../../finanzas/seed-data/casos_mx.json");

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function obtenerParse(): Promise<Pago[]> {
  const xlsx = argValor("xlsx");
  if (xlsx) {
    execFileSync("python3", [resolve(__dirname, "parse_pagos_planilla.py"), "--xlsx", xlsx], { stdio: "inherit" });
  } else {
    const url = process.env.PLANILLA_MX_URL, secret = process.env.PLANILLA_MX_SECRET;
    if (!url || !secret) {
      console.error(
        "Falta PLANILLA_MX_URL / PLANILLA_MX_SECRET en crm-mx/.env.local (Apps Script sin instalar).\n" +
        "Instalación: scripts/gas-pagos-planilla.gs. Mientras tanto: --xlsx <export manual de la sheet>."
      );
      process.exit(1);
    }
    const res = await fetch(`${url}?secret=${encodeURIComponent(secret)}`);
    const texto = await res.text();
    if (!res.ok || !texto.startsWith("{")) {
      throw new Error(`Apps Script respondió raro (HTTP ${res.status}): ${texto.slice(0, 120)}`);
    }
    const tmp = resolve(__dirname, "../data/pagos_planilla_gas.json");
    writeFileSync(tmp, texto);
    execFileSync("python3", [resolve(__dirname, "parse_pagos_planilla.py"), "--json", tmp], { stdio: "inherit" });
  }
  return JSON.parse(readFileSync(PARSED, "utf8"));
}

async function main() {
  const frescos: Pago[] = process.argv.includes("--parsed")
    ? JSON.parse(readFileSync(PARSED, "utf8"))   // usar data/pagos_planilla.json ya generado
    : await obtenerParse();
  const porKey = new Map(frescos.map((p) => [p.external_key, p]));

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const existentes = await fetchAll<{
    id: string; external_key: string; amount_mxn: number; paid_at: string;
    method: string | null; notes: string | null; paciente: string | null;
  }>(db, "payments", "id, external_key, amount_mxn, paid_at, method, notes, paciente");
  const exByKey = new Map(existentes.map((p) => [p.external_key, p]));

  // ---- GATE 1: deriva de filas ----
  const desaparecidos = existentes.filter((p) => !porKey.has(p.external_key));
  const cambiadosMonto = existentes.filter((p) => {
    const f = porKey.get(p.external_key);
    return f && Math.abs(Number(p.amount_mxn) - f.amount_mxn) > 0.01;
  });
  const deriva = desaparecidos.length + cambiadosMonto.length;
  if (deriva) {
    console.log(`⚠ deriva: ${desaparecidos.length} pagos ya no están en la planilla, ${cambiadosMonto.length} cambiaron de monto`);
    for (const p of [...desaparecidos, ...cambiadosMonto].slice(0, 10)) {
      const f = porKey.get(p.external_key);
      console.log(`   ${p.external_key} ${p.paid_at} $${p.amount_mxn}${f ? ` → $${f.amount_mxn}` : " (desapareció)"}`);
    }
    if (deriva > 20) {
      throw new Error(`deriva de ${deriva} pagos — parece corrimiento de filas en la planilla, no correcciones. ABORTO sin escribir.`);
    }
  }

  // ---- GATE 2: mes cerrado no se achica ----
  const mesActual = new Date().toISOString().slice(0, 7);
  const sum = (xs: { paid_at: string; amount_mxn: number }[]) => {
    const m = new Map<string, number>();
    for (const p of xs) {
      if (p.paid_at < "2026-01-01") continue;
      const k = p.paid_at.slice(0, 7);
      m.set(k, (m.get(k) ?? 0) + Number(p.amount_mxn));
    }
    return m;
  };
  const antes = sum(existentes), despues = sum(frescos);
  for (const [mes, total] of [...antes].sort()) {
    if (mes >= mesActual) continue;
    const nuevo = despues.get(mes) ?? 0;
    if (nuevo < total - 0.01) {
      throw new Error(`mes cerrado ${mes} se achica: ${total.toFixed(2)} → ${nuevo.toFixed(2)}. ABORTO sin escribir.`);
    }
  }

  // ---- plan ----
  // notes: la planilla solo aporta la parte "fac:…"; el CRM le agrega cosas
  // propias ("Doctor sin matchear: …") que este sync no debe pisar.
  const facDe = (n: string | null) => n?.match(/fac:\s*([^\s·]+)/i)?.[1] ?? null;
  const mergeNotes = (deDb: string | null, facFresco: string | null) => {
    const sinFac = (deDb ?? "").replace(/\s*·?\s*fac:[^\s·]+/i, "").trim() || null;
    if (!facFresco) return sinFac;
    return sinFac ? `${sinFac} · fac:${facFresco}` : `fac:${facFresco}`;
  };

  const nuevos = frescos.filter((p) => !exByKey.has(p.external_key));
  const editados = frescos.filter((p) => {
    const e = exByKey.get(p.external_key);
    return e && (
      Math.abs(Number(e.amount_mxn) - p.amount_mxn) > 0.01 || e.paid_at !== p.paid_at ||
      (e.method ?? null) !== p.method || facDe(e.notes) !== facDe(p.notes) ||
      (e.paciente ?? null) !== p.paciente
    );
  });
  console.log(`\nPlanilla: ${frescos.length} pagos · CRM: ${existentes.length} · nuevos: ${nuevos.length} · editados: ${editados.length}`);
  for (const p of nuevos.slice(0, 15)) {
    console.log(`  + ${p.paid_at}  $${p.amount_mxn.toLocaleString("es-MX")}  ${p.doctor_nombre_raw ?? "(sin doctor)"} · ${p.paciente ?? ""}`);
  }
  if (nuevos.length > 15) console.log(`  … y ${nuevos.length - 15} más`);

  if (!APPLY) { console.log("\nDRY-RUN (sin --apply no escribe)."); return; }
  if (CRON) {
    console.log("  (corrida programada: guard interactivo omitido, gates activos)");
  } else {
    await confirmarDestino({
      accion: `sync pagos planilla: ${nuevos.length} altas + ${editados.length} ediciones`,
      auto: process.argv.includes("--yes"),
    });
  }

  if (nuevos.length) {
    const filas = nuevos.map((p) => ({
      external_key: p.external_key, paciente: p.paciente, amount_mxn: p.amount_mxn,
      paid_at: p.paid_at, method: p.method, notes: p.notes, source: "import", is_demo: false,
    }));
    for (let i = 0; i < filas.length; i += 500) {
      const { error } = await db.from("payments").insert(filas.slice(i, i + 500));
      if (error) throw new Error(`alta de pagos: ${error.message}`);
    }
  }
  for (const p of editados) {
    const e = exByKey.get(p.external_key)!;
    const { error } = await db.from("payments").update({
      amount_mxn: p.amount_mxn, paid_at: p.paid_at, method: p.method,
      notes: mergeNotes(e.notes, facDe(p.notes)), paciente: p.paciente,
    }).eq("external_key", p.external_key);
    if (error) throw new Error(`edición ${p.external_key}: ${error.message}`);
  }

  writeFileSync(SEED_FINANZAS, JSON.stringify(frescos, null, 1));
  try { writeFileSync(SEED_CASOS, readFileSync(CASOS)); } catch { /* parse viejo sin casos */ }
  await db.from("sync_runs").insert({
    source: "planilla_pagos", finished_at: new Date().toISOString(), status: "ok",
    rows_upserted: nuevos.length + editados.length,
    log: { pagos_planilla: frescos.length, nuevos: nuevos.length, editados: editados.length, cron: CRON },
  });
  console.log(`✓ CRM al día (${nuevos.length} altas, ${editados.length} ediciones) · parse copiado a finanzas/seed-data/payments_mx.json`);
  console.log("Siguiente: en finanzas/, npx tsx scripts/import-payments-mx.ts --apply  (y reconcile-ledger.ts acá si hay doctores nuevos)");
}

main().catch(async (e) => {
  console.error(e.message ?? e);
  if (CRON) {
    try {
      const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
      await db.from("sync_runs").insert({
        source: "planilla_pagos", finished_at: new Date().toISOString(), status: "error",
        log: { error: String(e.message ?? e).slice(0, 500), cron: true },
      });
    } catch { /* si ni esto anda, queda el log de launchd */ }
  }
  process.exit(1);
});

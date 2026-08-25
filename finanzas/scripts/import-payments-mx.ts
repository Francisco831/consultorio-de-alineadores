// Siembra los ingresos MX 2026 desde el ledger del CRM (seed-data/payments_mx.json,
// snapshot validado Δ$0 mes a mes contra el cierre contable Ene–Jul 2026).
// Solo pagos con paid_at >= 2026-01-01. external_key = la del CRM (adminmx:N:M):
// el sync futuro CRM→finanzas usa la misma clave y nunca duplica.
//
// GATE: Δ$0 por mes contra la fuente, o el script sale con error.
//
// Uso:  npx tsx scripts/import-payments-mx.ts            (dry-run)
//       npx tsx scripts/import-payments-mx.ts --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, upsertBatched, fetchAllRows, argFlags } from "./lib/service-client";
import { registrarSync } from "./lib/sync-run";

type PagoMX = {
  external_key: string; doctor_nombre_raw: string | null; noloco_id: string | null;
  case_external_id: string | null; paciente: string | null;
  amount_mxn: number; paid_at: string; method: string | null; notes: string | null;
};

async function main() {
  const flags = argFlags();
  const todos: PagoMX[] = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/payments_mx.json"), "utf8")
  );
  const pagos = todos.filter((p) => p.paid_at >= "2026-01-01" && p.paid_at < "2027-01-01");

  const esperado = new Map<string, number>();
  for (const p of pagos) {
    const k = p.paid_at.slice(0, 7);
    esperado.set(k, Math.round(((esperado.get(k) ?? 0) + p.amount_mxn) * 100) / 100);
  }

  console.log(`Fuente: ${pagos.length} pagos 2026 (de ${todos.length} históricos).`);
  if (flags.dryRun) {
    console.log("DRY-RUN (sin --apply no escribe). MXN por mes:");
    for (const [k, v] of [...esperado].sort()) console.log(`  ${k}: ${v.toLocaleString("es-MX")}`);
    return;
  }

  const db = await serviceClient({
    accion: `sembrar ${pagos.length} ingresos MX 2026 (ledger CRM)`,
    auto: flags.yes,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "mx").single();
  if (!cia) throw new Error("empresa 'mx' inexistente: correr seed-base primero");
  const companyId = cia.id;

  const { data: accounts } = await db.from("accounts").select("id, name").eq("company_id", companyId);
  const accByName = Object.fromEntries((accounts ?? []).map((a) => [a.name, a.id]));
  const bbva = accByName["BBVA"];
  const mp = accByName["Mercado Pago"];
  if (!bbva || !mp) throw new Error("faltan cuentas MX: correr seed-base");

  const { data: cat } = await db.from("categories").select("id")
    .eq("company_id", companyId).eq("name", "Tratamientos").single();
  if (!cat) throw new Error("falta la categoría 'Tratamientos': correr seed-base");

  // doctores get-or-create
  const existing = await fetchAllRows<{ id: string; display_name: string }>(
    db, "counterparties", "id, display_name", (q) => q.eq("company_id", companyId).eq("kind", "doctor_customer")
  );
  const docByName = new Map(existing.map((c) => [c.display_name.trim().toLowerCase(), c.id]));
  const nuevos = new Map<string, string>();
  for (const p of pagos) {
    const d = (p.doctor_nombre_raw ?? "").trim();
    if (d && !docByName.has(d.toLowerCase())) nuevos.set(d.toLowerCase(), d);
  }
  if (nuevos.size) {
    const { error } = await db.from("counterparties").insert(
      [...nuevos.values()].map((name) => ({ company_id: companyId, kind: "doctor_customer", display_name: name }))
    );
    if (error) throw new Error(`alta de doctores: ${error.message}`);
    const refreshed = await fetchAllRows<{ id: string; display_name: string }>(
      db, "counterparties", "id, display_name", (q) => q.eq("company_id", companyId).eq("kind", "doctor_customer")
    );
    docByName.clear();
    for (const c of refreshed) docByName.set(c.display_name.trim().toLowerCase(), c.id);
    console.log(`✓ ${nuevos.size} doctores creados`);
  }

  const rows = pagos.map((p) => {
    const fc = p.notes?.match(/fac:\s*([A-Z]{2}-\d+)/i)?.[1] ?? null;
    return {
      company_id: companyId,
      account_id: p.method === "MP" ? mp : bbva,   // TR y Depósito entran por BBVA
      currency: "MXN",
      kind: "income",
      status: "confirmed",
      occurred_on: p.paid_at,
      amount: p.amount_mxn,
      category_id: cat.id,
      counterparty_id: p.doctor_nombre_raw
        ? (docByName.get(p.doctor_nombre_raw.trim().toLowerCase()) ?? null)
        : null,
      description: p.paciente ? `Pago caso ${p.case_external_id ?? ""} · ${p.paciente}`.trim() : "Pago tratamiento",
      source: "seed",
      external_key: p.external_key,
      meta: {
        case_external_id: p.case_external_id, noloco_id: p.noloco_id,
        paciente: p.paciente, method_raw: p.method, notes: p.notes, fc,
      },
    };
  });

  const written = await upsertBatched(db, "movements", rows, "company_id,external_key");
  console.log(`✓ ${written} pagos upserteados`);
  const corrida = await registrarSync(db, "pagos_mx", companyId);

  // ---------- GATE Δ$0 ----------
  const enBase = await fetchAllRows<{ occurred_on: string; amount: string }>(
    db, "movements", "occurred_on, amount",
    (q) => q.eq("company_id", companyId).eq("source", "seed").eq("kind", "income").neq("status", "void")
  );
  const real = new Map<string, number>();
  for (const r of enBase) {
    const k = r.occurred_on.slice(0, 7);
    real.set(k, Math.round(((real.get(k) ?? 0) + Number(r.amount)) * 100) / 100);
  }
  let falla = false;
  for (const [k, v] of [...esperado].sort()) {
    const got = real.get(k) ?? 0;
    const ok = Math.abs(got - v) < 0.01;
    if (!ok) falla = true;
    console.log(`  ${ok ? "✓" : "✗ GATE"} ${k}: fuente ${v.toLocaleString("es-MX")} · base ${got.toLocaleString("es-MX")}`);
  }
  if (enBase.length !== pagos.length) {
    console.log(`  ✗ GATE conteo: fuente ${pagos.length} · base ${enBase.length}`);
    falla = true;
  }
  if (falla) {
    await corrida.fallo("Δ≠0 contra el ledger del CRM");
    console.error("\n✗ EL GATE FALLÓ: Δ≠0 contra el ledger del CRM. NO usar estos números.");
    process.exit(1);
  }
  await corrida.ok({ leidas: pagos.length, escritas: written });
  console.log(`\n✓ GATE OK: Δ$0 mes a mes contra el ledger del CRM (${pagos.length} pagos).`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

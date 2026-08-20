// La tarjeta Clara deja de ser una caja negra: pasa a ser una CUENTA.
//
// Fuente: seed-data/clara_mx.csv (export completo de la app de Clara,
// 20/8/2026). Solo transacciones Autorizada desde el 1/1/2026; el corte
// dic-2025 (3/12–31/12) suma EXACTAMENTE 46.603,57 = el pago manual por STP
// de enero → la cuenta abre con esa deuda y el pago de enero la salda.
//
// Qué hace:
//   1. Crea la cuenta "Clara" (MXN, external, fuera de los totales de caja:
//      su saldo es deuda con la tarjeta, no plata disponible).
//   2. Cada consumo = gasto desde Clara, clasificado por comercio primero y
//      por la categoría de Clara después. RETIRO DE EFECTIVO = transferencia
//      Clara→Efectivo.
//   3. Los pagos que salían de BBVA como gasto "Tarjeta Clara" (STP enero +
//      domiciliaciones Actinver) se ANULAN y se recrean como transferencias
//      BBVA→Clara, re-conciliadas con su línea de extracto original.
//
// GATE: la suma mensual de gastos creados debe ser la del CSV.
//
// Uso:  npx tsx scripts/import-clara-mx.ts            (dry-run)
//       npx tsx scripts/import-clara-mx.ts --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "papaparse";
import { serviceClient, upsertBatched, fetchAllRows, argFlags } from "./lib/service-client";
import { KeyBuilder, sha256Hex } from "../lib/import/keys";

const APERTURA = -46603.57;   // deuda al 1/1/26 = corte dic (3-31/12), verificado

type Fila = Record<string, string>;

// comercio primero (más preciso), categoría de Clara como red de seguridad
const POR_COMERCIO: Array<{ patron: RegExp; categoria: string; nota?: string }> = [
  { patron: /SKYDROPX|DHL|Lalamove|United Parcel|ESTAFETA|FEDEX|PAQUETEXPRESS/i, categoria: "Envíos" },
  { patron: /XIPECUBICO/i, categoria: "Consumibles de producción", nota: "Xipe Cúbico: insumos de impresión 3D" },
  { patron: /MUZCOMP/i, categoria: "Resina", nota: "resina de impresión (confirmado Pancho 20/8/26)" },
  { patron: /TIENDADD|DENTAL|DENTIMEX/i, categoria: "Consumibles de producción" },
  { patron: /\bCFE\b/i, categoria: "Energía" },
  { patron: /TELMEX|TELCEL|IZZI|ATT|TOTALPLAY/i, categoria: "Comunicaciones" },
  { patron: /META ?PLATFORMS|FACEBK|GOOGLE ?ADS/i, categoria: "Marketing" },
];
const POR_CATEGORIA_CLARA: Record<string, string> = {
  "Transporte": "Viáticos y viajes", "Viajes": "Viáticos y viajes",
  "Alimentos": "Viáticos y viajes", "Combustibles": "Viáticos y viajes",
  "Comunicaciones": "Comunicaciones", "Publicidad Digital": "Marketing",
  "Software Y Hardware": "Software", "Subscripciones": "Software",
  "Salud": "Otros gastos", "Venta Minorista": "Otros gastos",
  "Comercio Digital": "Otros gastos", "Otros": "Otros gastos",
  "Electrónicos": "Otros gastos", "Pagos Gubernamentales": "Otros gastos",
};

async function main() {
  const flags = argFlags();
  const csv = readFileSync(resolve(__dirname, "../seed-data/clara_mx.csv"), "utf8");
  const { data: filas } = parse<Fila>(csv, { header: true, skipEmptyLines: true });

  const txs = filas.filter((r) =>
    r["Estado"] === "Autorizada" &&
    (r["Fecha de Transacción"] ?? "") >= "2026-01-01"
  );
  const porMes = new Map<string, number>();
  for (const t of txs) {
    const k = t["Fecha de Transacción"].slice(0, 7);
    porMes.set(k, Math.round(((porMes.get(k) ?? 0) + Number(t["Monto en MXN"])) * 100) / 100);
  }
  console.log(`${txs.length} consumos 2026 · por mes:`);
  for (const [k, v] of [...porMes].sort()) console.log(`  ${k}: ${v.toLocaleString("es-MX")}`);

  const sinRegla = txs.filter((t) =>
    !POR_COMERCIO.some((r) => r.patron.test(t["Transacción"])) &&
    !/RETIRO DE EFECTIVO/i.test(t["Transacción"]) &&
    !POR_CATEGORIA_CLARA[t["Categoría de Compra"]]);
  console.log(`  sin regla (quedan sin categoría): ${sinRegla.length}`);
  if (flags.dryRun) { console.log("\nDRY-RUN (sin --apply no escribe)."); return; }

  const db = await serviceClient({
    accion: "convertir la tarjeta Clara en cuenta: consumos + pagos como transferencias",
    auto: flags.yes,
  });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "mx").single();
  if (!cia) throw new Error("empresa 'mx' inexistente");
  const companyId = cia.id;

  // ---- cuenta Clara ----
  let { data: clara } = await db.from("accounts").select("id")
    .eq("company_id", companyId).eq("name", "Clara").maybeSingle();
  if (!clara) {
    const { data: c, error } = await db.from("accounts").insert({
      company_id: companyId, name: "Clara", type: "external", currency: "MXN",
      include_in_totals: false, opening_balance: APERTURA,
    }).select("id").single();
    if (error) throw new Error(`cuenta Clara: ${error.message}`);
    clara = c;
    console.log("✓ cuenta Clara creada (saldo = deuda con la tarjeta)");
  }
  const { data: accounts } = await db.from("accounts").select("id, name").eq("company_id", companyId);
  const accByName = Object.fromEntries((accounts ?? []).map((a) => [a.name, a.id]));
  const bbva = accByName["BBVA"], efectivo = accByName["Efectivo"];

  // ---- categorías ----
  const { data: cats } = await db.from("categories").select("id, name").eq("company_id", companyId);
  const catByName = new Map((cats ?? []).map((c) => [c.name, c.id]));
  for (const nombre of ["Comunicaciones", "Viáticos y viajes"]) {
    if (catByName.has(nombre)) continue;
    const { data: c, error } = await db.from("categories")
      .insert({ company_id: companyId, name: nombre, flow: "expense" }).select("id").single();
    if (error) throw new Error(`categoría ${nombre}: ${error.message}`);
    catByName.set(nombre, c.id);
    console.log(`✓ categoría creada: ${nombre}`);
  }

  // ---- batch + líneas + gastos ----
  const hash = sha256Hex(csv).slice(0, 16);
  const { data: exB } = await db.from("import_batches").select("id")
    .eq("company_id", companyId).eq("account_id", clara.id).eq("file_sha256", hash).maybeSingle();
  let batchId = exB?.id;
  if (!batchId) {
    const { data: b, error } = await db.from("import_batches").insert({
      company_id: companyId, account_id: clara.id, source: "csv",
      filename: "clara_mx.csv (export 20/8/2026)", file_sha256: hash,
      period_from: "2026-01-01", period_to: "2026-08-19", status: "processing",
    }).select("id").single();
    if (error) throw new Error(`batch: ${error.message}`);
    batchId = b.id;
  }

  const keys = new KeyBuilder();
  const lineas = txs.map((t, i) => ({
    company_id: companyId, batch_id: batchId, account_id: clara!.id,
    line_no: i + 1, posted_on: t["Fecha de Transacción"],
    description_raw: t["Transacción"].slice(0, 200),
    counterparty_raw: t["Titular"]?.trim() || null,
    amount: -Number(t["Monto en MXN"]),        // consumo = sale plata de la cuenta
    currency: "MXN",
    external_key: keys.build("claramx", t["Fecha de Transacción"], Number(t["Monto en MXN"]),
      t["Transacción"], t["Código de autorización"] ?? ""),
    match_status: "pending",
    raw: { tarjeta: t["Alias de la Tarjeta"], titular: t["Titular"]?.trim(),
           moneda_original: t["Moneda original"], monto_original: t["Monto original"],
           categoria_clara: t["Categoría de Compra"] },
  }));
  await upsertBatched(db, "statement_lines", lineas, "company_id,account_id,external_key", { ignoreDuplicates: true });

  const enBase = await fetchAllRows<{
    id: string; posted_on: string; amount: string; description_raw: string;
    external_key: string; match_status: string;
    raw: { titular: string | null; categoria_clara: string | null; tarjeta: string | null };
  }>(db, "statement_lines", "id, posted_on, amount, description_raw, external_key, match_status, raw",
    (q) => q.eq("company_id", companyId).eq("batch_id", batchId));

  let gastos = 0, retiros = 0, saltadas = 0;
  const sumaCreada = new Map<string, number>();
  for (const l of enBase) {
    if (l.match_status !== "pending") { saltadas++; continue; }
    const monto = Math.abs(Number(l.amount));
    const desc = l.description_raw;

    if (/RETIRO DE EFECTIVO/i.test(desc)) {
      const { data: grupo, error } = await db.rpc("create_transfer", {
        p_company_id: companyId, p_from_account: clara.id, p_to_account: efectivo,
        p_amount_out: monto, p_amount_in: monto, p_date: l.posted_on,
        p_description: `Retiro de efectivo con la Clara (${l.raw?.titular ?? ""})`.trim(),
      });
      if (error) throw new Error(`retiro ${l.posted_on}: ${error.message}`);
      const { data: patas } = await db.from("movements").select("id, kind")
        .eq("company_id", companyId).eq("transfer_group_id", grupo);
      const salida = (patas ?? []).find((p) => p.kind === "transfer_out");
      if (salida) {
        await db.from("movements").update({ external_key: `claratr:${l.external_key}`, source: "import" }).eq("id", salida.id);
        await db.from("reconciliations").insert({
          company_id: companyId, statement_line_id: l.id, movement_id: salida.id,
          amount: Number(l.amount), matched_by: "rule",
        });
        await db.from("statement_lines").update({ match_status: "matched", matched_movement_id: salida.id }).eq("id", l.id);
      }
      retiros++;
      continue;
    }

    const regla = POR_COMERCIO.find((r) => r.patron.test(desc));
    const categoria = regla?.categoria ?? POR_CATEGORIA_CLARA[l.raw?.categoria_clara ?? ""] ?? null;
    const { data: mov, error } = await db.from("movements").insert({
      company_id: companyId, account_id: clara.id, currency: "MXN",
      kind: "expense", status: "confirmed", occurred_on: l.posted_on,
      amount: monto,
      category_id: categoria ? catByName.get(categoria) : null,
      counterparty_id: null,
      description: `${desc}${l.raw?.titular ? ` · ${l.raw.titular}` : ""}`.slice(0, 140),
      source: "import",
      external_key: `claraout:${l.external_key}`,
      meta: { origen: "export Clara", tarjeta: l.raw?.tarjeta, titular: l.raw?.titular,
              categoria_clara: l.raw?.categoria_clara, nota: regla?.nota ?? null },
    }).select("id").single();
    if (error) {
      if (error.code === "23505") { saltadas++; continue; }
      throw new Error(`gasto ${l.posted_on}: ${error.message}`);
    }
    await db.from("reconciliations").insert({
      company_id: companyId, statement_line_id: l.id, movement_id: mov.id,
      amount: Number(l.amount), matched_by: "rule",
    });
    await db.from("statement_lines").update({ match_status: "matched", matched_movement_id: mov.id }).eq("id", l.id);
    const k = l.posted_on.slice(0, 7);
    sumaCreada.set(k, Math.round(((sumaCreada.get(k) ?? 0) + monto) * 100) / 100);
    gastos++;
  }
  await db.from("import_batches").update({ status: "done", stats: { lineas: lineas.length } }).eq("id", batchId);

  // ---- GATE: lo creado = lo del CSV (neteando los retiros de efectivo) ----
  for (const [k, esperado] of porMes) {
    const retirosMes = txs.filter((t) => t["Fecha de Transacción"].slice(0, 7) === k && /RETIRO DE EFECTIVO/i.test(t["Transacción"]))
      .reduce((a, t) => a + Number(t["Monto en MXN"]), 0);
    const creado = (sumaCreada.get(k) ?? 0) + retirosMes;
    if (saltadas === 0 && Math.abs(creado - esperado) >= 0.01) {
      throw new Error(`✗ GATE ${k}: creado ${creado.toFixed(2)} ≠ CSV ${esperado.toFixed(2)}`);
    }
  }
  console.log(`\n${gastos} gastos desde Clara · ${retiros} retiros de efectivo · ${saltadas} ya estaban · gate mensual ✓`);

  // ---- pagos BBVA→Clara: de gasto a transferencia ----
  const { data: catClara } = await db.from("categories").select("id")
    .eq("company_id", companyId).eq("name", "Tarjeta Clara").single();
  const pagos = await fetchAllRows<{ id: string; occurred_on: string; amount: string; external_key: string | null }>(
    db, "movements", "id, occurred_on, amount, external_key",
    (q) => q.eq("company_id", companyId).eq("kind", "expense")
            .eq("category_id", catClara!.id).neq("status", "void"));
  let convertidos = 0;
  for (const p of pagos) {
    // la línea de extracto BBVA que lo respaldaba
    const { data: recs } = await db.from("reconciliations").select("id, statement_line_id")
      .eq("company_id", companyId).eq("movement_id", p.id);
    for (const r of recs ?? []) await db.from("reconciliations").delete().eq("id", r.id);
    const { error: eVoid } = await db.rpc("void_movement", { p_movement_id: p.id });
    if (eVoid) throw new Error(`void ${p.id}: ${eVoid.message}`);

    const { data: grupo, error } = await db.rpc("create_transfer", {
      p_company_id: companyId, p_from_account: bbva, p_to_account: clara.id,
      p_amount_out: Number(p.amount), p_amount_in: Number(p.amount), p_date: p.occurred_on,
      p_description: "Pago tarjeta Clara",
    });
    if (error) throw new Error(`transfer pago ${p.occurred_on}: ${error.message}`);
    const { data: patas } = await db.from("movements").select("id, kind")
      .eq("company_id", companyId).eq("transfer_group_id", grupo);
    const salida = (patas ?? []).find((x) => x.kind === "transfer_out");
    if (salida) {
      await db.from("movements").update({
        external_key: p.external_key ? `claratr:${p.external_key}` : null, source: "import",
      }).eq("id", salida.id);
      for (const r of recs ?? []) {
        await db.from("reconciliations").insert({
          company_id: companyId, statement_line_id: r.statement_line_id, movement_id: salida.id,
          amount: -Number(p.amount), matched_by: "rule",
        });
        await db.from("statement_lines").update({ matched_movement_id: salida.id }).eq("id", r.statement_line_id);
      }
    }
    convertidos++;
  }
  console.log(`${convertidos} pagos BBVA→Clara convertidos de gasto a transferencia`);

  const { data: saldos } = await db.from("v_account_balances").select("name, balance")
    .eq("company_id", companyId).order("name");
  console.log("\nSaldos MX:");
  for (const s of saldos ?? []) console.log(`  ${s.name}: ${Number(s.balance).toLocaleString("es-MX")}`);
  console.log("  (Clara en negativo = lo que se le debe a la tarjeta hoy)");
}

main().catch((e) => { console.error(`\nERROR: ${e.message ?? e}`); process.exit(1); });

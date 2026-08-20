// Siembra las líneas de EXTRACTO del consultorio: Banco Macro + BBVA USD (hojas
// Banco_* de 2026_Consultorio.xlsx, ya volcadas a seed-data/macro_extractos_raw.json)
// y Mercado Pago (196 movimientos transcriptos, seed-data/mp_ar_actividad.json).
//
// IMPORTANTE: esto NO crea movimientos — los movimientos ya existen (seed de la
// caja). El extracto CONFIRMA, no duplica: estas líneas quedan 'pending' y el
// matcher de la app propone la conciliación.
//
// GATE: cada hoja Banco_* trae un total de control antes del header; la suma
// ARS parseada debe coincidir o el script ABORTA sin escribir esa hoja.
//
// Uso:  npx tsx scripts/import-extractos-ar.ts            (dry-run)
//       npx tsx scripts/import-extractos-ar.ts --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, upsertBatched, argFlags } from "./lib/service-client";
import { parseMacroSheet, type MacroParseResult } from "../lib/import/parse-macro";
import { KeyBuilder, sha256Hex } from "../lib/import/keys";

function gateHoja(hoja: string, r: MacroParseResult): void {
  const sumaArs = r.lines
    .filter((l) => l.currency === "ARS")
    .reduce((a, l) => a + l.amount, 0);
  if (r.controlTotal != null && Math.abs(sumaArs - r.controlTotal) >= 1) {
    throw new Error(
      `✗ GATE ${hoja}: suma ARS parseada ${sumaArs.toLocaleString("es-AR")} ≠ control de la hoja ${r.controlTotal.toLocaleString("es-AR")}. No se escribe nada de esta hoja.`
    );
  }
}

async function main() {
  const flags = argFlags();
  const macroRaw = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/macro_extractos_raw.json"), "utf8")
  ) as { hojas: Record<string, (string | null)[][]> };
  const mpRaw = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/mp_ar_actividad.json"), "utf8")
  ) as { filas: Array<{ fecha: string; pagador: string; ars: number; tipo: string }> };

  const parsed = Object.entries(macroRaw.hojas).map(([hoja, rows]) => ({
    hoja,
    result: parseMacroSheet(rows),
  }));
  for (const p of parsed) {
    gateHoja(p.hoja, p.result); // aborta ANTES de escribir si la hoja no cierra
    const usd = p.result.lines.filter((l) => l.currency === "USD").length;
    console.log(
      `Macro ${p.hoja}: ${p.result.lines.length} líneas (${usd} USD) · ${p.result.skipped.length} salteadas · control ${p.result.controlTotal?.toLocaleString("es-AR") ?? "—"} ✓`
    );
    for (const s of p.result.skipped) console.log(`   salteada L${s.lineNo}: ${s.reason} · ${JSON.stringify(s.raw).slice(0, 100)}`);
  }
  console.log(`MP: ${mpRaw.filas.length} líneas`);
  if (flags.dryRun) {
    console.log("DRY-RUN (sin --apply no escribe).");
    return;
  }

  const db = await serviceClient({
    accion: "sembrar líneas de extracto AR (Macro + BBVA USD + Mercado Pago)",
    auto: flags.yes,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente: correr seed-base primero");
  const companyId = cia.id;
  const { data: accounts } = await db.from("accounts").select("id, name").eq("company_id", companyId);
  const accByName = Object.fromEntries((accounts ?? []).map((a) => [a.name, a.id]));
  const macroAcc = accByName["Banco Macro"];
  const bbvaUsdAcc = accByName["BBVA USD"];
  const mpAcc = accByName["Mercado Pago"];
  if (!macroAcc || !mpAcc || !bbvaUsdAcc) throw new Error("faltan cuentas AR (Banco Macro / BBVA USD / Mercado Pago): correr seed-base");

  // batch idempotente por hash; nace 'processing' y pasa a 'done' AL FINAL,
  // así una corrida que muere a mitad queda visible como incompleta.
  async function ensureBatch(
    accountId: string, source: string, filename: string, contentHash: string,
    periodFrom: string | null, periodTo: string | null
  ): Promise<{ id: string; nuevo: boolean }> {
    const { data: existing } = await db.from("import_batches").select("id")
      .eq("company_id", companyId).eq("account_id", accountId).eq("file_sha256", contentHash).maybeSingle();
    if (existing) return { id: existing.id, nuevo: false };
    const { data, error } = await db.from("import_batches").insert({
      company_id: companyId, account_id: accountId, source, filename,
      file_sha256: contentHash, period_from: periodFrom, period_to: periodTo, status: "processing",
    }).select("id").single();
    if (error) throw new Error(`batch ${filename}: ${error.message}`);
    return { id: data.id, nuevo: true };
  }

  async function cerrarBatch(id: string, stats: Record<string, unknown>) {
    await db.from("import_batches").update({ status: "done", stats }).eq("id", id);
  }

  let total = 0;
  for (const p of parsed) {
    // una hoja puede tener líneas de DOS cuentas (Macro ARS + BBVA USD):
    // un batch por cuenta presente en la hoja
    for (const currency of ["ARS", "USD"] as const) {
      const lines = p.result.lines.filter((l) => l.currency === currency);
      if (!lines.length) continue;
      const accountId = currency === "ARS" ? macroAcc : bbvaUsdAcc;
      const fechas = lines.map((l) => l.fecha).sort();
      const hash = sha256Hex(JSON.stringify(macroRaw.hojas[p.hoja]) + `|${currency}`);
      const batch = await ensureBatch(
        accountId, "macro", `2026_Consultorio.xlsx#${p.hoja}${currency === "USD" ? " (BBVA USD)" : ""}`,
        hash, fechas[0], fechas[fechas.length - 1]
      );
      const keys = new KeyBuilder();
      const rows = lines.map((l) => ({
        company_id: companyId, batch_id: batch.id, account_id: accountId,
        line_no: l.lineNo, posted_on: l.fecha,
        description_raw: l.descripcion || (l.nroFactura ? `FC ${l.nroFactura}` : ""),
        counterparty_raw: l.contraparte,
        amount: l.amount, currency,
        external_key: keys.build("macro", l.fecha, l.amount, l.descripcion, l.contraparte),
        match_status: "pending", raw: l.raw,
      }));
      const n = await upsertBatched(db, "statement_lines", rows, "company_id,account_id,external_key", { ignoreDuplicates: true });
      await cerrarBatch(batch.id, {
        lineas: lines.length,
        salteadas: p.result.skipped.length,
        salteadas_muestra: p.result.skipped.slice(0, 10),
        control_total: p.result.controlTotal,
      });
      console.log(`✓ ${p.hoja} ${currency}: ${n} líneas`);
      total += n;
    }
  }

  // ---- MP
  {
    const hash = sha256Hex(JSON.stringify(mpRaw.filas));
    const fechas = mpRaw.filas.map((f) => f.fecha).sort();
    const batch = await ensureBatch(mpAcc, "mp_ar", "mp_actividad (transcripción manual)", hash, fechas[0], fechas[fechas.length - 1]);
    const keys = new KeyBuilder();
    const rows = mpRaw.filas.map((f, i) => ({
      company_id: companyId, batch_id: batch.id, account_id: mpAcc,
      line_no: i + 1, posted_on: f.fecha,
      description_raw: f.tipo === "enviada" ? "Transferencia enviada" : "Cobro recibido",
      counterparty_raw: f.pagador,
      amount: f.tipo === "enviada" ? -Math.abs(f.ars) : Math.abs(f.ars),
      currency: "ARS",
      external_key: keys.build("mpmanual", f.fecha, f.pagador, f.ars, f.tipo),
      match_status: "pending", raw: f as unknown as Record<string, unknown>,
    }));
    const n = await upsertBatched(db, "statement_lines", rows, "company_id,account_id,external_key", { ignoreDuplicates: true });
    await cerrarBatch(batch.id, { lineas: rows.length });
    console.log(`✓ MP: ${n} líneas`);
    total += n;
  }

  console.log(`\n✓ ${total} líneas de extracto sembradas (pending: el matcher de la app propone la conciliación).`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

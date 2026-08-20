// Carga el extracto de Mercado Pago México 2026 (seed-data/mp_mx_2026.json:
// PDFs ene/feb/mar/abr/jun verificados contra sus propios controles + CSVs
// may/jul verificados por la cadena de saldos entre meses).
//
// Qué hace con cada línea — sin duplicar contra lo que ya existe:
//
//   · "Transferencia enviada Ortodoncia Keep" (o PAYOUT cuyo id aparece como
//     CPO en un abono de BBVA): es la pata MP de una transferencia que el
//     import de BBVA YA creó → se concilia con ese transfer_out. Si no existe
//     (retiro de fin de mes que aterriza al mes siguiente) se crea el par.
//   · "Retiro de efectivo": par de transferencia MP→Efectivo (incluye la
//     comisión del cajero en el monto; queda anotado en meta).
//   · Salidas a proveedores/personas: gasto clasificado por reglas; personas
//     sin rol conocido quedan sin categoría con la contraparte visible.
//   · PAYOUTS del CSV sin nombre y sin rastro en BBVA: gasto sin categoría,
//     SALVO los de los últimos 2 días de julio (pueden ser transferencias que
//     aterrizan en el BBVA de agosto, que aún no existe) → quedan pending.
//   · Entradas (Liberación de dinero / SETTLEMENT / transferencias recibidas):
//     los ingresos YA están (CRM, método MP) → pending para el matcher.
//
// Uso:  npx tsx scripts/import-extracto-mp-mx.ts            (dry-run)
//       npx tsx scripts/import-extracto-mp-mx.ts --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, upsertBatched, fetchAllRows, argFlags } from "./lib/service-client";
import { KeyBuilder } from "../lib/import/keys";

type Linea = { fecha: string; descripcion: string; op_id: string | null; valor: number };
type Estado = {
  formato: "pdf" | "csv"; periodo: string; archivo: string; sha256: string;
  control: Partial<Record<"entradas" | "salidas" | "saldo_inicial" | "saldo_final", number>>;
  movimientos: Linea[];
};

type Regla = { patron: RegExp; categoria: string | null; contraparte: string | null; nota?: string };

const REGLAS: Regla[] = [
  { patron: /Panoramica|RADIO DIAGNO|Ortodiagnostico|Cedirama|Dento Metric|PRODUCTOS DENTALES|DEPOSITO DENTAL|Tueme|Odontoz|Alcohol Isoprop/i,
    categoria: "Consumibles de producción", contraparte: null,
    nota: "radiología / insumos dentales pagados desde MP" },
  { patron: /Para Compresor|Mercado Libre/i, categoria: "Mantenimiento de máquinas", contraparte: null },
  { patron: /MOCHILAS PROMOCIONALES/i, categoria: "Marketing", contraparte: "Mochilas Promocionales y Carpetas SA" },
  { patron: /fedex/i, categoria: "Envíos", contraparte: "FedEx" },
  { patron: /Office max|Office depot|Sumesa|aeromark/i, categoria: "Otros gastos", contraparte: null },
];

const esTransferAKeep = (l: Linea) => /Ortodoncia Keep/i.test(l.descripcion);
const esRetiroEfectivo = (l: Linea) => /Retiro de efectivo/i.test(l.descripcion);
const esEntrada = (l: Linea) => l.valor > 0;

/** "Transferencia enviada Norberto Cornejo Leyva" → "Norberto Cornejo Leyva" */
function contraparteDe(desc: string): string | null {
  const m = desc.match(/Transferencia enviada (.+)$/i);
  if (m) return m[1].trim().slice(0, 60);
  const p = desc.match(/^Pago (.+)$/i);
  if (p) return p[1].trim().slice(0, 60);
  return null;
}

async function main() {
  const flags = argFlags();
  const data = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/mp_mx_2026.json"), "utf8")
  ) as { estados: Estado[] };

  // ---- gates ----
  for (const e of data.estados) {
    const ent = e.movimientos.filter((m) => m.valor > 0).reduce((a, m) => a + m.valor, 0);
    const sal = e.movimientos.filter((m) => m.valor < 0).reduce((a, m) => a + m.valor, 0);
    if (e.control.entradas != null && Math.abs(ent - e.control.entradas) >= 0.01)
      throw new Error(`✗ GATE ${e.periodo}: entradas ${ent.toFixed(2)} ≠ ${e.control.entradas}`);
    if (e.control.salidas != null && Math.abs(sal - e.control.salidas) >= 0.01)
      throw new Error(`✗ GATE ${e.periodo}: salidas ${sal.toFixed(2)} ≠ ${e.control.salidas}`);
  }
  // cadena de saldos: cada PDF con control debe empalmar con el anterior,
  // sumando lo que los meses sin control (CSV) traen en el medio
  let esperado: number | null = null;
  for (const e of data.estados) {
    const neto = e.movimientos.reduce((a, m) => a + m.valor, 0);
    if (e.control.saldo_inicial != null && esperado != null &&
        Math.abs(e.control.saldo_inicial - esperado) >= 0.01)
      throw new Error(`✗ GATE cadena: ${e.periodo} abre con ${e.control.saldo_inicial} y venía ${esperado.toFixed(2)}`);
    esperado = (e.control.saldo_inicial ?? esperado ?? 0) + neto;
    if (e.control.saldo_final != null && Math.abs(esperado - e.control.saldo_final) >= 0.01)
      throw new Error(`✗ GATE ${e.periodo}: cierra en ${esperado.toFixed(2)} ≠ ${e.control.saldo_final}`);
  }
  console.log(`${data.estados.length} meses MP verificados (controles + cadena de saldos) ✓`);

  const db = await serviceClient({
    accion: "cargar el extracto de Mercado Pago MX 2026",
    auto: flags.yes,
  });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "mx").single();
  if (!cia) throw new Error("empresa 'mx' inexistente");
  const companyId = cia.id;
  const { data: accounts } = await db.from("accounts").select("id, name").eq("company_id", companyId);
  const accByName = Object.fromEntries((accounts ?? []).map((a) => [a.name, a.id]));
  const mp = accByName["Mercado Pago"], bbva = accByName["BBVA"], efectivo = accByName["Efectivo"];
  if (!mp || !bbva || !efectivo) throw new Error("faltan cuentas MX");

  // ids de operación MP que BBVA vio como abono (CPO...) → esos PAYOUTS son transferencias
  const bb = JSON.parse(readFileSync(resolve(__dirname, "../seed-data/bbva_mx_2026.json"), "utf8"));
  const opsEnBbva = new Set<string>();
  for (const e of bb.estados) for (const m of e.movimientos) {
    if (m.abono) for (const g of m.descripcion.matchAll(/CPO(\d{9,})/g)) opsEnBbva.add(g[1]);
  }

  // transfer_out ya creados por el import de BBVA, aún sin conciliar
  const patasOut = await fetchAllRows<{ id: string; occurred_on: string; amount: string }>(
    db, "movements", "id, occurred_on, amount",
    (q) => q.eq("company_id", companyId).eq("account_id", mp).eq("kind", "transfer_out").neq("status", "void"));
  const { data: yaConc } = await db.from("reconciliations").select("movement_id").eq("company_id", companyId);
  const concSet = new Set((yaConc ?? []).map((r) => r.movement_id));
  const disponibles = patasOut.filter((p) => !concSet.has(p.id));

  const { data: cats } = await db.from("categories").select("id, name").eq("company_id", companyId);
  const catByName = new Map((cats ?? []).map((c) => [c.name, c.id]));

  const cpCache = new Map<string, string>();
  async function contraparteId(nombre: string): Promise<string> {
    if (cpCache.has(nombre)) return cpCache.get(nombre)!;
    const { data: ex } = await db.from("counterparties").select("id")
      .eq("company_id", companyId).eq("display_name", nombre).maybeSingle();
    if (ex) { cpCache.set(nombre, ex.id); return ex.id; }
    const { data: c, error } = await db.from("counterparties")
      .insert({ company_id: companyId, kind: "supplier", display_name: nombre }).select("id").single();
    if (error) throw new Error(`contraparte ${nombre}: ${error.message}`);
    cpCache.set(nombre, c.id);
    return c.id;
  }

  // plan (para el dry-run y para ejecutar)
  let nTransfKeep = 0, nEfectivo = 0, nGasto = 0, nPend = 0, nEntradas = 0;
  for (const e of data.estados) for (const l of e.movimientos) {
    if (esEntrada(l)) { nEntradas++; continue; }
    if (esTransferAKeep(l) || (l.op_id && opsEnBbva.has(l.op_id))) { nTransfKeep++; continue; }
    if (esRetiroEfectivo(l)) { nEfectivo++; continue; }
    if (e.formato === "csv" && e.periodo === "2026-07" && l.fecha >= "2026-07-30") { nPend++; continue; }
    nGasto++;
  }
  console.log(`  ${nTransfKeep} transferencias a BBVA · ${nEfectivo} retiros a Efectivo · ` +
    `${nGasto} gastos · ${nPend} pendientes fin de julio · ${nEntradas} entradas para el matcher`);
  if (flags.dryRun) { console.log("\nDRY-RUN (sin --apply no escribe)."); return; }

  let creadosG = 0, creadosT = 0, conciliadas = 0, saltadas = 0;
  for (const e of data.estados) {
    const { data: exB } = await db.from("import_batches").select("id")
      .eq("company_id", companyId).eq("account_id", mp).eq("file_sha256", e.sha256).maybeSingle();
    let batchId = exB?.id;
    if (!batchId) {
      const { data: b, error } = await db.from("import_batches").insert({
        company_id: companyId, account_id: mp, source: "mp_mx", filename: e.archivo,
        file_sha256: e.sha256, period_from: `${e.periodo}-01`, period_to: `${e.periodo}-28`,
        status: "processing",
      }).select("id").single();
      if (error) throw new Error(`batch ${e.archivo}: ${error.message}`);
      batchId = b.id;
    }

    const keys = new KeyBuilder();
    const filas = e.movimientos.map((m, i) => ({
      company_id: companyId, batch_id: batchId, account_id: mp,
      line_no: i + 1, posted_on: m.fecha,
      description_raw: m.descripcion.slice(0, 500),
      counterparty_raw: contraparteDe(m.descripcion),
      amount: m.valor, currency: "MXN",
      external_key: keys.build("mpmx", m.fecha, m.valor, m.descripcion, m.op_id ?? ""),
      match_status: "pending", raw: { op_id: m.op_id, formato: e.formato },
    }));
    await upsertBatched(db, "statement_lines", filas,
      "company_id,account_id,external_key", { ignoreDuplicates: true });

    const lineas = await fetchAllRows<{
      id: string; posted_on: string; amount: string; description_raw: string;
      external_key: string; match_status: string; raw: { op_id: string | null };
    }>(db, "statement_lines", "id, posted_on, amount, description_raw, external_key, match_status, raw",
      (q) => q.eq("company_id", companyId).eq("batch_id", batchId));

    async function conciliar(lineaId: string, movId: string, monto: number) {
      await db.from("reconciliations").insert({
        company_id: companyId, statement_line_id: lineaId, movement_id: movId,
        amount: monto, matched_by: "rule",
      });
      await db.from("statement_lines")
        .update({ match_status: "matched", matched_movement_id: movId }).eq("id", lineaId);
    }

    for (const l of lineas) {
      if (l.match_status !== "pending") { saltadas++; continue; }
      const monto = Number(l.amount);
      const desc = l.description_raw;
      const lin: Linea = { fecha: l.posted_on, descripcion: desc, op_id: l.raw?.op_id ?? null, valor: monto };

      if (esEntrada(lin)) continue;   // matcher

      if (esTransferAKeep(lin) || (lin.op_id && opsEnBbva.has(lin.op_id))) {
        // pata MP de una transferencia que el import de BBVA ya creó
        const abs = Math.abs(monto);
        const dias = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
        const cand = disponibles
          .filter((p) => Math.abs(Number(p.amount) - abs) < 0.01 && dias(p.occurred_on, l.posted_on) <= 4)
          .sort((a, b) => dias(a.occurred_on, l.posted_on) - dias(b.occurred_on, l.posted_on))[0];
        if (cand) {
          await conciliar(l.id, cand.id, monto);
          disponibles.splice(disponibles.indexOf(cand), 1);
          conciliadas++;
        } else {
          // fin de mes: salió de MP pero BBVA lo ve el mes siguiente → crear el par
          const { data: grupo, error } = await db.rpc("create_transfer", {
            p_company_id: companyId, p_from_account: mp, p_to_account: bbva,
            p_amount_out: abs, p_amount_in: abs, p_date: l.posted_on,
            p_description: "Retiro Mercado Pago → BBVA (extracto MP; BBVA lo ve después)",
          });
          if (error) throw new Error(`transfer ${l.posted_on}: ${error.message}`);
          const { data: patas } = await db.from("movements").select("id, kind")
            .eq("company_id", companyId).eq("transfer_group_id", grupo);
          const salida = (patas ?? []).find((p) => p.kind === "transfer_out");
          if (salida) {
            await db.from("movements")
              .update({ external_key: `mpmxtr:${l.external_key}`, source: "import" }).eq("id", salida.id);
            await conciliar(l.id, salida.id, monto);
          }
          creadosT++;
        }
        continue;
      }

      if (esRetiroEfectivo(lin)) {
        const abs = Math.abs(monto);
        const { data: grupo, error } = await db.rpc("create_transfer", {
          p_company_id: companyId, p_from_account: mp, p_to_account: efectivo,
          p_amount_out: abs, p_amount_in: abs, p_date: l.posted_on,
          p_description: desc.slice(0, 140),
        });
        if (error) throw new Error(`retiro ${l.posted_on}: ${error.message}`);
        const { data: patas } = await db.from("movements").select("id, kind")
          .eq("company_id", companyId).eq("transfer_group_id", grupo);
        const salida = (patas ?? []).find((p) => p.kind === "transfer_out");
        if (salida) {
          await db.from("movements").update({
            external_key: `mpmxtr:${l.external_key}`, source: "import",
            meta: { nota: "el monto incluye la comisión del cajero si la hubo" },
          }).eq("id", salida.id);
          await conciliar(l.id, salida.id, monto);
        }
        creadosT++;
        continue;
      }

      if (e.formato === "csv" && e.periodo === "2026-07" && l.posted_on >= "2026-07-30") {
        await db.from("statement_lines").update({ match_status: "unidentified" }).eq("id", l.id);
        continue;   // puede ser una transferencia que aterriza en el BBVA de agosto
      }

      // ------- gasto -------
      const regla = REGLAS.find((r) => r.patron.test(desc));
      const nombreCp = regla?.contraparte ?? contraparteDe(desc);
      const { data: mov, error } = await db.from("movements").insert({
        company_id: companyId, account_id: mp, currency: "MXN",
        kind: "expense", status: "confirmed", occurred_on: l.posted_on,
        amount: Math.abs(monto),
        category_id: regla?.categoria ? catByName.get(regla.categoria) : null,
        counterparty_id: nombreCp ? await contraparteId(nombreCp) : null,
        description: desc.slice(0, 140),
        source: "import",
        external_key: `mpmxout:${l.external_key}`,
        meta: { origen: "extracto Mercado Pago MX", nota: regla?.nota ?? null },
      }).select("id").single();
      if (error) {
        if (error.code === "23505") { saltadas++; continue; }
        throw new Error(`gasto ${l.posted_on}: ${error.message}`);
      }
      await conciliar(l.id, mov.id, monto);
      creadosG++;
    }

    await db.from("import_batches").update({ status: "done", stats: { lineas: filas.length, control: e.control } }).eq("id", batchId);
    console.log(`✓ ${e.periodo}: ${filas.length} líneas`);
  }

  console.log(`\n${creadosG} gastos · ${creadosT} transferencias nuevas · ${conciliadas} patas conciliadas con las de BBVA · ${saltadas} ya estaban`);

  const { data: saldos } = await db.from("v_account_balances").select("name, balance").eq("company_id", companyId);
  for (const s of saldos ?? []) console.log(`  ${s.name}: ${Number(s.balance).toLocaleString("es-MX")}`);
  console.log(`  (MP real al 31/7 según extracto: ~488 — la diferencia son ingresos del CRM sin conciliar y comisiones de MP no detalladas)`);
}

main().catch((e) => { console.error(`\nERROR: ${e.message ?? e}`); process.exit(1); });

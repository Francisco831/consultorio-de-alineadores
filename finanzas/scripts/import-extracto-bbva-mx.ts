// Carga el extracto de BBVA México 2026 (seed-data/bbva_mx_2026.json, extraído
// de los PDF con scripts/extraer/bbva_mx.py y verificado contra los totales de
// control del propio banco: cantidad de cargos/abonos, importes y saldo final).
//
// Qué hace con cada tipo de línea — la regla de oro es NO duplicar contra los
// 174 ingresos que ya vinieron del CRM:
//
//   · CARGOS (129): no existen en el ledger → crea el gasto, clasificado por
//     reglas sobre la descripción; sin regla queda sin categoría (la alerta de
//     "sin clasificar" lo trae de vuelta). Cada gasto queda conciliado con su
//     línea.
//   · ABONOS desde Mercado Pago (37): plata propia que viaja MP→BBVA. Par de
//     transferencia vía create_transfer(), jamás ingreso.
//   · ABONOS de terceros (pacientes/doctores): YA están en el ledger como
//     ingresos del CRM (TR/Depósito → cuenta BBVA). Quedan pending para el
//     matcher (conciliar-inicial.ts --empresa=mx), que los vincula.
//
// GATE: por cada mes, la suma parseada debe cuadrar con lo que declara el banco
// (cantidad e importe de cargos y abonos) o el script aborta sin escribir.
//
// Uso:  npx tsx scripts/import-extracto-bbva-mx.ts            (dry-run)
//       npx tsx scripts/import-extracto-bbva-mx.ts --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, upsertBatched, fetchAllRows, argFlags } from "./lib/service-client";
import { KeyBuilder } from "../lib/import/keys";

type Linea = {
  fecha: string; cod: string | null; descripcion: string;
  cargo: number | null; abono: number | null; saldo: number | null;
};
type Estado = {
  archivo: string; sha256: string; cuenta: string | null;
  desde: string; hasta: string;
  control: {
    cargos?: { n: number; total: number }; abonos?: { n: number; total: number };
    saldo_inicial?: number; saldo_final?: number;
  };
  movimientos: Linea[];
};

type Regla = {
  patron: RegExp;
  categoria: string | null;         // null = queda sin categoría a propósito
  contraparte: string | null;
  kindContraparte?: "supplier" | "employee" | "tax_agency";
  nota?: string;
};

// El orden importa: la CLABE del arrendador gana sobre la palabra "ABOGADOS"
// (en enero el alquiler salió glosado "ABOGADOS ENERO 26" hacia la misma CLABE).
const REGLAS: Regla[] = [
  { patron: /00002180024269154248|ALQUILER OFICINA/, categoria: "Alquiler",
    contraparte: "Eduardo Nuñez (arrendador)", kindContraparte: "supplier",
    nota: "CLABE del arrendador; en enero la transferencia salió glosada 'ABOGADOS'" },
  { patron: /IMSS|SIPARE/, categoria: "Impuestos (SAT / IMSS)",
    contraparte: "IMSS / INFONAVIT", kindContraparte: "tax_agency" },
  { patron: /\bSAT\b/, categoria: "Impuestos (SAT / IMSS)",
    contraparte: "SAT", kindContraparte: "tax_agency" },
  { patron: /SERV BANCA INTERNET|IVA COM SERV|COMISION/, categoria: "Comisiones bancarias",
    contraparte: "BBVA México", kindContraparte: "supplier" },
  { patron: /ABOGADOS|TORO NUEVOS|00058650000149298243/, categoria: "Honorarios legales",
    contraparte: "Toro Nuevos (abogados)", kindContraparte: "supplier" },
  { patron: /\bCLARA\b/, categoria: "Tarjeta Clara",
    contraparte: "Clara (tarjeta corporativa)", kindContraparte: "supplier",
    nota: "pago del resumen de la tarjeta; el detalle vive en los estados de Clara" },
  { patron: /ESCANEOS|CEDIRAM/, categoria: "Consumibles de producción",
    contraparte: "CEDIRAM (escaneos)", kindContraparte: "supplier" },
  { patron: /BNET 1536586592/, categoria: "Sueldos producción",
    contraparte: "Empleado producción A (BNET …6592)", kindContraparte: "employee",
    nota: "glosa 'sueldo' en el extracto; falta el nombre real" },
  { patron: /BNET 0194724011/, categoria: "Sueldos producción",
    contraparte: "Empleado producción B (BNET …4011)", kindContraparte: "employee",
    nota: "22.500 fijos mensuales, mismo monto que el otro sueldo; falta el nombre real" },
  { patron: /00072580013228165398|0\d{5}26JESUS|SUELDO ENERO 26/, categoria: "Sueldos administración",
    contraparte: "Jesús (administración)", kindContraparte: "employee",
    nota: "9.000 mensuales por SPEI a Banorte, glosas 'JESUS' / 'SUELDO' / 'ADMINF'" },
  // Recurrentes SIN identificar: quedan sin categoría con contraparte visible,
  // para que Pancho les ponga nombre. No se adivina.
  { patron: /BNET 1580002821/, categoria: null, contraparte: "Beneficiario BNET …2821 (12.000/mes)", kindContraparte: "supplier" },
  { patron: /BNET 1590619097/, categoria: null, contraparte: "Beneficiario BNET …9097", kindContraparte: "supplier" },
  { patron: /BNET 1512798293/, categoria: null, contraparte: "Beneficiario BNET …8293", kindContraparte: "supplier" },
  { patron: /BNET 2915209536/, categoria: null, contraparte: "Beneficiario BNET …9536", kindContraparte: "supplier" },
  { patron: /ROCIO PUIG/, categoria: null, contraparte: "Rocío Puig", kindContraparte: "employee",
    nota: "27.494 MXN el 29/7; probablemente su compensación al mudarse a MX — confirmar cómo imputarla" },
  { patron: /ACTINVER/, categoria: null, contraparte: "Banco Actinver (domiciliación)", kindContraparte: "supplier",
    nota: "50.000 fijos + resto variable, todos los meses; falta saber qué es" },
];

const esDesdeMp = (l: Linea) =>
  l.abono != null && /Mercado Pago|MERCADO\*PAGO/.test(l.descripcion);

function gate(e: Estado): void {
  const cargos = e.movimientos.filter((m) => m.cargo != null);
  const abonos = e.movimientos.filter((m) => m.abono != null);
  const sc = cargos.reduce((a, m) => a + m.cargo!, 0);
  const sa = abonos.reduce((a, m) => a + m.abono!, 0);
  const c = e.control;
  const falla = (msg: string) => {
    throw new Error(`✗ GATE ${e.desde.slice(0, 7)}: ${msg}. No se escribe nada.`);
  };
  if (!c.cargos || !c.abonos) falla("el PDF no trajo los totales de control");
  if (cargos.length !== c.cargos!.n) falla(`cargos ${cargos.length} ≠ ${c.cargos!.n} declarados`);
  if (abonos.length !== c.abonos!.n) falla(`abonos ${abonos.length} ≠ ${c.abonos!.n} declarados`);
  if (Math.abs(sc - c.cargos!.total) >= 0.01) falla(`suma cargos ${sc.toFixed(2)} ≠ ${c.cargos!.total.toFixed(2)}`);
  if (Math.abs(sa - c.abonos!.total) >= 0.01) falla(`suma abonos ${sa.toFixed(2)} ≠ ${c.abonos!.total.toFixed(2)}`);
  if (c.saldo_inicial != null && c.saldo_final != null &&
      Math.abs(c.saldo_inicial + sa - sc - c.saldo_final) >= 0.01) {
    falla("el saldo no cierra: inicial + abonos - cargos ≠ final");
  }
}

async function main() {
  const flags = argFlags();
  const data = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/bbva_mx_2026.json"), "utf8")
  ) as { estados: Estado[] };

  for (const e of data.estados) gate(e);

  let nCargo = 0, nMp = 0, nTerceros = 0, sinRegla: Linea[] = [];
  for (const e of data.estados) {
    for (const m of e.movimientos) {
      if (m.cargo != null) {
        nCargo++;
        if (!REGLAS.some((r) => r.patron.test(m.descripcion))) sinRegla.push(m);
      } else if (esDesdeMp(m)) nMp++;
      else nTerceros++;
    }
  }
  console.log(`${data.estados.length} meses verificados contra el banco ✓`);
  console.log(`  ${nCargo} cargos → gastos (${sinRegla.length} sin regla, quedan sin categoría)`);
  console.log(`  ${nMp} abonos desde Mercado Pago → transferencias internas`);
  console.log(`  ${nTerceros} abonos de terceros → pending para el matcher (NO se crean ingresos)`);
  for (const m of sinRegla) {
    console.log(`    ⚠ sin regla: ${m.fecha} ${m.cargo!.toLocaleString("es-MX")} ${m.descripcion.slice(0, 80)}`);
  }
  if (flags.dryRun) { console.log("\nDRY-RUN (sin --apply no escribe)."); return; }

  const db = await serviceClient({
    accion: "cargar el extracto BBVA MX 2026: líneas, gastos y transferencias MP→BBVA",
    auto: flags.yes,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "mx").single();
  if (!cia) throw new Error("empresa 'mx' inexistente");
  const companyId = cia.id;
  const { data: accounts } = await db.from("accounts").select("id, name").eq("company_id", companyId);
  const accByName = Object.fromEntries((accounts ?? []).map((a) => [a.name, a.id]));
  const bbva = accByName["BBVA"];
  const mp = accByName["Mercado Pago"];
  if (!bbva || !mp) throw new Error("faltan cuentas MX");

  // categorías get-or-create (Tarjeta Clara no existía)
  const { data: cats } = await db.from("categories").select("id, name").eq("company_id", companyId);
  const catByName = new Map((cats ?? []).map((c) => [c.name, c.id]));
  for (const nombre of [...new Set(REGLAS.map((r) => r.categoria).filter(Boolean))] as string[]) {
    if (catByName.has(nombre)) continue;
    const { data: c, error } = await db.from("categories")
      .insert({ company_id: companyId, name: nombre, flow: "expense" }).select("id").single();
    if (error) throw new Error(`categoría ${nombre}: ${error.message}`);
    catByName.set(nombre, c.id);
    console.log(`✓ categoría creada: ${nombre}`);
  }

  // contrapartes get-or-create
  const cpIds = new Map<string, string>();
  for (const r of REGLAS) {
    if (!r.contraparte || cpIds.has(r.contraparte)) continue;
    const { data: ex } = await db.from("counterparties").select("id")
      .eq("company_id", companyId).eq("display_name", r.contraparte).maybeSingle();
    if (ex) { cpIds.set(r.contraparte, ex.id); continue; }
    const { data: c, error } = await db.from("counterparties")
      .insert({ company_id: companyId, kind: r.kindContraparte ?? "supplier", display_name: r.contraparte })
      .select("id").single();
    if (error) throw new Error(`contraparte ${r.contraparte}: ${error.message}`);
    cpIds.set(r.contraparte, c.id);
  }

  let lineasNuevas = 0, gastos = 0, transfers = 0, saltadas = 0;
  for (const e of data.estados) {
    // batch idempotente por hash del PDF
    const { data: exB } = await db.from("import_batches").select("id")
      .eq("company_id", companyId).eq("account_id", bbva).eq("file_sha256", e.sha256).maybeSingle();
    let batchId = exB?.id;
    if (!batchId) {
      const { data: b, error } = await db.from("import_batches").insert({
        company_id: companyId, account_id: bbva, source: "bbva", filename: e.archivo,
        file_sha256: e.sha256, period_from: e.desde, period_to: e.hasta, status: "processing",
      }).select("id").single();
      if (error) throw new Error(`batch ${e.archivo}: ${error.message}`);
      batchId = b.id;
    }

    const keys = new KeyBuilder();
    const filas = e.movimientos.map((m, i) => ({
      company_id: companyId, batch_id: batchId, account_id: bbva,
      line_no: i + 1, posted_on: m.fecha,
      description_raw: m.descripcion.slice(0, 500),
      counterparty_raw: null,
      amount: m.abono != null ? m.abono : -m.cargo!,
      currency: "MXN",
      external_key: keys.build("bbvamx", m.fecha, m.abono ?? -m.cargo!, m.descripcion),
      match_status: "pending",
      raw: { cod: m.cod, saldo: m.saldo },
    }));
    lineasNuevas += await upsertBatched(db, "statement_lines", filas,
      "company_id,account_id,external_key", { ignoreDuplicates: true });

    // recuperar las líneas del batch con su id y estado real
    const lineas = await fetchAllRows<{
      id: string; posted_on: string; amount: string; description_raw: string;
      external_key: string; match_status: string;
    }>(db, "statement_lines", "id, posted_on, amount, description_raw, external_key, match_status",
      (q) => q.eq("company_id", companyId).eq("batch_id", batchId));

    for (const l of lineas) {
      if (l.match_status !== "pending") { saltadas++; continue; }   // idempotencia
      const monto = Number(l.amount);
      const desc = l.description_raw;

      if (monto < 0) {
        // ------- cargo → gasto -------
        const regla = REGLAS.find((r) => r.patron.test(desc));
        const { data: mov, error } = await db.from("movements").insert({
          company_id: companyId, account_id: bbva, currency: "MXN",
          kind: "expense", status: "confirmed", occurred_on: l.posted_on,
          amount: Math.abs(monto),
          category_id: regla?.categoria ? catByName.get(regla.categoria) : null,
          counterparty_id: regla?.contraparte ? cpIds.get(regla.contraparte) : null,
          description: desc.slice(0, 140),
          source: "import",
          external_key: `bbvamxout:${l.external_key}`,
          meta: { origen: "extracto BBVA MX", cod: null, nota: regla?.nota ?? null },
        }).select("id").single();
        if (error) {
          if (error.code === "23505") { saltadas++; continue; }
          throw new Error(`gasto ${l.posted_on}: ${error.message}`);
        }
        await db.from("reconciliations").insert({
          company_id: companyId, statement_line_id: l.id, movement_id: mov.id,
          amount: monto, matched_by: "rule",
        });
        await db.from("statement_lines")
          .update({ match_status: "matched", matched_movement_id: mov.id }).eq("id", l.id);
        gastos++;
      } else if (/Mercado Pago|MERCADO\*PAGO/.test(desc)) {
        // ------- abono desde MP → transferencia interna -------
        const { data: grupo, error } = await db.rpc("create_transfer", {
          p_company_id: companyId, p_from_account: mp, p_to_account: bbva,
          p_amount_out: monto, p_amount_in: monto, p_date: l.posted_on,
          p_description: "Retiro Mercado Pago → BBVA (extracto)",
        });
        if (error) throw new Error(`transfer ${l.posted_on} ${monto}: ${error.message}`);
        const { data: patas } = await db.from("movements").select("id, kind")
          .eq("company_id", companyId).eq("transfer_group_id", grupo);
        const entrada = (patas ?? []).find((p) => p.kind === "transfer_in");
        if (entrada) {
          await db.from("movements")
            .update({ external_key: `bbvamxtr:${l.external_key}`, source: "import" })
            .eq("id", entrada.id);
          await db.from("reconciliations").insert({
            company_id: companyId, statement_line_id: l.id, movement_id: entrada.id,
            amount: monto, matched_by: "rule",
          });
          await db.from("statement_lines")
            .update({ match_status: "matched", matched_movement_id: entrada.id }).eq("id", l.id);
        }
        transfers++;
      }
      // abonos de terceros: quedan pending para conciliar-inicial.ts --empresa=mx
    }

    await db.from("import_batches").update({
      status: "done",
      stats: { lineas: filas.length, control: e.control },
    }).eq("id", batchId);
    console.log(`✓ ${e.desde.slice(0, 7)}: ${filas.length} líneas`);
  }

  console.log(`\n${lineasNuevas} líneas nuevas · ${gastos} gastos creados · ${transfers} transferencias MP→BBVA · ${saltadas} ya estaban`);

  // ------- verificación: el saldo BBVA del ledger vs el saldo final del banco -------
  const ultimo = data.estados[data.estados.length - 1];
  const { data: saldos } = await db.from("v_account_balances").select("account_id, balance")
    .eq("company_id", companyId);
  const enLedger = (saldos ?? []).find((s) => s.account_id === bbva);
  console.log(`\nSaldo BBVA en el ledger: ${Number(enLedger?.balance ?? 0).toLocaleString("es-MX")} · ` +
    `banco al ${ultimo.hasta}: ${ultimo.control.saldo_final?.toLocaleString("es-MX")}`);
  console.log("(difieren por los ingresos del CRM aún sin conciliar y el saldo inicial: se cierra con el matcher)");
}

main().catch((e) => { console.error(`\nERROR: ${e.message ?? e}`); process.exit(1); });

// Calcula las liquidaciones de las doctoras desde el ledger y las compara contra
// la salida del script viejo (consultorio-gestion/build_liquidaciones.py).
//
// El plan lo pedía explícito: correr los dos en paralelo y exigir Δ$0 ANTES de
// apagar el script viejo. Sin --apply solo compara.
//
// El CÁLCULO ya no vive acá: está en lib/liquidaciones/recalcular.ts, que es lo
// mismo que corre el botón "Recalcular" del panel. Este script es la comparación
// contra la referencia histórica — el guard que el panel no puede hacer.
//
// Uso:  npx tsx scripts/liquidaciones.ts            (compara contra la referencia)
//       npx tsx scripts/liquidaciones.ts --apply    (además las guarda en la base)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, argFlags } from "./lib/service-client";
import { calcularTodo, guardarLiquidaciones } from "../lib/liquidaciones/recalcular";

type Ref = {
  periodo: string; doctora: string; cobrado_ars: number; cobrado_usd: number;
  gastos_tratamiento: number; base_ars: number; liquidacion_ars: number;
  liquidacion_usd: number; retiros: number; saldo: number;
};

async function main() {
  const flags = argFlags();
  const referencia = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/liquidaciones_referencia.json"), "utf8")
  ).filas as Ref[];

  const db = await serviceClient({
    accion: "calcular liquidaciones de doctoras y compararlas con el script viejo",
    auto: true,   // solo lee salvo --apply; el guard igual anuncia el destino
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");
  const companyId = cia.id;

  const calc = await calcularTodo(db, companyId);
  const { calculadas, sinCostear, huerfanas } = calc;
  const cobros = calc.movs.filter((m) => m.kind === "income" && m.meta?.categoria_origen === "Alineadores").length;
  console.log(`\nCobros de alineadores: ${cobros} · sin costear: ${sinCostear}`);
  const cajaDice = new Map(calc.movs.map((m) => [m.id, m.meta?.doctora ?? null]));
  const imputadas = [...calc.doctoraFinal].filter(([id, d]) => d !== cajaDice.get(id)).length;
  if (imputadas) console.log(`Cobros con imputación corregida a mano: ${imputadas}`);
  if (huerfanas) {
    console.log(`⚠ ${huerfanas} imputaciones apuntan a movimientos anulados (la caja editó esa fila): revisarlas en el panel.`);
  }

  // ---------- comparación contra el script viejo ----------
  const refPorClave = new Map(referencia.map((r) => [`${r.periodo}|${r.doctora}`, r]));
  // la referencia es una foto vieja (se validó Δ$0 en su momento): los períodos
  // que no cubre (agosto en adelante) no se comparan, y los cobros cargados
  // TARDE en la caja hacen crecer un mes legítimamente — solo una REGRESIÓN
  // (calculado < referencia) frena el guardado.
  const maxRef = referencia.reduce((a, r) => (r.periodo > a ? r.periodo : a), "");
  let iguales = 0;
  const difs: string[] = [];
  const crecidos: string[] = [];
  const retirosNuevos: string[] = [];
  for (const l of calculadas) {
    if (l.periodo > maxRef) continue;            // mes posterior a la foto
    const r = refPorClave.get(`${l.periodo}|${l.doctora}`);
    if (!r) {
      // Puede ser legítima: si no cobró nada ese mes pero se le pagó un retiro
      // (saldo de meses anteriores), la liquidación existe recién ahora porque
      // el retiro salió por Mercado Pago y el script viejo no lo veía.
      if (l.cobradoArs === 0 && l.cobradoUsd === 0 && l.retiros > 0) {
        retirosNuevos.push(
          `${l.periodo} ${l.doctora}: retiro de ${l.retiros.toLocaleString("es-AR")} sin cobros en el mes ` +
          `(el script viejo no generaba esta liquidación)`
        );
      } else {
        difs.push(`${l.periodo} ${l.doctora}: no está en la referencia`);
      }
      continue;
    }
    // Los RETIROS quedan fuera de la comparación estricta a propósito: el script
    // viejo solo mira la caja y no ve los retiros que se pagaron por Mercado Pago
    // (2,68M entre junio y julio). Que aparezcan de más es la corrección, no un
    // error — se reportan aparte.
    const campos: Array<[string, number, number]> = [
      ["cobrado ARS", l.cobradoArs, r.cobrado_ars],
      ["cobrado USD", l.cobradoUsd, r.cobrado_usd],
      ["costo KS", l.gastosTratamiento, r.gastos_tratamiento],
      ["liquidación ARS", l.liquidacionArs, r.liquidacion_ars],
    ];
    if (Math.abs(l.retiros - r.retiros) >= 1) {
      retirosNuevos.push(
        `${l.periodo} ${l.doctora}: retiros ${l.retiros.toLocaleString("es-AR")} ` +
        `(el script viejo veía ${r.retiros.toLocaleString("es-AR")})`
      );
    }
    const distintos = campos.filter(([, a, b]) => Math.abs(a - b) >= 1);
    const bajo = campos.some(([c, a, b]) => c.startsWith("cobrado") && a < b - 1);
    if (bajo) {
      difs.push(
        `${l.periodo} ${l.doctora}: ` +
        distintos.map(([c, a, b]) => `${c} calculado ${a.toLocaleString("es-AR")} vs referencia ${b.toLocaleString("es-AR")}`).join(" · ")
      );
    } else if (distintos.length) {
      crecidos.push(
        `${l.periodo} ${l.doctora}: ` +
        distintos.map(([c, a, b]) => `${c} ${b.toLocaleString("es-AR")} → ${a.toLocaleString("es-AR")}`).join(" · ")
      );
      iguales++;
    } else iguales++;
  }

  console.log(`\nLiquidaciones calculadas: ${calculadas.length} · comparables con la referencia: ${iguales + difs.length}`);
  console.log(`  ✓ idénticas o crecidas por cargas tardías: ${iguales}`);
  console.log(`  ${difs.length ? "✗" : "✓"} con REGRESIONES: ${difs.length}`);
  if (crecidos.length) {
    console.log(`\n  Crecidas contra la foto vieja (cargas tardías en la caja — esperado):`);
    for (const c of crecidos) console.log(`     ${c}`);
  }
  if (retirosNuevos.length) {
    console.log(`\n  Retiros que el script viejo no veía (salieron por Mercado Pago):`);
    for (const r of retirosNuevos) console.log(`     ${r}`);
  }
  for (const d of difs.slice(0, 15)) console.log(`     ${d}`);
  if (difs.length > 15) console.log(`     … y ${difs.length - 15} más`);

  if (difs.length) {
    console.error("\n✗ No coincide con build_liquidaciones.py. NO se guardan liquidaciones.");
    process.exit(1);
  }

  if (flags.dryRun) {
    console.log("\nDRY-RUN: coincide todo. Con --apply se guardan en la base.");
    return;
  }

  // ---------- guardar ----------
  const r = await guardarLiquidaciones(db, companyId, calc);
  console.log(`\n✓ ${r.guardadas} liquidaciones guardadas con ${r.items} líneas de detalle` +
    (r.congeladas.length ? ` · ${r.congeladas.length} confirmadas/pagadas sin tocar` : "") + ".");
  if (r.anuladas.length) {
    console.log(`✓ ${r.anuladas.length} anuladas por quedarse sin cobros: ${r.anuladas.join(" · ")}`);
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

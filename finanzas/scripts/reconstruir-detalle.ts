/**
 * Repone el detalle (settlement_items) de liquidaciones CERRADAS que se
 * quedaron sin líneas — SÓLO donde el cálculo de hoy reproduce exactamente el
 * total que quedó guardado.
 *
 *   npx tsx scripts/reconstruir-detalle.ts [--periodo 2026-03] [--apply]
 *
 * POR QUÉ EL CANDADO DEL TOTAL EXACTO. Hasta el 26/8/26 el recálculo borraba
 * los ítems de las liquidaciones congeladas del período y no los reponía (ya
 * está arreglado en recalcular.ts). Lo perdido se puede volver a calcular, pero
 * el criterio de costeo cambió desde entonces: pesificación de los cobros en
 * dólares, lista histórica, descuentos especiales. Reponer líneas calculadas
 * con el criterio NUEVO debajo de un total confirmado con el criterio VIEJO
 * daría una liquidación cuyas líneas no suman su propio total — peor que no
 * tener detalle, porque parece respaldo y no lo es.
 *
 * Por eso sólo se repone donde cobrado, costo KS y a pagar coinciden al peso.
 * Ahí las líneas son fieles por construcción. El resto se lista y no se toca.
 *
 * Nunca cambia un total ni un estado: sólo INSERTA líneas donde no hay ninguna.
 */
import { serviceClient, argFlags } from "./lib/service-client";
import { calcularTodo, filaDeItem } from "../lib/liquidaciones/recalcular";
import { estaCongelada } from "../lib/liquidaciones/imputacion";

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const $ = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;

async function main() {
  const { apply } = argFlags();
  const soloPeriodo = argValor("periodo");
  const db = await serviceClient({
    accion: "reconstruir el detalle de liquidaciones cerradas que quedaron sin líneas",
    auto: !apply,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");
  const companyId = cia.id as string;

  const calc = await calcularTodo(db, companyId);

  const { data: liqs } = await db.from("professional_settlements")
    .select("id, period, status, totals, professional:counterparties(display_name)")
    .eq("company_id", companyId).neq("status", "void");

  // Un cobro se liquida UNA vez (unique company_id, movement_id): si su ítem ya
  // cuelga de otra liquidación, reponerlo acá lo duplicaría.
  const yaLiquidados = new Set<string>();
  for (let desde = 0; ; desde += 1000) {
    const { data } = await db.from("settlement_items").select("movement_id")
      .eq("company_id", companyId).range(desde, desde + 999);
    for (const it of data ?? []) yaLiquidados.add(it.movement_id as string);
    if (!data || data.length < 1000) break;
  }

  const repuestas: string[] = [];
  const noCierran: string[] = [];
  const trabadas: string[] = [];
  let insertadas = 0;

  for (const liq of liqs ?? []) {
    const doctora = (liq.professional as unknown as { display_name?: string } | null)?.display_name ?? "";
    if (!estaCongelada(liq.status as string)) continue;
    if (soloPeriodo && liq.period !== soloPeriodo) continue;

    const { count } = await db.from("settlement_items")
      .select("id", { count: "exact", head: true }).eq("settlement_id", liq.id);
    if (count) continue;   // ya tiene detalle: no se toca

    const linea = calc.calculadas.find((l) => l.periodo === liq.period && l.doctora === doctora);
    const t = (liq.totals as { ARS?: { collected?: number; ks_cost?: number; due?: number }; USD?: { collected?: number } }) ?? {};
    const guardado = t.ARS ?? {};
    if (!linea) {
      noCierran.push(`${liq.period} ${doctora}: el cálculo de hoy no genera nada para ella`);
      continue;
    }

    // El total tiene que cerrar en las TRES puntas, y no puede haber quedado
    // plata en el bucket USD viejo: si la hay, ese mes se liquidó con el
    // criterio de antes de la pesificación y sus líneas serían de otro mundo.
    const dif = [
      ["cobrado", linea.cobradoArs, guardado.collected ?? 0],
      ["costo KS", linea.gastosTratamiento, guardado.ks_cost ?? 0],
      ["a pagar", linea.liquidacionArs, guardado.due ?? 0],
    ] as const;
    const flojas = dif.filter(([, hoy, antes]) => Math.abs(hoy - antes) >= 1);
    const usdViejo = Number(t.USD?.collected ?? 0);
    if (flojas.length || usdViejo) {
      noCierran.push(
        `${liq.period} ${doctora}: ` +
        (usdViejo ? `se liquidó con US$ ${usdViejo.toLocaleString("es-AR")} aparte (criterio viejo)` : "") +
        (usdViejo && flojas.length ? " · " : "") +
        flojas.map(([q, hoy, antes]) => `${q} hoy ${$(hoy)} vs guardado ${$(antes)}`).join(" · ")
      );
      continue;
    }

    const cobros = calc.movs.filter(
      (m) => m.kind === "income" &&
        calc.periodoFinal.get(m.id) === liq.period &&
        calc.doctoraFinal.get(m.id) === doctora
    );
    const chocan = cobros.filter((m) => yaLiquidados.has(m.id));
    if (chocan.length) {
      trabadas.push(
        `${liq.period} ${doctora}: ${chocan.length} de sus ${cobros.length} cobros ya están ` +
        `liquidados en otra liquidación — no se repone nada para no duplicarlos`
      );
      continue;
    }
    if (!cobros.length) {
      noCierran.push(`${liq.period} ${doctora}: no tiene cobros propios (sólo retiros)`);
      continue;
    }

    const filas = cobros.map((m) => filaDeItem(calc, companyId, liq.id as string, m));
    const suma = filas.reduce((a, f) => a + f.base_amount, 0);
    // Cinturón y tirantes: si las líneas no suman el total, no se escriben.
    if (Math.abs(suma - (guardado.collected ?? 0)) >= 1) {
      noCierran.push(
        `${liq.period} ${doctora}: las ${filas.length} líneas suman ${$(suma)} y el total dice ` +
        `${$(guardado.collected ?? 0)}`
      );
      continue;
    }

    repuestas.push(`${liq.period} ${doctora}: ${filas.length} líneas · ${$(suma)}`);
    insertadas += filas.length;
    if (apply) {
      for (let i = 0; i < filas.length; i += 500) {
        const { error } = await db.from("settlement_items").insert(filas.slice(i, i + 500));
        if (error) throw new Error(`reponer ${liq.period}/${doctora}: ${error.message}`);
      }
      for (const m of cobros) yaLiquidados.add(m.id);
    }
  }

  console.log(`\n${repuestas.length ? "✓" : "—"} ${repuestas.length} liquidación(es) con detalle reponible (${insertadas} líneas):`);
  for (const r of repuestas) console.log(`     ${r}`);
  if (trabadas.length) {
    console.log(`\n⚠ ${trabadas.length} con cobros ya liquidados en otra liquidación:`);
    for (const t of trabadas) console.log(`     ${t}`);
  }
  if (noCierran.length) {
    console.log(`\n· ${noCierran.length} que NO cierran contra su total guardado (se dejan sin detalle):`);
    for (const n of noCierran) console.log(`     ${n}`);
  }
  console.log(apply
    ? `\n✓ ${insertadas} líneas repuestas. Ningún total ni estado fue modificado.`
    : `\n(dry-run: no se escribió nada — repetir con --apply)`);
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

// Carga en production_months los alineadores que México envió por mes.
//
// Fuente: seed-data/ficha_entrega_mx.json (volcado de la ficha de entrega del
// equipo de México). La consolidación —dedup entre hojas por año y por
// transportista, "-" como cero, repeticiones sueltas— vive en
// lib/produccion/ficha-entrega.ts y está cubierta por tests.
//
// Lo que este número ES: alineadores que salieron por la puerta cada mes.
// Lo que NO es: fabricación diaria. No existe ese registro en México.
//
// Uso:  npx tsx scripts/import-produccion-mx.ts            (dry-run)
//       npx tsx scripts/import-produccion-mx.ts --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, argFlags } from "./lib/service-client";
import { consolidarEnvios, type EnvioFicha } from "../lib/produccion/ficha-entrega";

const DESDE = "2026-01";   // el sistema arranca el 1/1/2026
const HASTA = "2026-08";

async function main() {
  const flags = argFlags();

  const ruta = resolve(__dirname, "../seed-data/ficha_entrega_mx.json");
  const raw = JSON.parse(readFileSync(ruta, "utf8")) as {
    fuente: string;
    envios: EnvioFicha[];
  };

  const { meses, descartados, aporte } = consolidarEnvios(raw.envios, {
    desde: DESDE, hasta: HASTA,
  });

  // ── Gate: sin meses o con un mes vacío, algo se rompió en el origen ─────────
  const esperados = 8;
  if (meses.length !== esperados) {
    throw new Error(`esperaba ${esperados} meses entre ${DESDE} y ${HASTA}, salieron ${meses.length}`);
  }
  const vacio = meses.find((m) => m.alineadores === 0);
  if (vacio) throw new Error(`el mes ${vacio.period} quedó en cero alineadores`);

  console.log(`\nFuente: ${raw.fuente}`);
  console.log(`Envíos únicos por hoja de origen: ${JSON.stringify(aporte)}`);
  if (descartados.length) {
    console.log(`\n${descartados.length} fila(s) con dato ilegible (cuentan cero):`);
    for (const d of descartados.slice(0, 10)) {
      console.log(`  hoja ${d.hoja} fila ${d.fila}: ${d.motivo}`);
    }
  }

  console.log("\nmes       alineadores  envíos  casos  repes  s/alin (cont/att/kit/otro)");
  for (const m of meses) {
    const s = m.sinAlineadores;
    console.log(
      `${m.period}   ${String(m.alineadores).padStart(8)}  ${String(m.envios).padStart(6)}` +
      `  ${String(m.casos).padStart(5)}  ${String(m.repeticiones).padStart(5)}` +
      `   ${s.contencion}/${s.attachments}/${s.kit}/${s.otro}`
    );
  }
  const total = meses.reduce((a, m) => a + m.alineadores, 0);
  const cerrados = meses.filter((m) => m.period < HASTA);
  const prom = Math.round(cerrados.reduce((a, m) => a + m.alineadores, 0) / cerrados.length);
  console.log(`TOTAL     ${String(total).padStart(8)}   ·  promedio de los ${cerrados.length} meses cerrados: ${prom}/mes`);

  if (!flags.apply) {
    console.log("\nDRY-RUN: nada se escribió. Repetir con --apply.");
    return;
  }

  const db = await serviceClient({
    accion: "cargar los alineadores enviados por mes de KS México",
    auto: flags.yes,
  });

  const { data: cia, error: eCia } = await db
    .from("companies").select("id").eq("slug", "mx").single();
  if (eCia || !cia) throw new Error(`empresa 'mx' inexistente: ${eCia?.message}`);

  const filas = meses.map((m) => {
    const s = m.sinAlineadores;
    const sinAlin = s.contencion + s.attachments + s.kit + s.otro;
    return {
      company_id: cia.id,
      period: m.period,
      aligners_produced: m.alineadores,
      cases_shipped: m.casos,
      notes:
        `Ficha de entrega MX. ${m.envios} envíos (${m.enviosConAlineadores} con placas, ` +
        `${m.repeticiones} de 1-2 placas sueltas = repeticiones). ` +
        `${sinAlin} envío(s) sin placas: ${s.contencion} contención, ${s.attachments} attachments, ` +
        `${s.kit} kit, ${s.otro} sin clasificar — la contención sola no trae cantidad en la planilla, ` +
        `así que ese volumen no está contado. Fecha = envío, no fabricación.`,
    };
  });

  const { error } = await db
    .from("production_months")
    .upsert(filas, { onConflict: "company_id,period" });
  if (error) throw new Error(`upsert production_months: ${error.message}`);

  console.log(`\n${filas.length} meses cargados en production_months (empresa mx).`);

  // ── Verificación: releer y comparar contra lo que se quiso escribir ─────────
  const { data: leidos } = await db
    .from("production_months")
    .select("period, aligners_produced, cases_shipped")
    .eq("company_id", cia.id)
    .order("period");
  const dif = (leidos ?? []).filter((l, i) => l.aligners_produced !== meses[i]?.alineadores);
  if (dif.length) throw new Error(`la base quedó distinta de lo calculado: ${JSON.stringify(dif)}`);
  console.log("Verificado: lo que hay en la base es lo que se calculó.");

  // ── Estado de la otra pata del costo ───────────────────────────────────────
  const { count } = await db
    .from("movements")
    .select("id", { count: "exact", head: true })
    .eq("company_id", cia.id).eq("kind", "expense").neq("status", "void");
  console.log(
    count
      ? `\nMéxico tiene ${count} gasto(s) cargados: la pantalla de costos ya puede dividir.`
      : "\nOJO: México sigue con CERO gastos cargados. Con unidades pero sin gastos, " +
        "el costo por alineador da vacío. Falta el extracto de BBVA MX."
  );
}

main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });

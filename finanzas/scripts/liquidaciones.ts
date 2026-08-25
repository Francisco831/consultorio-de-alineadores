// Calcula las liquidaciones de las doctoras desde el ledger y las compara contra
// la salida del script viejo (consultorio-gestion/build_liquidaciones.py).
//
// El plan lo pedía explícito: correr los dos en paralelo y exigir Δ$0 ANTES de
// apagar el script viejo. Sin --apply solo compara.
//
// Uso:  npx tsx scripts/liquidaciones.ts            (compara contra la referencia)
//       npx tsx scripts/liquidaciones.ts --apply    (además las guarda en la base)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, fetchAllRows, argFlags } from "./lib/service-client";
import {
  costearCuotas, calcularLiquidaciones,
  type CobroAlineador, type MovimientoLiq,
} from "../lib/liquidaciones/costeo";

// Excepciones declaradas en build_liquidaciones.py
const ETAPA_ADICIONAL = new Set(["cugat fernanda", "fernanda cugat"]);
const PLAN_PACIENTE: Record<string, number> = { "hogner agustina": 7, "agustina hogner": 7 };
// Precio TOTAL pactado con cada paciente — tabla pasada por Pancho el 24/8/26.
// La clave es el nombre (se normaliza con clavePaciente); las variantes de
// grafía de la caja se repiten para que el match no falle.
const PRECIO_PACTADO: Record<string, number> = {
  "ponce sarahi": 3800000,
  "de donatis luz": 3626000, "de lonatis maria luz": 3626000,
  "russo sofia": 3800000,
  "herrera evelin": 4800000,
  "tonello fiorella": 3760000,
  "badiola ramiro": 3800000,
  "de frankerberg josefina": 3650000,
  "gallo gaston": 3900000,
  "lazaro magdalena": 3700000, "magui lazaro": 3700000,
  "daira castellon": 1200000,
  "szalontai natalia": 3800000,
  "agustina di natale": 3800000, "agustina di natale 39769016": 3800000,
  "tapia macarena": 3000000,
  "vicent patricia": 3800000,  // la tabla decía 380.000: typo confirmado por Pancho 24/8
};
const PRECIO_PACTADO_USD: Record<string, number> = {
  "botto agustina": 2800,
  "etchegoyen ignacio": 2250,
  "grillo catalina": 2250,
  "hogner agustina": 2800,     // paga en pesos al t/c de cada fila
  "nisenbaum martin": 2300, "martin nissenbaum": 2300, "nisenbaum": 2300,
  "de la torre guadalupe": 2700,
};

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

  // Imputación por devengado: algunos movimientos liquidan un período distinto
  // del de su fecha (los pagos salen por MP ~el 24 del mes siguiente; Herrera
  // se devengó en junio). seed-data/periodo_liquidacion_overrides.json.
  const overrides = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/periodo_liquidacion_overrides.json"), "utf8")
  ).filas as Array<{ occurred_on: string; monto: number; doctora: string; periodo: string }>;
  const periodoOverride = new Map(
    overrides.map((o) => [`${o.occurred_on}|${o.monto}|${o.doctora}`, o.periodo])
  );
  const periodoDe = (m: { occurred_on: string; amount: number | string; meta?: { doctora?: string } | null }) =>
    periodoOverride.get(`${m.occurred_on}|${Math.round(Number(m.amount))}|${m.meta?.doctora ?? ""}`)
      ?? m.occurred_on.slice(0, 7);

  const db = await serviceClient({
    accion: "calcular liquidaciones de doctoras y compararlas con el script viejo",
    auto: true,   // solo lee salvo --apply; el guard igual anuncia el destino
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");
  const companyId = cia.id;

  const { data: precio } = await db.from("ks_price_list").select("*")
    .eq("company_id", companyId).eq("audience", "adultos").eq("scope", "full")
    .eq("arcades", 2).order("valid_from", { ascending: false }).limit(1).single();
  if (!precio) throw new Error("falta la lista de precios KS: correr seed-etapa2");

  const { data: profs } = await db.from("professionals")
    .select("settlement_pct, settles_separately, cp:counterparties!inner(display_name)")
    .eq("company_id", companyId);
  const pctPorDoctora = new Map<string, number>();
  const aparte = new Set<string>();
  for (const p of profs ?? []) {
    const nombre = (p.cp as unknown as { display_name: string }).display_name;
    pctPorDoctora.set(nombre, Number(p.settlement_pct));
    if (p.settles_separately) aparte.add(nombre);
  }

  const movs = await fetchAllRows<{
    id: string; occurred_on: string; kind: string; amount: string; currency: string;
    meta: {
      doctora?: string; motivo?: string; obs?: string;
      tipo_origen?: string; categoria_origen?: string; seq?: number;
    };
    counterparties: { display_name: string } | null;
  }>(db, "movements",
    "id, occurred_on, kind, amount, currency, meta, counterparties(display_name)",
    (q) => q.eq("company_id", companyId).neq("status", "void"));

  // El orden (meta.seq) solo decide QUÉ cuota se costea cuando hay pagos
  // parciales, así que se exige únicamente a los cobros de alineadores. Los
  // egresos cargados desde un extracto no participan del costeo.
  const sinSeq = movs.filter(
    (m) => m.kind === "income" && m.meta?.categoria_origen === "Alineadores" && m.meta?.seq == null
  ).length;
  if (sinSeq) {
    console.error(`✗ ${sinSeq} cobros de alineadores sin meta.seq: correr scripts/backfill-seq.ts --apply`);
    process.exit(1);
  }

  // cobros de alineadores → costeo KS (una fila por PATA de moneda, como el original)
  const cobrosAlineadores: CobroAlineador[] = movs
    .filter((m) => m.kind === "income" && m.meta?.categoria_origen === "Alineadores")
    .map((m) => ({
      id: m.id,
      paciente: (m.counterparties as { display_name?: string } | null)?.display_name ?? "",
      fecha: m.occurred_on,
      ars: m.currency === "USD" ? 0 : Number(m.amount),
      usd: m.currency === "USD" ? Number(m.amount) : 0,
      motivo: m.meta?.motivo ?? "",
      texto: `${m.meta?.motivo ?? ""} ${m.meta?.obs ?? ""}`,
      seq: m.meta?.seq ?? 0,
    }));

  // Historial de listas KS con vigencia: el caso paga la lista vigente a su
  // fecha de INGRESO (regla Pancho 24/8/26 — SIEMPRE la histórica).
  const { data: listaKs } = await db.from("ks_price_list").select("*").eq("company_id", companyId);
  const porVigencia = new Map<string, Map<string, { list_price: number; discount_pct: number }>>();
  for (const r of listaKs ?? []) {
    const m = porVigencia.get(r.valid_from) ?? new Map();
    m.set(`${r.audience}/${r.scope}/${r.arcades}`,
      { list_price: Number(r.list_price), discount_pct: Number(r.discount_pct) });
    porVigencia.set(r.valid_from, m);
  }
  const listas = [...porVigencia].map(([validFrom, precios]) => ({ validFrom, precios }));
  console.log(`Listas de precios KS: ${listas.map((l) => l.validFrom).sort().join(" · ")}`);

  // tipo real de tratamiento + fecha de ingreso por paciente (Noloco)
  const tipoPorPaciente = new Map<string, string>();
  const ingresoPorPaciente = new Map<string, string>();
  try {
    const tipos = JSON.parse(readFileSync(resolve(__dirname, "../seed-data/tipos_tratamiento_ar.json"), "utf8"));
    for (const [clave, t] of Object.entries<{ audience: string; scope: string; arcades: number; ingreso?: string | null }>(tipos.tipos ?? {})) {
      tipoPorPaciente.set(clave, `${t.audience}/${t.scope}/${t.arcades}`);
      if (t.ingreso) ingresoPorPaciente.set(clave, t.ingreso.slice(0, 10));
    }
    console.log(`Tipos de tratamiento desde Noloco: ${tipoPorPaciente.size} pacientes (${ingresoPorPaciente.size} con fecha de ingreso)`);
  } catch { console.log("(sin tipos_tratamiento_ar.json: todos al tipo default)"); }

  const { costoArs, costoUsd, etiquetas, sinCostear } = costearCuotas(cobrosAlineadores, {
    precioDefault: {
      list_price: Number(precio.list_price), discount_pct: Number(precio.discount_pct),
    },
    listas,
    tipoPorPaciente,
    ingresoPorPaciente,
    planPorPaciente: PLAN_PACIENTE,
    precioPactado: PRECIO_PACTADO,
    precioPactadoUsd: PRECIO_PACTADO_USD,
    etapaAdicional: ETAPA_ADICIONAL,
  });
  console.log(`\nCobros de alineadores: ${cobrosAlineadores.length} · sin costear: ${sinCostear}`);

  const paraLiquidar: MovimientoLiq[] = movs
    .filter((m) => m.meta?.doctora)
    .map((m) => ({
      id: m.id,
      doctora: m.meta!.doctora!,
      periodo: periodoDe(m),
      ars: m.currency === "USD" ? 0 : Number(m.amount),
      usd: m.currency === "USD" ? Number(m.amount) : 0,
      tipo:
        m.meta?.tipo_origen === "retiro_liquidacion" ? "retiro_liquidacion"
        : m.meta?.tipo_origen === "gasto_tratamiento" ? "gasto_tratamiento"
        : m.kind === "income" ? "cobro"
        : "otro",
    }));

  const calculadas = calcularLiquidaciones(
    paraLiquidar, costoArs, costoUsd,
    (d) => pctPorDoctora.get(d) ?? 40
  );

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
    if (aparte.has(l.doctora)) continue;         // Coni: cuenta propia, fuera
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
  const { data: cps } = await db.from("counterparties").select("id, display_name")
    .eq("company_id", companyId).eq("kind", "professional");
  const idPorNombre = new Map((cps ?? []).map((c) => [c.display_name, c.id]));

  // una liquidación confirmada/pagada está CONGELADA: el recálculo no la toca
  const { data: existentes } = await db.from("professional_settlements")
    .select("id, professional_id, period, status").eq("company_id", companyId);
  const estadoPorClave = new Map((existentes ?? []).map((e) => [`${e.professional_id}|${e.period}`, e]));

  let guardadas = 0, congeladas = 0, itemsTotal = 0;
  for (const l of calculadas) {
    if (aparte.has(l.doctora)) continue;
    const profId = idPorNombre.get(l.doctora);
    if (!profId) continue;
    const previa = estadoPorClave.get(`${profId}|${l.periodo}`);
    if (previa && previa.status !== "draft") { congeladas++; continue; }
    const { data: set, error } = await db.from("professional_settlements").upsert({
      company_id: companyId, professional_id: profId, period: l.periodo,
      status: "draft", pct: pctPorDoctora.get(l.doctora) ?? 40,
      totals: {
        ARS: { collected: l.cobradoArs, ks_cost: l.gastosTratamiento, base: l.baseArs, due: l.liquidacionArs, withdrawn: l.retiros, balance: l.saldo },
        USD: { collected: l.cobradoUsd, due: l.liquidacionUsd },
      },
    }, { onConflict: "company_id,professional_id,period" }).select("id").single();
    if (error) throw new Error(`settlement ${l.periodo}/${l.doctora}: ${error.message}`);
    guardadas++;

    // ---- detalle línea por línea: cada cobro del mes con su costo KS ----
    const cobrosDelMes = movs.filter((m) =>
      m.kind === "income" && m.meta?.doctora === l.doctora &&
      periodoDe(m) === l.periodo);
    await db.from("settlement_items").delete().eq("settlement_id", set!.id);
    if (cobrosDelMes.length) {
      // un cobro re-imputado por devengado (periodo_liquidacion_overrides) puede
      // tener su ítem viejo bajo OTRA liquidación (la del mes de su fecha): se
      // retira antes de insertar o la restricción única por movimiento lo rechaza
      await db.from("settlement_items").delete()
        .eq("company_id", companyId).in("movement_id", cobrosDelMes.map((m) => m.id));
      const filas = cobrosDelMes.map((m) => ({
        company_id: companyId, settlement_id: set!.id, movement_id: m.id,
        base_amount: Number(m.amount), currency: m.currency,
        ks_cost: m.currency === "USD" ? (costoUsd.get(m.id) ?? 0) : (costoArs.get(m.id) ?? 0),
        label: [m.meta?.motivo, etiquetas.get(m.id)].filter(Boolean).join(" · ") || null,
      }));
      for (let i = 0; i < filas.length; i += 500) {
        const { error: e2 } = await db.from("settlement_items").insert(filas.slice(i, i + 500));
        if (e2) throw new Error(`items ${l.periodo}/${l.doctora}: ${e2.message}`);
      }
      itemsTotal += filas.length;
    }
  }
  console.log(`\n✓ ${guardadas} liquidaciones guardadas con ${itemsTotal} líneas de detalle` +
    (congeladas ? ` · ${congeladas} confirmadas/pagadas sin tocar` : "") + ".");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

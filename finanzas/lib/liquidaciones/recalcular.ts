// Recalcular las liquidaciones de las doctoras y guardarlas.
//
// Es el mismo cálculo que corría sólo en la terminal (scripts/liquidaciones.ts):
// ahora vive acá para que el botón "Recalcular" del panel y el script hagan
// EXACTAMENTE lo mismo. Si fueran dos implementaciones, el día que difieran nadie
// se entera hasta que una doctora reclama.
//
// Tres reglas que este archivo hace cumplir:
//  1. El costeo mira TODA la historia (el costo KS se acumula con tope por caso),
//     así que siempre se calcula el año entero aunque se guarde un solo mes.
//  2. Una liquidación confirmada o pagada está CONGELADA: no se toca.
//  3. Una liquidación que se quedó sin cobros se ANULA, no se deja de fantasma.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  costearCuotas, calcularLiquidaciones,
  type CobroAlineador, type MovimientoLiq, type LineaLiquidacion,
} from "./costeo";
import {
  COSTO_ETAPA_ADICIONAL, ETAPA_ADICIONAL, PLAN_PACIENTE,
  PRECIO_PACTADO, PRECIO_PACTADO_USD,
} from "./pactos";
import {
  doctoraDeLiquidacion, estaCongelada, liquidacionesSinRespaldo,
  type Imputaciones,
} from "./imputacion";
import tiposTratamiento from "../../seed-data/tipos_tratamiento_ar.json";
import periodoOverrides from "../../seed-data/periodo_liquidacion_overrides.json";

export type MovimientoBase = {
  id: string;
  occurred_on: string;
  kind: string;
  amount: string | number;
  currency: string;
  meta: {
    doctora?: string; motivo?: string; obs?: string;
    tipo_origen?: string; categoria_origen?: string; seq?: number;
  } | null;
  counterparties: { display_name: string } | null;
};

export type ResumenRecalculo = {
  periodos: string[];
  guardadas: number;
  items: number;
  congeladas: string[];
  anuladas: string[];
  sinCostear: number;
  huerfanas: number;
};

// el builder de PostgREST es un genérico intratable; el filtro sólo encadena .eq/.neq
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Filtro = (q: any) => any;

/** SELECT paginado: PostgREST corta en 1.000 filas sin avisar. */
async function traerTodo<T>(
  db: SupabaseClient, tabla: string, select: string, filtro: Filtro
): Promise<T[]> {
  const out: T[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await filtro(db.from(tabla).select(select)).range(desde, desde + 999);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}

/** Período de liquidación de un movimiento: por devengado, no por fecha. */
export function periodoDeMovimiento(m: MovimientoBase): string {
  const clave = `${m.occurred_on}|${Math.round(Number(m.amount))}|${m.meta?.doctora ?? ""}`;
  const filas = periodoOverrides.filas as Array<{ occurred_on: string; monto: number; doctora: string; periodo: string }>;
  const hit = filas.find((o) => `${o.occurred_on}|${o.monto}|${o.doctora}` === clave);
  return hit?.periodo ?? m.occurred_on.slice(0, 7);
}

export type Calculo = {
  calculadas: LineaLiquidacion[];
  movs: MovimientoBase[];
  doctoraFinal: Map<string, string | null>;
  periodoFinal: Map<string, string>;
  costoArs: Map<string, number>;
  costoUsd: Map<string, number>;
  etiquetas: Map<string, string>;
  pctPorDoctora: Map<string, number>;
  idPorDoctora: Map<string, string>;
  nombrePorId: Map<string, string>;
  sinCostear: number;
  huerfanas: number;
};

/**
 * Calcula TODO el año sin escribir nada. El costeo acumula el costo KS por caso
 * con tope, así que un mes suelto no se puede calcular sin los anteriores.
 */
export async function calcularTodo(
  db: SupabaseClient, companyId: string
): Promise<Calculo> {
  // ---------- lo que hace falta para calcular ----------
  const { data: precio } = await db.from("ks_price_list").select("*")
    .eq("company_id", companyId).eq("audience", "adultos").eq("scope", "full")
    .eq("arcades", 2).order("valid_from", { ascending: false }).limit(1).maybeSingle();
  if (!precio) throw new Error("falta la lista de precios KS (correr seed-etapa2)");

  const { data: profs } = await db.from("professionals")
    .select("counterparty_id, settlement_pct, settles_separately, cp:counterparties!inner(display_name)")
    .eq("company_id", companyId);
  const pctPorDoctora = new Map<string, number>();
  const idPorDoctora = new Map<string, string>();
  const aparte = new Set<string>();
  for (const p of profs ?? []) {
    const nombre = (p.cp as unknown as { display_name: string }).display_name;
    pctPorDoctora.set(nombre, Number(p.settlement_pct));
    idPorDoctora.set(nombre, p.counterparty_id as string);
    if (p.settles_separately) aparte.add(nombre);   // Coni cobra a cuenta propia
  }
  const nombrePorId = new Map([...idPorDoctora].map(([n, id]) => [id, n]));

  const movs = await traerTodo<MovimientoBase>(
    db, "movements",
    "id, occurred_on, kind, amount, currency, meta, counterparties(display_name)",
    (q) => q.eq("company_id", companyId).neq("status", "void")
  );

  // Correcciones de imputación (0022): el cobro se liquida a quien diga esta
  // tabla, y si dice NULL no se le liquida a nadie.
  const { data: impRaw } = await db.from("settlement_imputations")
    .select("movement_id, destino, professional_id, revisado").eq("company_id", companyId);
  const vivos = new Set(movs.map((m) => m.id));
  const imputaciones: Imputaciones = new Map();
  let huerfanas = 0;
  for (const i of impRaw ?? []) {
    // la external_key de la caja es de contenido: si Claudia edita la fila, el
    // movimiento imputado se anula y esta corrección apunta a la nada
    if (!vivos.has(i.movement_id as string)) { huerfanas++; continue; }
    imputaciones.set(i.movement_id as string, {
      destino: i.destino as "caja" | "casa" | "profesional",
      doctora: i.professional_id ? (nombrePorId.get(i.professional_id as string) ?? null) : null,
      revisado: Boolean(i.revisado),
    });
  }

  // El orden de la caja (meta.seq) decide qué cuota define el pacto cuando hay
  // pagos parciales. Sin él el costeo reparte distinto, así que se frena.
  const sinSeq = movs.filter(
    (m) => m.kind === "income" && m.meta?.categoria_origen === "Alineadores" && m.meta?.seq == null
  ).length;
  if (sinSeq) {
    throw new Error(
      `${sinSeq} cobros de alineadores sin el orden de la caja (meta.seq): el costeo ` +
      `no es reproducible hasta que corra el backfill de la sync nocturna.`
    );
  }

  // ---------- costeo KS ----------
  const cobrosAlineadores: CobroAlineador[] = movs
    .filter((m) => m.kind === "income" && m.meta?.categoria_origen === "Alineadores")
    .map((m) => ({
      id: m.id,
      paciente: m.counterparties?.display_name ?? "",
      fecha: m.occurred_on,
      ars: m.currency === "USD" ? 0 : Number(m.amount),
      usd: m.currency === "USD" ? Number(m.amount) : 0,
      motivo: m.meta?.motivo ?? "",
      texto: `${m.meta?.motivo ?? ""} ${m.meta?.obs ?? ""}`,
      seq: m.meta?.seq ?? 0,
    }));

  const { data: listaKs } = await db.from("ks_price_list").select("*").eq("company_id", companyId);
  const porVigencia = new Map<string, Map<string, { list_price: number; discount_pct: number }>>();
  for (const r of listaKs ?? []) {
    const m = porVigencia.get(r.valid_from) ?? new Map();
    m.set(`${r.audience}/${r.scope}/${r.arcades}`,
      { list_price: Number(r.list_price), discount_pct: Number(r.discount_pct) });
    porVigencia.set(r.valid_from, m);
  }
  const listas = [...porVigencia].map(([validFrom, precios]) => ({ validFrom, precios }));

  const tipoPorPaciente = new Map<string, string>();
  const ingresoPorPaciente = new Map<string, string>();
  const tipos = (tiposTratamiento as { tipos?: Record<string, { audience: string; scope: string; arcades: number; ingreso?: string | null }> }).tipos ?? {};
  for (const [clave, t] of Object.entries(tipos)) {
    tipoPorPaciente.set(clave, `${t.audience}/${t.scope}/${t.arcades}`);
    if (t.ingreso) ingresoPorPaciente.set(clave, t.ingreso.slice(0, 10));
  }

  const { costoArs, costoUsd, etiquetas, sinCostear } = costearCuotas(cobrosAlineadores, {
    precioDefault: {
      list_price: Number(precio.list_price), discount_pct: Number(precio.discount_pct),
    },
    listas, tipoPorPaciente, ingresoPorPaciente,
    planPorPaciente: PLAN_PACIENTE,
    precioPactado: PRECIO_PACTADO,
    precioPactadoUsd: PRECIO_PACTADO_USD,
    etapaAdicional: ETAPA_ADICIONAL,
    costoEtapaAdicional: COSTO_ETAPA_ADICIONAL,
  });

  // ---------- liquidaciones ----------
  const doctoraFinal = new Map<string, string | null>(
    movs.map((m) => [m.id, doctoraDeLiquidacion(m.id, m.meta?.doctora, imputaciones)])
  );
  const periodoFinal = new Map(movs.map((m) => [m.id, periodoDeMovimiento(m)]));

  const paraLiquidar: MovimientoLiq[] = movs
    .filter((m) => doctoraFinal.get(m.id))
    .map((m) => ({
      id: m.id,
      doctora: doctoraFinal.get(m.id)!,
      periodo: periodoFinal.get(m.id)!,
      ars: m.currency === "USD" ? 0 : Number(m.amount),
      usd: m.currency === "USD" ? Number(m.amount) : 0,
      tipo:
        m.meta?.tipo_origen === "retiro_liquidacion" ? "retiro_liquidacion"
        : m.meta?.tipo_origen === "gasto_tratamiento" ? "gasto_tratamiento"
        : m.kind === "income" ? "cobro"
        : "otro",
    }));

  const calculadas = calcularLiquidaciones(
    paraLiquidar, costoArs, costoUsd, (d) => pctPorDoctora.get(d) ?? 40
  ).filter((l) => !aparte.has(l.doctora));

  return {
    calculadas, movs, doctoraFinal, periodoFinal, costoArs, costoUsd, etiquetas,
    pctPorDoctora, idPorDoctora, nombrePorId, sinCostear, huerfanas,
  };
}

/**
 * Guarda las liquidaciones de `periodos` (o todas). Devuelve qué hizo.
 * El cálculo entra hecho: así el script puede compararlo contra la referencia
 * ANTES de escribir una sola fila.
 */
export async function guardarLiquidaciones(
  db: SupabaseClient,
  companyId: string,
  calc: Calculo,
  opts: { periodos?: string[] } = {}
): Promise<ResumenRecalculo> {
  const {
    calculadas, movs, doctoraFinal, periodoFinal, costoArs, costoUsd, etiquetas,
    pctPorDoctora, idPorDoctora, nombrePorId, sinCostear, huerfanas,
  } = calc;

  const periodos = opts.periodos?.length
    ? [...opts.periodos].sort()
    : [...new Set(calculadas.map((l) => l.periodo))].sort();
  const alcance = new Set(periodos);

  // ---------- guardar ----------
  const { data: existentesRaw } = await db.from("professional_settlements")
    .select("id, professional_id, period, status").eq("company_id", companyId);
  const existentes = (existentesRaw ?? []).map((e) => ({
    id: e.id as string,
    doctora: nombrePorId.get(e.professional_id as string) ?? "",
    periodo: e.period as string,
    status: e.status as string,
  }));
  const estadoPorClave = new Map(existentes.map((e) => [`${e.doctora}|${e.periodo}`, e]));

  const resumen: ResumenRecalculo = {
    periodos, guardadas: 0, items: 0, congeladas: [], anuladas: [],
    sinCostear, huerfanas,
  };

  for (const periodo of periodos) {
    // Los ítems se rehacen enteros: se limpian por MOVIMIENTO del período (no
    // por liquidación) porque un cobro pudo cambiar de doctora, y su ítem viejo
    // cuelga de otra liquidación. El unique(company_id, movement_id) rechazaría
    // el insert nuevo con un mensaje que no dice nada de esto.
    const movsDelPeriodo = movs.filter((m) => periodoFinal.get(m.id) === periodo);
    if (movsDelPeriodo.length) {
      for (let i = 0; i < movsDelPeriodo.length; i += 200) {
        const { error } = await db.from("settlement_items").delete()
          .eq("company_id", companyId)
          .in("movement_id", movsDelPeriodo.slice(i, i + 200).map((m) => m.id));
        if (error) throw new Error(`limpiar ítems de ${periodo}: ${error.message}`);
      }
    }

    for (const l of calculadas.filter((c) => c.periodo === periodo)) {
      const profId = idPorDoctora.get(l.doctora);
      if (!profId) continue;
      const previa = estadoPorClave.get(`${l.doctora}|${l.periodo}`);
      if (previa && estaCongelada(previa.status)) {
        resumen.congeladas.push(`${l.periodo} ${l.doctora}`);
        continue;
      }
      const { data: set, error } = await db.from("professional_settlements").upsert({
        company_id: companyId, professional_id: profId, period: l.periodo,
        status: "draft", pct: pctPorDoctora.get(l.doctora) ?? 40,
        totals: {
          ARS: {
            collected: l.cobradoArs, ks_cost: l.gastosTratamiento, base: l.baseArs,
            due: l.liquidacionArs, withdrawn: l.retiros, balance: l.saldo,
          },
          USD: { collected: l.cobradoUsd, due: l.liquidacionUsd },
        },
      }, { onConflict: "company_id,professional_id,period" }).select("id").single();
      if (error) throw new Error(`liquidación ${l.periodo}/${l.doctora}: ${error.message}`);
      resumen.guardadas++;

      const cobrosDelMes = movsDelPeriodo.filter(
        (m) => m.kind === "income" && doctoraFinal.get(m.id) === l.doctora
      );
      if (cobrosDelMes.length) {
        const filas = cobrosDelMes.map((m) => ({
          company_id: companyId, settlement_id: set!.id, movement_id: m.id,
          base_amount: Number(m.amount), currency: m.currency,
          ks_cost: m.currency === "USD" ? (costoUsd.get(m.id) ?? 0) : (costoArs.get(m.id) ?? 0),
          label: [m.meta?.motivo, etiquetas.get(m.id)].filter(Boolean).join(" · ") || null,
        }));
        for (let i = 0; i < filas.length; i += 500) {
          const { error: e2 } = await db.from("settlement_items").insert(filas.slice(i, i + 500));
          if (e2) throw new Error(`ítems ${l.periodo}/${l.doctora}: ${e2.message}`);
        }
        resumen.items += filas.length;
      }
    }
  }

  // ---------- las que se quedaron sin respaldo ----------
  for (const s of liquidacionesSinRespaldo(existentes, calculadas, [...alcance])) {
    await db.from("settlement_items").delete().eq("settlement_id", s.id);
    const { error } = await db.from("professional_settlements")
      .update({ status: "void", totals: {} }).eq("id", s.id);
    if (error) throw new Error(`anular ${s.periodo}/${s.doctora}: ${error.message}`);
    resumen.anuladas.push(`${s.periodo} ${s.doctora}`);
  }

  return resumen;
}

/** Calcular y guardar de una: lo que aprieta el botón del panel. */
export async function recalcularLiquidaciones(
  db: SupabaseClient,
  companyId: string,
  opts: { periodos?: string[] } = {}
): Promise<ResumenRecalculo> {
  const calc = await calcularTodo(db, companyId);
  return guardarLiquidaciones(db, companyId, calc, opts);
}

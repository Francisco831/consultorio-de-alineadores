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
//  4. Lo que entró en dólares se pesifica al blue de SU fecha antes de entrar a
//     la liquidación (regla de Pancho del 25/8/26). La caja sigue guardando el
//     movimiento en dólares —esa es la verdad de lo que pasó—; lo que se
//     pesifica es la liquidación, y el detalle impreso dice el t/c usado.

import type { SupabaseClient } from "@supabase/supabase-js";
import { FUENTE_TC, tablaTC, type Cotizacion, type TablaTC } from "../fx";
import {
  costearCuotas, calcularLiquidaciones,
  type CobroAlineador, type MovimientoLiq, type LineaLiquidacion,
} from "./costeo";
import { cargarPactos } from "./pactos-db";
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
  /** Cobros que el cálculo querría mover pero siguen liquidados en una cerrada. */
  trabados: string[];
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

/**
 * Cómo entra un movimiento a una liquidación: su importe en pesos y, si vino en
 * dólares, la nota que deja explicado el cambio en el detalle impreso. La
 * doctora tiene que poder rehacer la cuenta sin preguntarle nada a nadie.
 */
function pesificador(tc: TablaTC) {
  const arsDe = (m: MovimientoBase): number => {
    const monto = Number(m.amount);
    if (m.currency !== "USD") return monto;
    const t = tc(m.occurred_on);
    if (t == null) {
      // calcularTodo() ya frenó antes por esto; acá sólo queda como red.
      throw new Error(`sin cotización del blue para el ${m.occurred_on}`);
    }
    return Math.round(monto * t * 100) / 100;
  };
  const notaCambio = (m: MovimientoBase): string | null => {
    if (m.currency !== "USD") return null;
    const t = tc(m.occurred_on);
    const fecha = tc.fechaUsada(m.occurred_on);
    if (t == null || !fecha) return null;
    const dm = `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}`;
    return (
      `US$ ${Number(m.amount).toLocaleString("es-AR")} × t/c ` +
      `${t.toLocaleString("es-AR")} (blue ${dm})`
    );
  };
  return { arsDe, notaCambio };
}

/**
 * Un número de la liquidación escrito a mano (settlement_line_overrides, 0030).
 * NULL en cualquiera de los dos = "ese no lo toco, vale lo que calculó el motor".
 */
export type OverrideLinea = {
  cobradoArs: number | null;
  costoKsArs: number | null;
  motivo: string;
};

/** Un override que quedó colgado: la caja editó su fila y el movimiento se anuló. */
export type OverrideHuerfano = OverrideLinea & {
  movementId: string;
  snapshot: { fecha?: string; paciente?: string; doctora?: string; periodo?: string };
};

export type Calculo = {
  calculadas: LineaLiquidacion[];
  movs: MovimientoBase[];
  doctoraFinal: Map<string, string | null>;
  periodoFinal: Map<string, string>;
  costoArs: Map<string, number>;
  /** Importe del movimiento en pesos: el suyo, o el pesificado si era en USD. */
  arsDe: (m: MovimientoBase) => number;
  /** Nota del cambio ("US$ 360 al t/c 1.505 del 03/07"), sólo para los USD. */
  notaCambio: (m: MovimientoBase) => string | null;
  /** Lo que se puso a mano en cada línea, por movimiento. */
  overrides: Map<string, OverrideLinea>;
  /** Los que apuntan a un movimiento que la caja anuló: el número dejó de aplicarse. */
  overridesHuerfanos: OverrideHuerfano[];
  etiquetas: Map<string, string>;
  pctPorDoctora: Map<string, number>;
  idPorDoctora: Map<string, string>;
  nombrePorId: Map<string, string>;
  sinCostear: number;
  huerfanas: number;
};

/**
 * Una línea del detalle de una liquidación, tal como se guarda.
 *
 * Vive acá y no dentro del guardado porque hay dos caminos que la escriben: el
 * recálculo normal y la reconstrucción del detalle de liquidaciones viejas
 * (scripts/reconstruir-detalle.ts). Si cada uno armara la fila por su cuenta,
 * el día que se separen habría dos versiones de la misma plata y nadie se
 * enteraría hasta que una doctora compare dos impresiones.
 */
export function filaDeItem(
  calc: Calculo, companyId: string, settlementId: string, m: MovimientoBase
) {
  const ov = calc.overrides.get(m.id);
  return {
    company_id: companyId,
    settlement_id: settlementId,
    movement_id: m.id,
    base_amount: calc.arsDe(m),
    currency: "ARS",
    ks_cost: calc.costoArs.get(m.id) ?? 0,
    label: [
      m.meta?.motivo,
      // Si el importe se puso a mano, "US$ 2.600 × t/c 1.505" pasa a ser
      // mentira: esa cuenta ya no da el número de la línea.
      ov?.cobradoArs == null ? calc.notaCambio(m) : null,
      calc.etiquetas.get(m.id),   // el costo a mano ya se explica solo
      ov?.cobradoArs == null ? null : notaCobradoAMano(ov.cobradoArs, ov.motivo, m),
    ].filter(Boolean).join(" · ") || null,
  };
}

/**
 * Lo que lee la doctora en su PDF cuando el importe se puso a mano.
 *
 * Dice "puesto a mano" y nunca "corregido": es un papel que ella recibe, y
 * tiene que poder preguntar por esa línea sin que el texto la acuse de nada. El
 * motivo va (es lo único que va a tener sentido en seis meses); el quién y el
 * cuándo no — eso vive en audit_log y en el panel de cambios a mano.
 */
function notaCobradoAMano(cobradoArs: number, motivo: string, m: MovimientoBase): string {
  const original = m.currency === "USD"
    ? `US$ ${Number(m.amount).toLocaleString("es-AR")}`
    : `$${Math.round(Number(m.amount)).toLocaleString("es-AR")}`;
  return (
    `cobrado puesto a mano: $${Math.round(cobradoArs).toLocaleString("es-AR")} ` +
    `(la caja dice ${original})` + (motivo ? ` — ${motivo}` : "")
  );
}

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

  // ---------- el dólar de cada día ----------
  // Se pesifica contra la serie guardada (fx_rates), no contra la fuente en
  // vivo: una liquidación tiene que dar lo mismo dentro de un año.
  const cotizaciones = await traerTodo<{ quote_date: string; buy: string; sell: string }>(
    db, "fx_rates", "quote_date, buy, sell", (q) => q.eq("source", FUENTE_TC)
  );
  const tc = tablaTC(cotizaciones.map((c): Cotizacion => ({
    fecha: c.quote_date, compra: Number(c.buy), venta: Number(c.sell),
  })));
  const enUsd = movs.filter((m) => m.currency === "USD");
  if (enUsd.length && !cotizaciones.length) {
    throw new Error(
      `hay ${enUsd.length} movimientos en dólares y ninguna cotización cargada: ` +
      `correr "npx tsx scripts/sync-cotizaciones.ts --apply" antes de liquidar.`
    );
  }
  // Un cobro anterior a la primera cotización no se pesifica a ojo: se frena.
  // Liquidar de menos es más caro que esperar a que alguien cargue el dato.
  const sinCotizacion = enUsd.filter((m) => tc(m.occurred_on) == null);
  if (sinCotizacion.length) {
    const f = sinCotizacion.map((m) => m.occurred_on).sort();
    throw new Error(
      `${sinCotizacion.length} movimientos en dólares sin cotización del blue ` +
      `(desde ${f[0]}): ampliar el rango de scripts/sync-cotizaciones.ts.`
    );
  }
  const { arsDe: arsDeCaja, notaCambio } = pesificador(tc);

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

  // ---------- lo que se puso a mano en una línea (0030) ----------
  // Va acá, al lado de las imputaciones, porque es lo mismo: una decisión de
  // Pancho que el motor tiene que respetar en CADA corrida. Si viviera fuera de
  // calcularTodo(), el próximo recálculo —el botón, guardar un pacto o tocar la
  // lista de precios— la pisaría sin que nadie se entere.
  const { data: ovRaw, error: eOv } = await db.from("settlement_line_overrides")
    .select("movement_id, collected_ars, ks_cost_ars, reason, snapshot")
    .eq("company_id", companyId).eq("status", "active");
  // Se frena, no se sigue con la lista vacía: si esta lectura falla, el recálculo
  // reescribiría settlement_items y totals con los valores CALCULADOS y se
  // llevaría puestos todos los números puestos a mano, sin un mensaje y sin una
  // fila de diagnóstico — y el panel los seguiría mostrando desde su propia
  // tabla. Un recálculo que no puede leer las correcciones no es un recálculo.
  if (eOv) throw new Error(`leer los números puestos a mano: ${eOv.message}`);
  const overrides = new Map<string, OverrideLinea>();
  const overridesHuerfanos: OverrideHuerfano[] = [];
  for (const o of ovRaw ?? []) {
    const linea: OverrideLinea = {
      cobradoArs: o.collected_ars == null ? null : Number(o.collected_ars),
      costoKsArs: o.ks_cost_ars == null ? null : Number(o.ks_cost_ars),
      motivo: (o.reason as string) ?? "",
    };
    // Mismo caso que las imputaciones huérfanas, pero más caro: acá lo que se
    // pierde es un NÚMERO. Si desapareciera en silencio, la liquidación
    // volvería sola al valor calculado sobre un cobro que alguien corrigió
    // justamente porque estaba mal. Se reporta uno por uno (guardarDiagnostico).
    if (!vivos.has(o.movement_id as string)) {
      overridesHuerfanos.push({
        ...linea, movementId: o.movement_id as string,
        snapshot: (o.snapshot ?? {}) as OverrideHuerfano["snapshot"],
      });
      continue;
    }
    overrides.set(o.movement_id as string, linea);
  }

  /** Lo cobrado de una línea: el número puesto a mano, o el de la caja pesificado. */
  const arsDe = (m: MovimientoBase): number =>
    overrides.get(m.id)?.cobradoArs ?? arsDeCaja(m);

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

  // Los pactos de cada paciente (precio, plan, descuento, etapa adicional) salen
  // de treatment_plans, no de un archivo del repo: así se editan desde la página
  // y cada cambio queda en el audit de la tabla. Si la tabla está vacía el
  // costeo no puede poner precio a nada, así que se frena en vez de liquidar
  // todo al 40% del bruto.
  const pactos = await cargarPactos(db, companyId);
  if (!pactos.planes) {
    throw new Error(
      "no hay ningún plan de tratamiento cargado (treatment_plans): sin pactos, " +
      "ningún cobro se puede costear. Correr scripts/migrar-pactos.ts --apply."
    );
  }

  // El costo puesto a mano entra ADENTRO del costeo, no después: el tope por
  // caso vive en un acumulador local de costearCuotas(). Pisar el resultado
  // desde afuera dejaría a las cuotas siguientes del mismo paciente imputando
  // su share automático, y el caso cargaría su costo DOS veces.
  const costoManualArs = new Map<string, { monto: number; motivo: string }>();
  for (const [id, o] of overrides) {
    if (o.costoKsArs != null) costoManualArs.set(id, { monto: o.costoKsArs, motivo: o.motivo });
  }

  const { costoArs, etiquetas, sinCostear } = costearCuotas(cobrosAlineadores, {
    precioDefault: {
      list_price: Number(precio.list_price), discount_pct: Number(precio.discount_pct),
    },
    listas, tipoPorPaciente, ingresoPorPaciente,
    planPorPaciente: pactos.planPorPaciente,
    precioPactado: pactos.precioPactado,
    precioPactadoUsd: pactos.precioPactadoUsd,
    etapaAdicional: pactos.etapaAdicional,
    costoEtapaAdicional: pactos.costoEtapaAdicional,
    descuentoKsEspecial: pactos.descuentoKsEspecial,
    tcPorFecha: tc,
    costoManualArs,
  });

  // Un costo a mano sobre un cobro que NO es de alineadores (una consulta, una
  // placa) no pasa por costearCuotas —que sólo recibe los de alineadores— así
  // que se aplica acá. No hay tope que consumir: el tope es del caso de
  // alineadores, y esto no lo es.
  const idsAlineadores = new Set(cobrosAlineadores.map((c) => c.id));
  for (const [id, m] of costoManualArs) {
    if (idsAlineadores.has(id)) continue;
    costoArs.set(id, Math.round(m.monto));
    etiquetas.set(
      id,
      `costo KS $${Math.round(m.monto).toLocaleString("es-AR")} puesto a mano` +
      (m.motivo ? ` — ${m.motivo}` : "")
    );
  }

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
      ars: arsDe(m),
      tipo:
        m.meta?.tipo_origen === "retiro_liquidacion" ? "retiro_liquidacion"
        : m.meta?.tipo_origen === "gasto_tratamiento" ? "gasto_tratamiento"
        : m.kind === "income" ? "cobro"
        : "otro",
    }));

  const calculadas = calcularLiquidaciones(
    paraLiquidar, costoArs, (d) => pctPorDoctora.get(d) ?? 40
  ).filter((l) => !aparte.has(l.doctora));

  return {
    calculadas, movs, doctoraFinal, periodoFinal, costoArs, arsDe, notaCambio,
    overrides, overridesHuerfanos,
    etiquetas, pctPorDoctora, idPorDoctora, nombrePorId, sinCostear, huerfanas,
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
  // costoArs / notaCambio / etiquetas no se desestructuran: los usa filaDeItem()
  // directamente desde `calc`, que es el único lugar donde se arma una línea.
  const {
    calculadas, movs, doctoraFinal, periodoFinal, arsDe,
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
    periodos, guardadas: 0, items: 0, congeladas: [], anuladas: [], trabados: [],
    sinCostear, huerfanas,
  };

  // Qué cobros ya están liquidados en una liquidación CONGELADA. Sus ítems son
  // el respaldo de plata que ya se confirmó o se pagó: no se tocan ni para
  // borrarlos ni para rehacerlos.
  //
  // Hasta el 26/8/26 el borrado de abajo iba por movimiento y sin este filtro,
  // así que cada recálculo le comía el detalle a las liquidaciones congeladas
  // del período: el total sobrevivía y las líneas desaparecían. Virginia julio
  // quedó con cero líneas de esa forma.
  const idsCongeladas = existentes.filter((e) => estaCongelada(e.status)).map((e) => e.id);
  const enCongelada = new Map<string, string>();   // movement_id → doctora|período
  for (let i = 0; i < idsCongeladas.length; i += 100) {
    const { data, error } = await db.from("settlement_items")
      .select("movement_id, settlement_id")
      .in("settlement_id", idsCongeladas.slice(i, i + 100)).limit(2000);
    if (error) throw new Error(`leer ítems congelados: ${error.message}`);
    for (const it of data ?? []) {
      const s = existentes.find((e) => e.id === it.settlement_id);
      enCongelada.set(it.movement_id as string, s ? `${s.periodo} ${s.doctora}` : "una liquidación cerrada");
    }
  }

  // Los ítems de movimientos ANULADOS. `movs` excluye los void, así que un cobro
  // que la caja anuló (o que se anuló a mano desde Movimientos) deja su ítem
  // colgado para siempre: los totales se recalculan sin él y el detalle lo
  // sigue mostrando. Con el subtotal nuevo de la pantalla eso se ve como un
  // descuadre; acá se arregla. Los de una liquidación cerrada no se tocan: ese
  // detalle es el respaldo de plata que ya se pagó.
  const { data: anulados } = await db.from("movements")
    .select("id").eq("company_id", companyId).eq("status", "void");
  const idsAnulados = (anulados ?? []).map((m) => m.id as string)
    .filter((id) => !enCongelada.has(id));
  for (let i = 0; i < idsAnulados.length; i += 200) {
    const { error } = await db.from("settlement_items").delete()
      .eq("company_id", companyId).in("movement_id", idsAnulados.slice(i, i + 200));
    if (error) throw new Error(`limpiar ítems de movimientos anulados: ${error.message}`);
  }

  for (const periodo of periodos) {
    // Los ítems se rehacen enteros: se limpian por MOVIMIENTO del período (no
    // por liquidación) porque un cobro pudo cambiar de doctora, y su ítem viejo
    // cuelga de otra liquidación. El unique(company_id, movement_id) rechazaría
    // el insert nuevo con un mensaje que no dice nada de esto.
    const movsDelPeriodo = movs.filter((m) => periodoFinal.get(m.id) === periodo);
    const limpiables = movsDelPeriodo.filter((m) => !enCongelada.has(m.id));
    if (limpiables.length) {
      for (let i = 0; i < limpiables.length; i += 200) {
        const { error } = await db.from("settlement_items").delete()
          .eq("company_id", companyId)
          .in("movement_id", limpiables.slice(i, i + 200).map((m) => m.id));
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
        // Sin bucket USD: lo cobrado en dólares ya viene pesificado al blue de
        // su fecha. Las liquidaciones viejas que se pagaron con un USD aparte
        // están congeladas y conservan el suyo.
        totals: {
          ARS: {
            collected: l.cobradoArs, ks_cost: l.gastosTratamiento, base: l.baseArs,
            due: l.liquidacionArs, withdrawn: l.retiros, balance: l.saldo,
          },
        },
      }, { onConflict: "company_id,professional_id,period" }).select("id").single();
      if (error) throw new Error(`liquidación ${l.periodo}/${l.doctora}: ${error.message}`);
      resumen.guardadas++;

      const cobrosDelMes = movsDelPeriodo.filter(
        (m) => m.kind === "income" && doctoraFinal.get(m.id) === l.doctora
      );
      // Un cobro que ya está liquidado en una congelada no se puede mover acá:
      // el unique(company_id, movement_id) dice que un cobro se liquida UNA vez.
      // Antes esto no pasaba nunca porque el borrado de arriba se lo llevaba
      // puesto — es decir, el cobro se mudaba en silencio y la liquidación
      // cerrada perdía la línea. Ahora se respeta la cerrada y se avisa.
      const trabados = cobrosDelMes.filter((m) => enCongelada.has(m.id));
      for (const m of trabados) {
        const quien = m.counterparties?.display_name ?? "un cobro";
        resumen.trabados.push(
          `${l.periodo} ${l.doctora}: ${quien} ($${Math.round(arsDe(m)).toLocaleString("es-AR")}) ` +
          `sigue liquidado en ${enCongelada.get(m.id)} — para moverlo hay que reabrir esa liquidación`
        );
      }
      const aInsertar = cobrosDelMes.filter((m) => !enCongelada.has(m.id));
      if (aInsertar.length) {
        const filas = aInsertar.map((m) => filaDeItem(calc, companyId, set!.id, m));
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

  await guardarDiagnostico(db, companyId, calc, resumen);

  return resumen;
}

/**
 * Deja escrito lo que este cálculo encontró mal, para que el panel lo muestre
 * sin recalcular (el cálculo completo tarda ~3 segundos).
 *
 * Es un ESPEJO del último recálculo, no historia: se borra entero y se
 * reescribe. Si un problema se arregla, desaparece solo en la corrida
 * siguiente — que es exactamente lo que uno quiere de una lista de pendientes.
 *
 * Se escribe SIEMPRE con el cálculo completo del año, aunque se hayan guardado
 * sólo unos períodos: un cobro sin costear de marzo no deja de existir porque
 * hoy se recalculó julio.
 */
async function guardarDiagnostico(
  db: SupabaseClient, companyId: string, calc: Calculo, resumen: ResumenRecalculo
): Promise<void> {
  type Fila = {
    company_id: string; kind: string; movement_id: string | null;
    period: string | null; professional: string | null;
    amount: number | null; currency: string | null; detail: string;
  };
  const filas: Fila[] = [];

  for (const [id, etiqueta] of calc.etiquetas) {
    if (!etiqueta.startsWith("SIN COSTEAR")) continue;
    const m = calc.movs.find((x) => x.id === id);
    if (!m) continue;
    filas.push({
      company_id: companyId, kind: "sin_costear", movement_id: id,
      period: calc.periodoFinal.get(id) ?? null,
      professional: calc.doctoraFinal.get(id) ?? null,
      amount: Math.round(calc.arsDe(m) * 100) / 100, currency: "ARS",
      detail: `${m.counterparties?.display_name ?? "sin paciente"}: ${etiqueta.replace("SIN COSTEAR: ", "")}`,
    });
  }
  for (const t of resumen.trabados) {
    filas.push({
      company_id: companyId, kind: "cobro_trabado", movement_id: null,
      period: t.slice(0, 7), professional: null, amount: null, currency: null, detail: t,
    });
  }
  // Un número puesto a mano que dejó de aplicarse merece nombre y apellido: si
  // se contara agregado como las imputaciones, nadie podría ir a arreglarlo.
  for (const h of calc.overridesHuerfanos) {
    const que = h.costoKsArs != null
      ? `el costo KS de $${Math.round(h.costoKsArs).toLocaleString("es-AR")}`
      : `el cobrado de $${Math.round(h.cobradoArs ?? 0).toLocaleString("es-AR")}`;
    filas.push({
      company_id: companyId, kind: "override_huerfano", movement_id: h.movementId,
      period: h.snapshot.periodo ?? null, professional: h.snapshot.doctora ?? null,
      amount: h.costoKsArs ?? h.cobradoArs ?? null, currency: "ARS",
      detail:
        `${h.snapshot.paciente ?? "Un cobro"}${h.snapshot.fecha ? ` (${h.snapshot.fecha})` : ""}: ` +
        `${que} que pusiste a mano quedó colgado — la caja editó esa fila, el ` +
        `movimiento se anuló y nació otro. Hay que volver a ponerlo en la fila nueva.`,
    });
  }
  if (resumen.huerfanas) {
    filas.push({
      company_id: companyId, kind: "imputacion_huerfana", movement_id: null,
      period: null, professional: null, amount: null, currency: null,
      detail: `${resumen.huerfanas} imputación(es) apuntan a movimientos que la caja anuló: ya no corrigen nada`,
    });
  }

  const { error: eDel } = await db.from("settlement_issues").delete().eq("company_id", companyId);
  if (eDel) throw new Error(`limpiar diagnóstico: ${eDel.message}`);
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await db.from("settlement_issues").insert(filas.slice(i, i + 500));
    if (error) throw new Error(`guardar diagnóstico: ${error.message}`);
  }
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

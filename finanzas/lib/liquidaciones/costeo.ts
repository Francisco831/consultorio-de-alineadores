// Costeo KS de las cuotas de alineadores y liquidación de las doctoras.
// Port FIEL de costear() y build_xlsx() de consultorio-gestion/build_liquidaciones.py
// (reglas de Pancho del 21/7/2026). Validado contra la salida de ese script.
//
// CAMBIOS DE CRITERIO (Pancho, 24/8/26) sobre el port original:
//  1. LISTA HISTÓRICA: el costo KS total de un caso es el de la lista vigente
//     cuando ENTRÓ el caso, no la actual. La fecha de ingreso real viene de
//     Noloco (tipos_tratamiento_ar.json); si falta, se infiere de la primera
//     cuota visible retrocediendo N−1 meses cuando declara "cuota N de Y".
//  2. COSTO PROPORCIONAL A LO COBRADO: cada cobro de alineadores descuenta
//     costo_total × (monto / precio_pactado) — "entró x plata, corresponde este
//     costo" — con tope acumulado en el costo total. No importa el número de
//     cuotas ni si un pago es parcial o doble: el porcentaje manda. El precio
//     pactado sale del override PRECIO_PACTADO o se infiere como plan × valor
//     de la PRIMERA cuota limpia (el pacto es el del ingreso; las cuotas
//     siguientes ya vienen ajustadas por inflación).
//
// Detalles que siguen importando:
//  - La identidad del paciente son sus tokens ORDENADOS de más de 2 letras: así
//    "Pérez Viviana", "perez viviana" y "Viviana Perez" son la misma persona.
//  - Un cobro en USD prorratea contra un pacto en USD y carga su costo en USD
//    (al t/c de la fila), no en pesos.
//  - El orden de las filas decide qué cuota define el pacto y dónde muerde el
//    tope; por eso los movimientos sembrados guardan su fila en meta.seq.

import { norm } from "../import/normalize";

export const RE_CUOTA = /c(?:uo)?ta\s*\.?\s*(\d+)\s*de\s*(\d+)/i;
export const RE_CUOTA_DOBLE = /c(?:uo)?tas?\s*(\d+)\s*y\s*(\d+)\s*de\s*(\d+)/i;
export const RE_TC = /t\/?c\s*\$?\s*([\d.,]+)/i;
// "parte de cuota 3", "a cta de cuota 2", "resto/saldo de cuota": el monto NO es
// una cuota entera — no sirve para inferir el valor de cuota del pacto
export const RE_PARCIAL = /\bparte\b|\bresto\b|\bsaldo\b|\bseña\b|\ba\s*c(?:uo|uen)?ta\.?\s*de\b/i;

export const TC_FALLBACK = 1500;

/** Identidad del paciente: tokens ordenados de más de 2 letras. */
export function clavePaciente(nombre: string): string {
  return norm(nombre)
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .sort()
    .join(" ");
}

export type PrecioKS = { list_price: number; discount_pct: number };

/** Lista de precios KS vigente desde una fecha: "audience/scope/arcades" → precio. */
export type ListaPrecios = { validFrom: string; precios: Map<string, PrecioKS> };

/** "la gran gran mayoría son Full bimaxilar" */
export const TIPO_DEFAULT = "adultos/full/2";

/** Resta n meses a una fecha ISO (estimación de ingreso desde "cuota N de Y"). */
function restarMeses(fecha: string, n: number): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const total = y * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-${String(Math.min(d, 28)).padStart(2, "0")}`;
}

export type CobroAlineador = {
  id: string;
  paciente: string;
  fecha: string;
  ars: number;
  usd: number;
  motivo: string;  // SOLO el motivo: distingue dos cuotas del mismo día e importe
  texto: string;   // motivo + obs (para leer "cuota X de Y")
  seq: number;     // orden original de la fila
};

export type ResultadoCosteo = {
  costoArs: Map<string, number>;
  costoUsd: Map<string, number>;
  etiquetas: Map<string, string>;
  sinCostear: number;
};

export function costearCuotas(
  cobros: CobroAlineador[],
  opts: {
    precioDefault: PrecioKS;
    listas?: ListaPrecios[];                   // historial de listas KS con vigencia
    tipoPorPaciente?: Map<string, string>;     // clave paciente → "audience/scope/arcades" (Noloco)
    ingresoPorPaciente?: Map<string, string>;  // clave paciente → fecha de ingreso del caso (Noloco)
    planPorPaciente?: Record<string, number>;
    precioPactado?: Record<string, number>;     // nombre → precio total pactado en ARS
    precioPactadoUsd?: Record<string, number>;  // nombre → precio total pactado en USD
    etapaAdicional?: Set<string>;
    // nombre → precio de su ETAPA ADICIONAL. Gana sobre la lista de precios y
    // sobre la regla de "etapa adicional sin costo": la etapa sólo es gratis
    // cuando el tratamiento era Full.
    costoEtapaAdicional?: Record<string, number>;
  }
): ResultadoCosteo {
  // Ingreso del caso por paciente: manda la fecha real de Noloco; si falta, se
  // infiere de la primera cuota visible (si declara "cuota N de Y", el caso
  // entró ~N−1 meses antes). Esto decide QUÉ lista de precios paga el caso.
  const ingresoInferido = new Map<string, string>();
  for (const c of [...cobros].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.seq - b.seq)) {
    const k = clavePaciente(c.paciente);
    if (ingresoInferido.has(k)) continue;
    const n = Number(RE_CUOTA_DOBLE.exec(c.texto)?.[1] ?? RE_CUOTA.exec(c.texto)?.[1] ?? 1);
    ingresoInferido.set(k, n > 1 ? restarMeses(c.fecha, n - 1) : c.fecha);
  }
  const listas = [...(opts.listas ?? [])].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  const costoFijado = new Map<string, number>();
  for (const [nombre, v] of Object.entries(opts.costoEtapaAdicional ?? {})) {
    costoFijado.set(clavePaciente(nombre), v);
  }
  /** Full incluye las etapas adicionales (programa 1 a 4). Medium y Fast no. */
  const esFull = (k: string) =>
    (opts.tipoPorPaciente?.get(k) ?? TIPO_DEFAULT).split("/")[1] === "full";

  // precio del caso: lista vigente a su ingreso + tipo real de tratamiento
  // (Noloco); sin datos cae al default Full 2 maxilares adultos a lista actual.
  // Un caso anterior a la lista más vieja conocida usa esa (no hay mejor dato).
  const costoDe = (k: string) => {
    const fijado = costoFijado.get(k);
    if (fijado != null) return fijado;
    let pr = opts.precioDefault;
    if (listas.length) {
      const fecha = opts.ingresoPorPaciente?.get(k) ?? ingresoInferido.get(k) ?? "";
      const lista = listas.filter((l) => l.validFrom <= fecha).pop() ?? listas[0];
      pr = lista.precios.get(opts.tipoPorPaciente?.get(k) ?? TIPO_DEFAULT) ?? pr;
    }
    return pr.list_price * (1 - pr.discount_pct / 100);
  };
  const costoArs = new Map<string, number>();
  const costoUsd = new Map<string, number>();
  const etiquetas = new Map<string, string>();
  let sinCostear = 0;

  // plan por paciente: el máximo "de Y" que alguna de sus filas declare
  // (solo se usa para armar el precio pactado: plan × valor de cuota)
  const plan = new Map<string, number>();
  for (const c of cobros) {
    const y = Number(RE_CUOTA_DOBLE.exec(c.texto)?.[3] ?? RE_CUOTA.exec(c.texto)?.[2] ?? 0);
    if (y > 0) {
      const k = clavePaciente(c.paciente);
      plan.set(k, Math.max(plan.get(k) ?? 0, y));
    }
  }
  for (const [nombre, n] of Object.entries(opts.planPorPaciente ?? {})) {
    plan.set(clavePaciente(nombre), n);
  }
  const pactado = new Map<string, number>();
  for (const [nombre, v] of Object.entries(opts.precioPactado ?? {})) {
    pactado.set(clavePaciente(nombre), v);
  }
  const pactadoUsd = new Map<string, number>();
  for (const [nombre, v] of Object.entries(opts.precioPactadoUsd ?? {})) {
    pactadoUsd.set(clavePaciente(nombre), v);
  }

  // Valor de UNA cuota por paciente y moneda: la primera fila LIMPIA que declara
  // "cuota X de Y" (ni parcial ni doble a medias — una doble vale monto/2). Se
  // toma la primera porque el precio pactado es el del INGRESO del caso: las
  // cuotas se ajustan por inflación y las siguientes ya no representan el pacto.
  const cuotaBase = new Map<string, number>();   // `${k}|${ARS|USD}` → valor cuota
  for (const c of [...cobros].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.seq - b.seq)) {
    const k = clavePaciente(c.paciente);
    const cur = c.ars > 0 ? "ARS" : "USD";
    const kk = `${k}|${cur}`;
    if (cuotaBase.has(kk) || RE_PARCIAL.test(c.texto)) continue;
    const monto = c.ars > 0 ? c.ars : c.usd;
    if (RE_CUOTA_DOBLE.test(c.texto)) cuotaBase.set(kk, monto / 2);
    else if (RE_CUOTA.test(c.texto)) cuotaBase.set(kk, monto);
  }

  // Costo proporcional a la plata cobrada (regla Pancho 24/8/26): cada cobro
  // descuenta costo_total × (monto / precio_pactado), con tope acumulado en el
  // costo total del caso — al pagar el 100% se descontó exactamente el 100%.
  const acumulado = new Map<string, number>();   // k → costo ya imputado (ARS)
  for (const c of [...cobros].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.seq - b.seq)) {
    const k = clavePaciente(c.paciente);
    const texto = c.texto;
    // La etapa adicional viene incluida en el programa 1 a 4 — pero eso vale
    // para los tratamientos FULL. En un Medium o un Fast la etapa se cobra
    // aparte y tiene su propio precio (Pancho, 25/8/26, sobre Daira Castellón).
    if (!costoFijado.has(k) &&
        (norm(texto).includes("etapa adicional") || opts.etapaAdicional?.has(k))) {
      if (esFull(k)) {
        etiquetas.set(c.id, "etapa adicional: sin costo (incluida en programa 1 a 4)");
      } else {
        // Callarse acá sería regalar el costo: se marca para que alguien lo cargue.
        etiquetas.set(c.id, "SIN COSTEAR: etapa adicional de un tratamiento no-Full, falta su precio");
        sinCostear++;
      }
      continue;
    }

    const cur = c.ars > 0 ? "ARS" : "USD";
    const monto = c.ars > 0 ? c.ars : c.usd;
    const tcm = RE_TC.exec(texto);
    let tc = tcm ? Number(tcm[1].replace(/\./g, "").replace(",", ".")) : TC_FALLBACK;
    if (!Number.isFinite(tc) || tc < 100) tc = TC_FALLBACK;

    // % del tratamiento que representa este cobro. El pacto declarado a mano
    // gana (en su moneda: Hogner paga en pesos un pacto en USD → se cruza al
    // t/c de la fila); si no hay pacto, plan × valor de cuota en la MISMA
    // moneda del cobro.
    const pArs = pactado.get(k), pUsd = pactadoUsd.get(k);
    const base = cuotaBase.get(`${k}|${cur}`);
    let pct: number | undefined;
    let precioTxt = "";
    if (cur === "ARS" && pArs) { pct = monto / pArs; precioTxt = `$${pArs.toLocaleString("es-AR")}`; }
    else if (cur === "USD" && pUsd) { pct = monto / pUsd; precioTxt = `USD ${pUsd.toLocaleString("es-AR")}`; }
    else if (cur === "ARS" && pUsd) { pct = monto / tc / pUsd; precioTxt = `USD ${pUsd.toLocaleString("es-AR")} (t/c ${tc})`; }
    else if (cur === "USD" && pArs) { pct = (monto * tc) / pArs; precioTxt = `$${pArs.toLocaleString("es-AR")} (t/c ${tc})`; }
    else if (plan.has(k) && base) {
      const precio = plan.get(k)! * base;
      pct = monto / precio;
      precioTxt = `${cur === "USD" ? "USD " : "$"}${precio.toLocaleString("es-AR")} inferido`;
    }
    if (pct == null || !Number.isFinite(pct) || pct <= 0) {
      etiquetas.set(c.id, "SIN COSTEAR: sin precio pactado ni plan × cuota inferible");
      sinCostear++;
      continue;
    }

    const costoTotal = costoDe(k);
    const ya = acumulado.get(k) ?? 0;
    const share = Math.min(costoTotal * pct, Math.max(0, costoTotal - ya));
    acumulado.set(k, ya + share);

    const tope = share + 0.5 < costoTotal * pct ? " — tope: el caso ya cargó su costo completo" : "";
    const aMano = costoFijado.has(k)
      ? ` · etapa adicional a $${costoTotal.toLocaleString("es-AR")}` : "";
    const pctTxt = `${(pct * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}% del precio ${precioTxt}`;
    if (cur === "ARS") {
      costoArs.set(c.id, Math.round(share));
      etiquetas.set(c.id, `costo KS $${Math.round(share).toLocaleString("es-AR")} (${pctTxt}${tope}${aMano})`);
    } else {
      costoUsd.set(c.id, Math.round(share / tc));
      etiquetas.set(c.id, `costo KS USD ${Math.round(share / tc)} (${pctTxt}, t/c ${tc}${tope}${aMano})`);
    }
  }

  return { costoArs, costoUsd, etiquetas, sinCostear };
}

export type LineaLiquidacion = {
  doctora: string;
  periodo: string;
  cobradoArs: number;
  cobradoUsd: number;
  gastosTratamiento: number;   // costo KS en ARS
  gastosUsd: number;
  baseArs: number;
  liquidacionArs: number;
  liquidacionUsd: number;
  retiros: number;
  saldo: number;
};

export type MovimientoLiq = {
  id: string;
  doctora: string | null;
  periodo: string;
  ars: number;
  usd: number;
  tipo: "cobro" | "retiro_liquidacion" | "gasto_tratamiento" | "otro";
};

export function calcularLiquidaciones(
  movimientos: MovimientoLiq[],
  costoArs: Map<string, number>,
  costoUsd: Map<string, number>,
  pctPorDoctora: (doctora: string) => number
): LineaLiquidacion[] {
  const acc = new Map<string, LineaLiquidacion>();
  for (const m of movimientos) {
    if (!m.doctora) continue;
    const k = `${m.doctora}|${m.periodo}`;
    if (!acc.has(k)) {
      acc.set(k, {
        doctora: m.doctora, periodo: m.periodo, cobradoArs: 0, cobradoUsd: 0,
        gastosTratamiento: 0, gastosUsd: 0, baseArs: 0,
        liquidacionArs: 0, liquidacionUsd: 0, retiros: 0, saldo: 0,
      });
    }
    const l = acc.get(k)!;
    if (m.tipo === "cobro") {
      l.cobradoArs += m.ars;
      l.cobradoUsd += m.usd;
      l.gastosTratamiento += costoArs.get(m.id) ?? 0;
      l.gastosUsd += costoUsd.get(m.id) ?? 0;
    } else if (m.tipo === "retiro_liquidacion") {
      l.retiros += m.ars;
    } else if (m.tipo === "gasto_tratamiento") {
      l.gastosTratamiento += m.ars;
      l.gastosUsd += m.usd;
    }
  }
  for (const l of acc.values()) {
    const pct = pctPorDoctora(l.doctora) / 100;
    l.baseArs = Math.round((l.cobradoArs - l.gastosTratamiento) * 100) / 100;
    l.liquidacionArs = Math.round(l.baseArs * pct);
    l.liquidacionUsd = Math.round((l.cobradoUsd - l.gastosUsd) * pct);
    l.saldo = Math.round(l.liquidacionArs - l.retiros);
  }
  return [...acc.values()].sort(
    (a, b) => a.periodo.localeCompare(b.periodo) || a.doctora.localeCompare(b.doctora)
  );
}

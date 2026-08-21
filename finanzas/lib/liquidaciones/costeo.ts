// Costeo KS de las cuotas de alineadores y liquidación de las doctoras.
// Port FIEL de costear() y build_xlsx() de consultorio-gestion/build_liquidaciones.py
// (reglas de Pancho del 21/7/2026). Validado contra la salida de ese script.
//
// Detalles que parecen menores y NO lo son (cada uno costaba una cuota de $273.100
// de diferencia contra el script viejo):
//  - La identidad del paciente son sus tokens ORDENADOS de más de 2 letras: así
//    "Pérez Viviana", "perez viviana" y "Viviana Perez" son la misma persona.
//  - Si la fila no dice "cuota X de Y" pero el paciente tiene plan conocido, la
//    fila SÍ se costea (plan inferido), con clave propia por fecha+monto+motivo.
//  - "cuotas 3 y 4 de 4" paga DOS cuotas: cobra doble y su clave es distinta de
//    la de "cuota 3 de 4" suelta.
//  - Un cobro en USD carga su costo en USD (al t/c de la fila), no en pesos.
//  - El resultado depende del ORDEN de las filas (la primera que menciona una
//    cuota se la lleva). Se respeta el orden original del registro; por eso los
//    movimientos sembrados guardan su número de fila en meta.seq.

import { norm } from "../import/normalize";

export const RE_CUOTA = /c(?:uo)?ta\s*\.?\s*(\d+)\s*de\s*(\d+)/i;
export const RE_CUOTA_DOBLE = /c(?:uo)?tas?\s*(\d+)\s*y\s*(\d+)\s*de\s*(\d+)/i;
export const RE_TC = /t\/?c\s*\$?\s*([\d.,]+)/i;

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
    precioPorPaciente?: Map<string, PrecioKS>;
    planPorPaciente?: Record<string, number>;
    etapaAdicional?: Set<string>;
  }
): ResultadoCosteo {
  // precio por paciente (tipo real de tratamiento desde Noloco); sin entrada,
  // cae al default Full 2 maxilares adultos
  const costoDe = (k: string) => {
    const pr = opts.precioPorPaciente?.get(k) ?? opts.precioDefault;
    return pr.list_price * (1 - pr.discount_pct / 100);
  };
  const costoArs = new Map<string, number>();
  const costoUsd = new Map<string, number>();
  const etiquetas = new Map<string, string>();
  let sinCostear = 0;

  // plan por paciente: el máximo "de Y" que alguna de sus filas declare
  const plan = new Map<string, number>();
  for (const c of cobros) {
    const m = RE_CUOTA.exec(c.texto);
    if (m && Number(m[2]) > 0) {
      const k = clavePaciente(c.paciente);
      plan.set(k, Math.max(plan.get(k) ?? 0, Number(m[2])));
    }
  }
  const planExplicito = new Map<string, number>();
  for (const [nombre, n] of Object.entries(opts.planPorPaciente ?? {})) {
    planExplicito.set(clavePaciente(nombre), n);
  }

  const yaCosteadas = new Set<string>();

  for (const c of [...cobros].sort((a, b) => a.seq - b.seq)) {
    const k = clavePaciente(c.paciente);
    const texto = c.texto;
    if (norm(texto).includes("etapa adicional") || opts.etapaAdicional?.has(k)) {
      etiquetas.set(c.id, "etapa adicional: sin costo (incluida en programa 1 a 4)");
      continue;
    }

    const md = RE_CUOTA_DOBLE.exec(texto);
    const m = RE_CUOTA.exec(texto);
    let totalCuotas: number;
    let cuotaId: string;
    let nShares = 1;
    let inferido = false;

    if (md && Number(md[3]) > 0) {
      totalCuotas = Number(md[3]);
      nShares = 2;
      cuotaId = `${k}|${md[1]}|${md[2]}`;
    } else if (m && Number(m[2]) > 0) {
      totalCuotas = planExplicito.get(k) ?? Number(m[2]);
      cuotaId = `${k}|${m[1]}`;
    } else if (plan.has(k)) {
      totalCuotas = plan.get(k)!;
      inferido = true;
      // el motivo COMPLETO es parte de la clave: "pago cuota mayo" y "pago cuota
      // junio" del mismo día y monto son DOS cuotas, no una repetida
      cuotaId = `${k}|${c.fecha}|${Math.round(c.ars + c.usd)}|${norm(c.motivo)}`;
    } else {
      etiquetas.set(c.id, 'SIN COSTEAR: no se pudo leer "cuota X de Y" ni inferir el plan');
      sinCostear++;
      continue;
    }

    if (yaCosteadas.has(cuotaId)) {
      etiquetas.set(c.id, "cuota ya costeada en otro pago parcial");
      continue;
    }
    yaCosteadas.add(cuotaId);

    const share = (costoDe(k) / totalCuotas) * nShares;
    if (c.ars > 0) {
      costoArs.set(c.id, Math.round(share));
      etiquetas.set(c.id, `costo KS $${Math.round(share).toLocaleString("es-AR")} (${nShares}/${totalCuotas}${inferido ? " — plan inferido" : ""})`);
    } else if (c.usd > 0) {
      const tcm = RE_TC.exec(texto);
      let tc = tcm ? Number(tcm[1].replace(/\./g, "").replace(",", ".")) : TC_FALLBACK;
      if (!Number.isFinite(tc) || tc < 100) tc = TC_FALLBACK;
      costoUsd.set(c.id, Math.round(share / tc));
      etiquetas.set(c.id, `costo KS USD ${Math.round(share / tc)} (${nShares}/${totalCuotas}, t/c ${tc})`);
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

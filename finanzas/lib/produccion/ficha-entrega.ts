// Consolida la ficha de entrega de KS México en alineadores por mes.
//
// Realidad del archivo (crm-mx/data/ficha_entrega.xlsx), verificada el 20/8/2026:
//
//   · Hay hojas por AÑO (2023..2026) y hojas por TRANSPORTISTA (SkyDropx,
//     Lalamove, DHL). NO son universos distintos: 333 de los 343 envíos de las
//     hojas de transportista ya están en la hoja del año. Sumarlas duplicaba el
//     volumen (9.000 alineadores en vez de 5.000). Por eso todo se deduplica.
//
//   · La columna "Bis / Contención" NO dice qué tipo de envío es: marca QUÉ MÁS
//     iba en la caja. Un envío con 18 alineadores y "Contencion" es la etapa
//     final del tratamiento más la placa de contención, no una contención sola.
//
//   · Un envío sin número de alineadores es un envío que no llevó ninguno:
//     contención sola, attachments o kit de inicio. En la planilla figura "-",
//     que es un cero explícito, no un dato faltante.
//
//   · Los envíos de 1 o 2 placas sin nada más marcado son repeticiones sueltas.
//     Cuentan como producción: se termoformaron igual.
//
//   · Las hojas de transportista mezclan renglones que NO son envíos: "Recarga"
//     de saldo de SkyDropx y "Cargos Extra envio". No tienen caso ni paciente.
//     Contarlos inflaba 66 envíos fantasma en 2026.
//
// La fecha es la de ENVÍO. Es lo más cerca de "producido" que existe: no hay
// registro de fabricación diaria en México.

export type EnvioFicha = {
  hoja: string;
  fila: number;
  fecha: string | null;
  etapa?: string | number | null;
  id?: string | number | null;
  paciente?: string | null;
  alineadores?: string | number | null;
  attachments?: string | number | null;
  bisContencion?: string | number | null;
  kitInicio?: string | number | null;
};

export type MesProduccion = {
  period: string;              // 'YYYY-MM'
  alineadores: number;
  envios: number;
  enviosConAlineadores: number;
  /** casos distintos que recibieron algo ese mes (un caso puede enviar 2 etapas) */
  casos: number;
  /** envíos que no llevaron ninguna placa, por lo que llevaban en su lugar */
  sinAlineadores: { contencion: number; attachments: number; kit: number; otro: number };
  /** envíos de 1 o 2 placas: repeticiones sueltas, ya sumadas en `alineadores` */
  repeticiones: number;
};

export type Consolidado = {
  meses: MesProduccion[];
  /** envíos que quedaron fuera y por qué (auditoría, no descarte silencioso) */
  descartados: Array<{ hoja: string; fila: number; motivo: string }>;
  /** cuántos envíos aportó cada hoja después de deduplicar */
  aporte: Record<string, number>;
};

function aNumero(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/,/g, ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Un renglón es un envío si identifica a alguien. Sin caso ni paciente es
 *  movimiento de la cuenta del transportista (recarga, cargo extra), no una caja. */
export function esEnvio(e: EnvioFicha): boolean {
  const id = texto(e.id);
  const pac = texto(e.paciente);
  if ((!id || id === "-") && (!pac || pac === "-")) return false;
  return !/^(recarga|cargos?\s+extra)/i.test(texto(e.etapa));
}

function texto(v: unknown): string {
  return v == null ? "" : String(v).trim().toLowerCase();
}

/** Clave de identidad del envío: un caso avanza una vez por etapa.
 *  Sin ID (filas viejas incompletas) cae a paciente + etapa + fecha. */
export function claveEnvio(e: EnvioFicha): string {
  const id = texto(e.id);
  const etapa = texto(e.etapa);
  if (id && id !== "-") return `${id}|${etapa}`;
  return `p:${texto(e.paciente).slice(0, 24)}|${etapa}|${e.fecha ?? ""}`;
}

export function consolidarEnvios(
  envios: EnvioFicha[],
  opts: { desde?: string; hasta?: string } = {}
): Consolidado {
  const descartados: Consolidado["descartados"] = [];
  const aporte: Record<string, number> = {};
  const unicos = new Map<string, EnvioFicha & { fecha: string; alin: number }>();

  for (const e of envios) {
    if (!e.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(e.fecha)) {
      descartados.push({ hoja: e.hoja, fila: e.fila, motivo: "sin fecha legible" });
      continue;
    }
    const periodo = e.fecha.slice(0, 7);
    if (opts.desde && periodo < opts.desde) continue;
    if (opts.hasta && periodo > opts.hasta) continue;
    if (!esEnvio(e)) continue;   // recarga de saldo / cargo extra del transportista

    const bruto = e.alineadores;
    let alin = aNumero(bruto);
    if (alin == null && bruto != null && texto(bruto) !== "-") {
      // valor presente pero ilegible: se cuenta como cero y se deja anotado
      descartados.push({
        hoja: e.hoja, fila: e.fila,
        motivo: `alineadores ilegible: ${JSON.stringify(bruto)}`,
      });
    }
    if (alin == null) alin = 0;

    const k = claveEnvio(e);
    const previo = unicos.get(k);
    if (!previo) {
      unicos.set(k, { ...e, fecha: e.fecha, alin });
      aporte[e.hoja] = (aporte[e.hoja] ?? 0) + 1;
      continue;
    }
    // duplicado entre hojas: gana la fecha más temprana y el dato que existe
    // (las hojas por transportista muchas veces vienen sin el número)
    if (e.fecha < previo.fecha) previo.fecha = e.fecha;
    if (alin > previo.alin) {
      previo.alin = alin;
      previo.bisContencion = e.bisContencion ?? previo.bisContencion;
    }
  }

  const porMes = new Map<string, MesProduccion>();
  const casosPorMes = new Map<string, Set<string>>();
  for (const e of unicos.values()) {
    const period = e.fecha.slice(0, 7);
    let m = porMes.get(period);
    if (!m) {
      m = {
        period, alineadores: 0, envios: 0, enviosConAlineadores: 0, casos: 0,
        sinAlineadores: { contencion: 0, attachments: 0, kit: 0, otro: 0 },
        repeticiones: 0,
      };
      porMes.set(period, m);
    }
    m.envios += 1;
    m.alineadores += e.alin;
    const caso = texto(e.id) || `p:${texto(e.paciente).slice(0, 24)}`;
    if (caso && caso !== "-") {
      let set = casosPorMes.get(period);
      if (!set) { set = new Set(); casosPorMes.set(period, set); }
      set.add(caso);
    }
    if (e.alin > 0) {
      m.enviosConAlineadores += 1;
      const marca = texto(e.bisContencion);
      if (e.alin <= 2 && (marca === "" || marca === "-")) m.repeticiones += 1;
    } else {
      const marca = texto(e.bisContencion);
      if (marca.includes("conten")) m.sinAlineadores.contencion += 1;
      else if ((aNumero(e.attachments) ?? 0) > 0) m.sinAlineadores.attachments += 1;
      else if (texto(e.kitInicio).startsWith("si")) m.sinAlineadores.kit += 1;
      else m.sinAlineadores.otro += 1;
    }
  }

  for (const [period, set] of casosPorMes) {
    const m = porMes.get(period);
    if (m) m.casos = set.size;
  }

  return {
    meses: [...porMes.values()].sort((a, b) => a.period.localeCompare(b.period)),
    descartados,
    aporte,
  };
}

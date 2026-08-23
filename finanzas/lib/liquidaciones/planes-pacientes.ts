// Estado de pago de los planes de alineadores del consultorio, derivado de la
// caja: qué cuotas pagó cada paciente ("cuota X de Y") y cuánto le falta.
// El pendiente es un ESTIMADO: cuotas pendientes × última cuota conocida
// (las cuotas se ajustan por inflación, así que es piso, no contrato).
import { RE_CUOTA, RE_CUOTA_DOBLE, clavePaciente } from "./costeo";
import { tokEq } from "../conciliacion/matcher";

// apodos que la caja usa indistintamente con el nombre real
const APODOS: Record<string, string> = { magui: "magdalena" };

const claveConApodos = (nombre: string) =>
  clavePaciente(nombre).split(" ").map((t) => APODOS[t] ?? t).sort().join(" ");

// "cuota 3" a secas (sin "de Y"): cuenta como cuota numerada del plan ya conocido
const RE_CUOTA_SUELTA = /c(?:uo)?ta\s*\.?\s*(\d+)\b(?!\s*de)/i;

// "parte de cuota 3", "a cta de cuota 2", "resto/saldo de cuota": el monto NO
// es una cuota entera — no puede pisar la última cuota conocida (bug real:
// la fila de USD 300 de Etchegoyen "cuota 2 + a cta de cuota 3" desinflaba
// el pendiente). Como mucho la sube, si es lo único que hay.
const RE_PARCIAL = /\bparte\b|\bresto\b|\bsaldo\b|\bse\u00f1a\b|\ba\s*c(?:uo|uen)?ta\.?\s*de\b/i;

// "tc 1550" / "t/c $1.550": cuota en dólares con el tipo de cambio anotado
const RE_TC = /\bt\/?c\s*\$?\s*[\d.,]+/i;

// La caja corre columnas: el texto de la cuota puede estar en motivo, en obs
// o hasta en la columna del medio de pago. TODO lo que arme el motivo de un
// plan (pantalla, script, análisis) debe pasar por acá — nunca concatenar a mano.
export const motivoCompleto = (
  description: string | null | undefined,
  meta: { obs?: string | null; medio_raw?: string | null } | null | undefined,
) => `${description ?? ""} ${meta?.obs ?? ""} ${meta?.medio_raw ?? ""}`;

// ¿El texto de una fila parece una cuota de plan? Lo usa el control diario del
// import: una cuota que el clasificador dejó fuera de Alineadores es invisible
// para "Por cobrar" y fabrica falsos morosos (caso Etchegoyen, ago/26).
export const pareceCuota = (texto: string) =>
  RE_CUOTA_DOBLE.test(texto) || RE_CUOTA.test(texto) ||
  RE_CUOTA_SUELTA.test(texto) || RE_TC.test(texto);

export type PagoPlan = {
  paciente: string; fecha: string; ars: number; usd: number;
  motivo: string; doctora: string | null;
};

export type EstadoPlan = "completo" | "al_dia" | "atrasado" | "moroso";

export type PlanPaciente = {
  paciente: string; doctora: string | null;
  plan: number;                 // Y de "cuota X de Y"
  cuotasPagadas: number;
  pagadoArs: number; pagadoUsd: number;
  ultimaCuotaArs: number;       // monto de la última cuota numerada
  ultimaCuotaUsd: number;       // ídem si el plan se paga en dólares
  ultimoPago: string;
  pendienteCuotas: number;
  pendienteEstimadoArs: number;
  pendienteEstimadoUsd: number;
  diasSinPagar: number;
  estado: EstadoPlan;
  progresoPct: number;          // % del plan por PLATA pagada, no por cuotas
};

// Las cuotas son mensuales: hasta 45 días desde el último pago es ritmo
// normal; 46-75 es un mes salteado; más de 75, dos o más — moroso.
export function estadoPlan(pendienteCuotas: number, diasSinPagar: number): EstadoPlan {
  if (pendienteCuotas <= 0) return "completo";
  if (diasSinPagar <= 45) return "al_dia";
  if (diasSinPagar <= 75) return "atrasado";
  return "moroso";
}

export function planesPacientes(pagos: PagoPlan[], hoy?: string): PlanPaciente[] {
  type Acum = {
    paciente: string; doctora: string | null; plan: number;
    cuotas: Set<number>; pagadoArs: number; pagadoUsd: number;
    ultimaCuotaArs: number; ultimaCuotaUsd: number; ultimaCuotaFecha: string; ultimoPago: string;
  };
  const por = new Map<string, Acum>();
  for (const p of [...pagos].sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    const k = claveConApodos(p.paciente);
    if (!k) continue;
    const a = por.get(k) ?? {
      paciente: p.paciente, doctora: p.doctora, plan: 0,
      cuotas: new Set<number>(), pagadoArs: 0, pagadoUsd: 0,
      ultimaCuotaArs: 0, ultimaCuotaUsd: 0, ultimaCuotaFecha: "", ultimoPago: p.fecha,
    };
    a.pagadoArs += p.ars; a.pagadoUsd += p.usd;
    if (p.fecha > a.ultimoPago) a.ultimoPago = p.fecha;
    if (p.doctora) a.doctora = p.doctora;
    // Una fila entera pisa la última cuota (y fija la moneda del plan); una
    // PARCIAL solo puede subirla en la moneda ya vigente — nunca desinflar el
    // pendiente ni cambiar el plan de moneda por una seña chica.
    const parcial = RE_PARCIAL.test(p.motivo);
    const anotaCuota = (divisor: number) => {
      if (p.fecha < a.ultimaCuotaFecha) return;
      if (parcial) {
        if (p.ars > 0 && p.ars > a.ultimaCuotaArs && a.ultimaCuotaUsd === 0) a.ultimaCuotaArs = p.ars;
        else if (p.usd > 0 && p.usd > a.ultimaCuotaUsd && a.ultimaCuotaArs === 0) a.ultimaCuotaUsd = p.usd;
        return;
      }
      if (p.ars > 0) { a.ultimaCuotaArs = p.ars / divisor; a.ultimaCuotaUsd = 0; a.ultimaCuotaFecha = p.fecha; }
      else if (p.usd > 0) { a.ultimaCuotaUsd = p.usd / divisor; a.ultimaCuotaArs = 0; a.ultimaCuotaFecha = p.fecha; }
    };
    // Tope sanitario: un typo tipo "cuota 3 de 600.000" no es un plan de 600
    // cuotas (inflaría el pendiente en cientos de millones).
    const planValido = (y: number) => y >= 1 && y <= 36;
    const doble = RE_CUOTA_DOBLE.exec(p.motivo);
    const simple = RE_CUOTA.exec(p.motivo);
    if (doble) {
      if (planValido(Number(doble[3]))) a.plan = Math.max(a.plan, Number(doble[3]));
      a.cuotas.add(Number(doble[1])); a.cuotas.add(Number(doble[2]));
      anotaCuota(2);
    } else if (simple) {
      if (planValido(Number(simple[2]))) a.plan = Math.max(a.plan, Number(simple[2]));
      a.cuotas.add(Number(simple[1]));
      anotaCuota(1);
    } else {
      const suelta = RE_CUOTA_SUELTA.exec(p.motivo);
      if (suelta) {
        a.cuotas.add(Number(suelta[1]));
        anotaCuota(1);
      }
    }
    por.set(k, a);
  }
  // La caja escribe al mismo paciente con y sin segundo nombre ("Colimodio
  // Maria" / "Maria José Colimodio"): si los tokens de una clave son
  // subconjunto de EXACTAMENTE otra, es la misma persona — se fusionan.
  for (const [k, a] of [...por.entries()].sort((x, y) => x[0].length - y[0].length)) {
    const tk = k.split(" ");
    if (tk.length < 2) continue;
    // tokEq tolera typos ("romino"→"romina", "nissenbaum"→"nisenbaum")
    const supers = [...por.keys()].filter(
      (otro) => otro !== k && tk.every((t) => otro.split(" ").some((o) => tokEq(t, o)))
    );
    if (supers.length !== 1) continue;
    const b = por.get(supers[0])!;
    for (const c of a.cuotas) b.cuotas.add(c);
    b.plan = Math.max(b.plan, a.plan);
    b.pagadoArs += a.pagadoArs; b.pagadoUsd += a.pagadoUsd;
    if (a.ultimoPago > b.ultimoPago) b.ultimoPago = a.ultimoPago;
    if (a.ultimaCuotaFecha > b.ultimaCuotaFecha) {
      b.ultimaCuotaArs = a.ultimaCuotaArs; b.ultimaCuotaUsd = a.ultimaCuotaUsd; b.ultimaCuotaFecha = a.ultimaCuotaFecha;
    }
    por.delete(k);
  }
  return [...por.values()]
    .filter((a) => a.plan > 0)
    .map((a) => {
      // pagó la ÚLTIMA cuota del plan → terminado, aunque las primeras sean
      // anteriores al histórico (la caja arranca en ene/2026): no debe nada
      const terminado = a.cuotas.has(a.plan);
      const pendienteCuotas = terminado ? 0 : Math.max(0, a.plan - a.cuotas.size);
      const pendienteEstimadoArs = Math.round(pendienteCuotas * a.ultimaCuotaArs);
      const pendienteEstimadoUsd = Math.round(pendienteCuotas * a.ultimaCuotaUsd);
      // El progreso mide PLATA: una cuota inicial grande avanza la barra aunque
      // "vaya 1 de 6". Se usa la moneda de la última cuota (la del plan vigente);
      // lo pagado en la otra moneda no suma — subestima, nunca infla. Sin
      // estimado posible, cae a la proporción de cuotas.
      const pagRef = pendienteEstimadoUsd > 0 ? a.pagadoUsd : a.pagadoArs;
      const pendRef = pendienteEstimadoUsd > 0 ? pendienteEstimadoUsd : pendienteEstimadoArs;
      const progresoPct = Math.max(0, pagRef + pendRef > 0
        ? Math.min(100, Math.round((pagRef / (pagRef + pendRef)) * 100))
        : Math.min(100, Math.round((a.cuotas.size / a.plan) * 100)));
      const ref = hoy ?? [...pagos].reduce((m, p) => (p.fecha > m ? p.fecha : m), "");
      const diasSinPagar = Math.max(0, Math.round((+new Date(ref) - +new Date(a.ultimoPago)) / 86400000));
      return {
        paciente: a.paciente, doctora: a.doctora, plan: a.plan,
        cuotasPagadas: a.cuotas.size, pagadoArs: a.pagadoArs, pagadoUsd: a.pagadoUsd,
        ultimaCuotaArs: a.ultimaCuotaArs, ultimaCuotaUsd: a.ultimaCuotaUsd, ultimoPago: a.ultimoPago,
        pendienteCuotas,
        pendienteEstimadoArs,
        pendienteEstimadoUsd,
        diasSinPagar,
        estado: terminado ? "completo" as const : estadoPlan(pendienteCuotas, diasSinPagar),
        progresoPct,
      };
    })
    .sort((a, b) => b.pendienteEstimadoArs - a.pendienteEstimadoArs || b.ultimoPago.localeCompare(a.ultimoPago));
}

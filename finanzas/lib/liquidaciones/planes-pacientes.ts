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
  ultimoPago: string;
  pendienteCuotas: number;
  pendienteEstimadoArs: number;
  diasSinPagar: number;
  estado: EstadoPlan;
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
    ultimaCuotaArs: number; ultimaCuotaFecha: string; ultimoPago: string;
  };
  const por = new Map<string, Acum>();
  for (const p of [...pagos].sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    const k = claveConApodos(p.paciente);
    if (!k) continue;
    const a = por.get(k) ?? {
      paciente: p.paciente, doctora: p.doctora, plan: 0,
      cuotas: new Set<number>(), pagadoArs: 0, pagadoUsd: 0,
      ultimaCuotaArs: 0, ultimaCuotaFecha: "", ultimoPago: p.fecha,
    };
    a.pagadoArs += p.ars; a.pagadoUsd += p.usd;
    if (p.fecha > a.ultimoPago) a.ultimoPago = p.fecha;
    if (p.doctora) a.doctora = p.doctora;
    const doble = RE_CUOTA_DOBLE.exec(p.motivo);
    const simple = RE_CUOTA.exec(p.motivo);
    if (doble) {
      a.plan = Math.max(a.plan, Number(doble[3]));
      a.cuotas.add(Number(doble[1])); a.cuotas.add(Number(doble[2]));
      if (p.ars > 0 && p.fecha >= a.ultimaCuotaFecha) { a.ultimaCuotaArs = p.ars / 2; a.ultimaCuotaFecha = p.fecha; }
    } else if (simple) {
      a.plan = Math.max(a.plan, Number(simple[2]));
      a.cuotas.add(Number(simple[1]));
      if (p.ars > 0 && p.fecha >= a.ultimaCuotaFecha) { a.ultimaCuotaArs = p.ars; a.ultimaCuotaFecha = p.fecha; }
    } else {
      const suelta = RE_CUOTA_SUELTA.exec(p.motivo);
      if (suelta) {
        a.cuotas.add(Number(suelta[1]));
        if (p.ars > 0 && p.fecha >= a.ultimaCuotaFecha) { a.ultimaCuotaArs = p.ars; a.ultimaCuotaFecha = p.fecha; }
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
      b.ultimaCuotaArs = a.ultimaCuotaArs; b.ultimaCuotaFecha = a.ultimaCuotaFecha;
    }
    por.delete(k);
  }
  return [...por.values()]
    .filter((a) => a.plan > 0)
    .map((a) => {
      const pendienteCuotas = Math.max(0, a.plan - a.cuotas.size);
      // pagó la ÚLTIMA cuota del plan → terminado, aunque las primeras sean
      // anteriores al histórico (la caja arranca en ene/2026)
      const terminado = a.cuotas.has(a.plan);
      const ref = hoy ?? [...pagos].reduce((m, p) => (p.fecha > m ? p.fecha : m), "");
      const diasSinPagar = Math.max(0, Math.round((+new Date(ref) - +new Date(a.ultimoPago)) / 86400000));
      return {
        paciente: a.paciente, doctora: a.doctora, plan: a.plan,
        cuotasPagadas: a.cuotas.size, pagadoArs: a.pagadoArs, pagadoUsd: a.pagadoUsd,
        ultimaCuotaArs: a.ultimaCuotaArs, ultimoPago: a.ultimoPago,
        pendienteCuotas,
        pendienteEstimadoArs: Math.round(pendienteCuotas * a.ultimaCuotaArs),
        diasSinPagar,
        estado: terminado ? "completo" as const : estadoPlan(pendienteCuotas, diasSinPagar),
      };
    })
    .sort((a, b) => b.pendienteEstimadoArs - a.pendienteEstimadoArs || b.ultimoPago.localeCompare(a.ultimoPago));
}

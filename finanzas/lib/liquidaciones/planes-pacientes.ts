// Estado de pago de los planes de alineadores del consultorio, derivado de la
// caja: qué cuotas pagó cada paciente ("cuota X de Y") y cuánto le falta.
// El pendiente es un ESTIMADO: cuotas pendientes × última cuota conocida
// (las cuotas se ajustan por inflación, así que es piso, no contrato).
import { RE_CUOTA, RE_CUOTA_DOBLE, clavePaciente } from "./costeo";

// "cuota 3" a secas (sin "de Y"): cuenta como cuota numerada del plan ya conocido
const RE_CUOTA_SUELTA = /c(?:uo)?ta\s*\.?\s*(\d+)\b(?!\s*de)/i;

export type PagoPlan = {
  paciente: string; fecha: string; ars: number; usd: number;
  motivo: string; doctora: string | null;
};

export type PlanPaciente = {
  paciente: string; doctora: string | null;
  plan: number;                 // Y de "cuota X de Y"
  cuotasPagadas: number;
  pagadoArs: number; pagadoUsd: number;
  ultimaCuotaArs: number;       // monto de la última cuota numerada
  ultimoPago: string;
  pendienteCuotas: number;
  pendienteEstimadoArs: number;
};

export function planesPacientes(pagos: PagoPlan[]): PlanPaciente[] {
  type Acum = {
    paciente: string; doctora: string | null; plan: number;
    cuotas: Set<number>; pagadoArs: number; pagadoUsd: number;
    ultimaCuotaArs: number; ultimaCuotaFecha: string; ultimoPago: string;
  };
  const por = new Map<string, Acum>();
  for (const p of [...pagos].sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    const k = clavePaciente(p.paciente);
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
  return [...por.values()]
    .filter((a) => a.plan > 0)
    .map((a) => {
      const pendienteCuotas = Math.max(0, a.plan - a.cuotas.size);
      return {
        paciente: a.paciente, doctora: a.doctora, plan: a.plan,
        cuotasPagadas: a.cuotas.size, pagadoArs: a.pagadoArs, pagadoUsd: a.pagadoUsd,
        ultimaCuotaArs: a.ultimaCuotaArs, ultimoPago: a.ultimoPago,
        pendienteCuotas,
        pendienteEstimadoArs: Math.round(pendienteCuotas * a.ultimaCuotaArs),
      };
    })
    .sort((a, b) => b.pendienteEstimadoArs - a.pendienteEstimadoArs || b.ultimoPago.localeCompare(a.ultimoPago));
}

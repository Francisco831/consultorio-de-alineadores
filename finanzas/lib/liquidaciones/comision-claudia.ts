// Comisión de Claudia (secretaria AR): $100.000 por cada tratamiento nuevo,
// además de su sueldo (definido por Pancho, 21/8/26). "Tratamiento nuevo" =
// PRIMERA cuota/seña de Alineadores de cada paciente en la caja — la segunda
// etapa o las cuotas siguientes del mismo paciente no vuelven a contar.
// Los pacientes de la caja Coni quedan afuera (contabilidad separada).

import { PACIENTES_DE_CONI } from "./pacientes-coni";

export const COMISION_POR_TRATAMIENTO = 100_000;

export type PagoAlineadores = {
  occurred_on: string;           // YYYY-MM-DD
  counterparty_id: string | null;
  paciente: string | null;       // display_name de la contraparte
  separada: boolean;             // true = cuenta con separate_books (Coni)
  descripcion?: string | null;   // motivo de la caja ("cuota 3 de 6", "seña"…)
};

// la caja tiene el mismo paciente con variantes ("Tonello Fiorella" /
// "Fiorella Tonello" / "Lazaro"↔"Lázaro"): la clave es el nombre normalizado
// con tokens ordenados, no el id de contraparte
const claveNombre = (nombre: string) =>
  nombre.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/\s+/).filter(Boolean).sort().join(" ");

// una primera aparición que arranca en "cuota 2 de 4" o "saldo de cuota" es un
// tratamiento que ya venía de antes (el histórico carga desde ene/2026) — no
// es venta nueva de Claudia
const empiezaAMitad = (desc: string | null | undefined) =>
  /(?:saldo\s+de\s+)?cuota\s*(?:n[°º]?\s*)?([2-9]|1[0-9])\s*de\s*\d+/i.test(desc ?? "") ||
  /saldo de cuota/i.test(desc ?? "");

// Una ETAPA ADICIONAL no es un tratamiento nuevo: es el mismo paciente que sigue
// (Pancho, 26/8/26, sobre Daira Castellón). Aunque su fila diga "cuota 1 de 3"
// —y por eso no la agarra empiezaAMitad—, Claudia no vendió nada nuevo ahí.
//
// Se detecta por el texto de la caja y, además, por los planes marcados como
// etapa adicional (treatment_plans): la caja no siempre lo aclara, y cuando no
// lo aclara el sistema le estaría pagando $100.000 de más a Claudia sin que
// nadie lo note.
const esEtapaAdicional = (p: PagoAlineadores, declaradas: Set<string>) =>
  /etapa\s+adicional/i.test(p.descripcion ?? "") ||
  declaradas.has(claveNombre(p.paciente ?? ""));

export type TratamientoNuevo = { mes: string; fecha: string; paciente: string };

export function tratamientosNuevos(
  pagos: PagoAlineadores[],
  ajenos: string[] = PACIENTES_DE_CONI,
  /** Pacientes cuyo plan está marcado como etapa adicional (treatment_plans). */
  etapasDeclaradas: string[] = []
): TratamientoNuevo[] {
  const deOtro = new Set(ajenos.map(claveNombre));
  const declaradas = new Set(etapasDeclaradas.map(claveNombre));
  // Las etapas adicionales se descartan ANTES de buscar la primera aparición:
  // así, si un paciente tiene su tratamiento original y además una etapa, sigue
  // contando por el original y no por la que llegue primero.
  const propios = pagos.filter(
    (p) => !p.separada && !deOtro.has(claveNombre(p.paciente ?? "")) &&
      !esEtapaAdicional(p, declaradas)
  );
  // primera aparición por paciente (nombre normalizado; sin nombre, el id)
  const primeros = new Map<string, PagoAlineadores>();
  for (const p of [...propios].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on))) {
    const nombre = (p.paciente ?? "").trim();
    const clave = nombre ? claveNombre(nombre) : p.counterparty_id;
    if (!clave) continue;
    if (!primeros.has(clave)) primeros.set(clave, p);
  }
  return [...primeros.values()]
    .filter((p) => !empiezaAMitad(p.descripcion))
    .map((p) => ({ mes: p.occurred_on.slice(0, 7), fecha: p.occurred_on, paciente: p.paciente ?? "(sin nombre)" }))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
}

export function comisionPorMes(nuevos: TratamientoNuevo[]): Map<string, { cantidad: number; comision: number; pacientes: string[] }> {
  const porMes = new Map<string, { cantidad: number; comision: number; pacientes: string[] }>();
  for (const n of nuevos) {
    const m = porMes.get(n.mes) ?? { cantidad: 0, comision: 0, pacientes: [] };
    m.cantidad += 1;
    m.comision = m.cantidad * COMISION_POR_TRATAMIENTO;
    m.pacientes.push(n.paciente);
    porMes.set(n.mes, m);
  }
  return porMes;
}

// Comisión de Claudia (secretaria AR): $100.000 por cada tratamiento nuevo,
// además de su sueldo (definido por Pancho, 21/8/26). "Tratamiento nuevo" =
// PRIMERA cuota/seña de Alineadores de cada paciente en la caja — la segunda
// etapa o las cuotas siguientes del mismo paciente no vuelven a contar.
// Los pacientes de la caja Coni quedan afuera (contabilidad separada).

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

export type TratamientoNuevo = { mes: string; fecha: string; paciente: string };

export function tratamientosNuevos(pagos: PagoAlineadores[]): TratamientoNuevo[] {
  const propios = pagos.filter((p) => !p.separada);
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

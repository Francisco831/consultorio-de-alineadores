/**
 * Muda los pactos de lib/liquidaciones/pactos.ts a la tabla treatment_plans.
 *
 *   npx tsx scripts/migrar-pactos.ts [--apply]
 *
 * Los seis diccionarios del archivo se convierten en un plan por paciente:
 *   PRECIO_PACTADO / PRECIO_PACTADO_USD → total_amount + currency
 *   PLAN_PACIENTE                       → installments_total
 *   ETAPA_ADICIONAL                     → is_additional_stage, sin ks_list_price
 *   COSTO_ETAPA_ADICIONAL               → is_additional_stage + ks_list_price
 *   DESCUENTO_KS_ESPECIAL               → ks_discount_pct
 *
 * Las variantes de grafía del mismo paciente (el diccionario las repetía a
 * mano) se agrupan en UN plan: la ficha con más cobros es el patient_id y las
 * demás quedan en match_names.
 *
 * Idempotente: si el paciente ya tiene un plan de alineadores, lo actualiza.
 */
import { serviceClient, argFlags } from "./lib/service-client";
import {
  COSTO_ETAPA_ADICIONAL, DESCUENTO_KS_ESPECIAL, ETAPA_ADICIONAL, PLAN_PACIENTE,
  PRECIO_PACTADO, PRECIO_PACTADO_USD,
} from "../lib/liquidaciones/pactos";
import { clavePaciente } from "../lib/liquidaciones/costeo";

type Pacto = {
  clave: string;
  nombres: Set<string>;            // las grafías que trae el diccionario
  totalArs?: number;
  totalUsd?: number;
  cuotas?: number;
  etapaAdicional?: boolean;
  precioListaEtapa?: number;
  descuentoPct?: number;
};

const tokens = (n: string) => new Set(clavePaciente(n).split(" ").filter(Boolean));

/**
 * Une las variantes de grafía del MISMO paciente.
 *
 * En pactos.ts las variantes son entradas separadas con el mismo valor, escritas
 * juntas ("nisenbaum martin": 2300, "martin nissenbaum": 2300, "nisenbaum":
 * 2300). Dos condiciones a la vez, porque cada una sola se equivoca:
 *  - CONSECUTIVAS con el mismo valor. Sola no alcanza: "szalontai natalia" y
 *    "agustina di natale" están pegadas y las dos valen 3.800.000, y son dos
 *    personas.
 *  - Que compartan un token con ALGUNO de los ya agrupados. Sola no alcanza
 *    tampoco: "nisenbaum" no comparte nada con "martin nissenbaum" (doble s),
 *    pero sí con "nisenbaum martin", que ya está en el grupo.
 */
function agrupar(entradas: Array<[string, number]>): Array<{ nombres: string[]; valor: number }> {
  const grupos: Array<{ nombres: string[]; valor: number; toks: Set<string> }> = [];
  for (const [nombre, valor] of entradas) {
    const ult = grupos[grupos.length - 1];
    const t = tokens(nombre);
    const pega = ult && ult.valor === valor && [...t].some((x) => ult.toks.has(x));
    if (pega) {
      ult.nombres.push(nombre);
      for (const x of t) ult.toks.add(x);
    } else {
      grupos.push({ nombres: [nombre], valor, toks: t });
    }
  }
  return grupos.map((g) => ({ nombres: g.nombres, valor: g.valor }));
}

function juntar(): Map<string, Pacto> {
  const out = new Map<string, Pacto>();
  // La clave del pacto es la del PRIMER nombre del grupo: todas las variantes
  // caen en el mismo Pacto y terminan en un solo plan.
  const tomar = (nombres: string[]): Pacto => {
    const clave = clavePaciente(nombres[0]);
    if (!out.has(clave)) out.set(clave, { clave, nombres: new Set() });
    const p = out.get(clave)!;
    for (const n of nombres) p.nombres.add(n);
    return p;
  };
  // Un paciente que ya tiene grupo por otro diccionario se engancha a ese.
  const claveDe = (nombres: string[]) => {
    for (const n of nombres) {
      for (const [k, p] of out) {
        if ([...p.nombres].some((x) => clavePaciente(x) === clavePaciente(n))) return k;
      }
    }
    return null;
  };
  const asignar = (nombres: string[], set: (p: Pacto) => void) => {
    const k = claveDe(nombres);
    const p = k ? out.get(k)! : tomar(nombres);
    for (const n of nombres) p.nombres.add(n);
    set(p);
  };

  for (const g of agrupar(Object.entries(PRECIO_PACTADO))) {
    asignar(g.nombres, (p) => { p.totalArs = g.valor; });
  }
  for (const g of agrupar(Object.entries(PRECIO_PACTADO_USD))) {
    asignar(g.nombres, (p) => { p.totalUsd = g.valor; });
  }
  for (const g of agrupar(Object.entries(PLAN_PACIENTE))) {
    asignar(g.nombres, (p) => { p.cuotas = g.valor; });
  }
  for (const g of agrupar([...ETAPA_ADICIONAL].map((n) => [n, 1] as [string, number]))) {
    asignar(g.nombres, (p) => { p.etapaAdicional = true; });
  }
  for (const g of agrupar(Object.entries(COSTO_ETAPA_ADICIONAL))) {
    asignar(g.nombres, (p) => { p.etapaAdicional = true; p.precioListaEtapa = g.valor; });
  }
  for (const g of agrupar(Object.entries(DESCUENTO_KS_ESPECIAL))) {
    asignar(g.nombres, (p) => { p.descuentoPct = g.valor; });
  }
  return out;
}

async function main() {
  const { apply } = argFlags();
  const db = await serviceClient({
    accion: "mudar los pactos de pactos.ts a treatment_plans", auto: !apply,
  });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");
  const companyId = cia.id as string;

  // Fichas de pacientes y cuántos cobros tiene cada una: la que más cobros
  // tiene es la principal, las otras van a match_names.
  const { data: cps } = await db.from("counterparties")
    .select("id, display_name").eq("company_id", companyId).eq("kind", "patient");
  const { data: movs } = await db.from("movements")
    .select("counterparty_id").eq("company_id", companyId).eq("kind", "income")
    .neq("status", "void").limit(2000);
  const cobrosPorFicha = new Map<string, number>();
  for (const m of movs ?? []) {
    const id = m.counterparty_id as string | null;
    if (id) cobrosPorFicha.set(id, (cobrosPorFicha.get(id) ?? 0) + 1);
  }
  const fichasPorClave = new Map<string, Array<{ id: string; nombre: string; cobros: number }>>();
  for (const c of cps ?? []) {
    const clave = clavePaciente(c.display_name as string);
    if (!fichasPorClave.has(clave)) fichasPorClave.set(clave, []);
    fichasPorClave.get(clave)!.push({
      id: c.id as string, nombre: c.display_name as string,
      cobros: cobrosPorFicha.get(c.id as string) ?? 0,
    });
  }

  const { data: existentes } = await db.from("treatment_plans")
    .select("id, patient_id").eq("company_id", companyId).eq("kind", "alineadores");
  const planPorPaciente = new Map((existentes ?? []).map((p) => [p.patient_id as string, p.id as string]));

  const pactos = juntar();
  const sinFicha: string[] = [];
  const filas: Array<Record<string, unknown>> = [];
  const detalle: string[] = [];

  for (const p of pactos.values()) {
    // Todas las fichas que normalizan a la MISMA clave, más las que salen de
    // las otras grafías del diccionario (que pueden normalizar distinto).
    const claves = new Set([p.clave, ...[...p.nombres].map(clavePaciente)]);
    const fichas = [...claves].flatMap((k) => fichasPorClave.get(k) ?? []);
    if (!fichas.length) {
      sinFicha.push(`${[...p.nombres][0]} (ninguna ficha en la caja)`);
      continue;
    }
    fichas.sort((a, b) => b.cobros - a.cobros);
    const principal = fichas[0];
    const otras = [...new Set([
      ...fichas.slice(1).map((f) => f.nombre),
      ...[...p.nombres].filter((n) => clavePaciente(n) !== clavePaciente(principal.nombre)),
    ])];

    const fila: Record<string, unknown> = {
      company_id: companyId,
      patient_id: principal.id,
      kind: "alineadores",
      currency: p.totalUsd ? "USD" : "ARS",
      total_amount: p.totalUsd ?? p.totalArs ?? null,
      installments_total: p.cuotas ?? null,
      is_additional_stage: p.etapaAdicional ?? false,
      ks_list_price: p.precioListaEtapa ?? null,
      ks_discount_pct: p.descuentoPct ?? null,
      match_names: otras,
      status: "active",
      notes: "Migrado de pactos.ts el 26/8/26",
    };
    const id = planPorPaciente.get(principal.id);
    if (id) fila.id = id;
    filas.push(fila);
    detalle.push(
      `${principal.nombre.padEnd(26)} ${p.totalUsd ? `US$ ${p.totalUsd}` : p.totalArs ? `$${p.totalArs.toLocaleString("es-AR")}` : "sin precio"}` +
      `${p.cuotas ? ` · ${p.cuotas} cuotas` : ""}${p.descuentoPct ? ` · −${p.descuentoPct}% KS` : ""}` +
      `${p.etapaAdicional ? ` · etapa adicional${p.precioListaEtapa ? ` a $${p.precioListaEtapa.toLocaleString("es-AR")}` : " sin costo"}` : ""}` +
      `${otras.length ? ` · alias: ${otras.join(", ")}` : ""}`
    );
  }

  console.log(`\n${pactos.size} pactos en el código → ${filas.length} planes\n`);
  for (const d of detalle.sort()) console.log(`  ${d}`);
  if (sinFicha.length) {
    console.log(`\n⚠ ${sinFicha.length} sin ficha de paciente en la caja (no se migran):`);
    for (const s of sinFicha) console.log(`     ${s}`);
  }

  if (!apply) {
    console.log("\n(dry-run: no se escribió nada — repetir con --apply)");
    return;
  }
  for (let i = 0; i < filas.length; i += 200) {
    const { error } = await db.from("treatment_plans").upsert(filas.slice(i, i + 200));
    if (error) throw new Error(`guardar planes: ${error.message}`);
  }
  console.log(`\n✓ ${filas.length} planes guardados en treatment_plans`);
}

main().catch((e) => { console.error(`\n✗ ${e instanceof Error ? e.message : e}`); process.exit(1); });

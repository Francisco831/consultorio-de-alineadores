// Los pactos que hoy viven en treatment_plans, con la forma que espera el costeo.
//
// Es el reemplazo de los seis diccionarios de pactos.ts: mismos datos, misma
// forma, pero cargados de la base para que se puedan editar desde la página.
//
// El costeo identifica al paciente por su NOMBRE normalizado, no por id: la
// caja escribe el mismo paciente de varias formas y termina con varias fichas.
// Por eso cada plan aporta tantas claves como grafías tenga (la de su ficha más
// las de match_names), y todas apuntan al mismo pacto.

import type { SupabaseClient } from "@supabase/supabase-js";

export type PactosCargados = {
  precioPactado: Record<string, number>;
  precioPactadoUsd: Record<string, number>;
  planPorPaciente: Record<string, number>;
  etapaAdicional: Set<string>;
  costoEtapaAdicional: Record<string, number>;
  descuentoKsEspecial: Record<string, number>;
  /** Cuántos planes se leyeron: para que el llamador pueda frenar si es 0. */
  planes: number;
};

type FilaPlan = {
  total_amount: string | number | null;
  currency: string;
  installments_total: number | null;
  is_additional_stage: boolean;
  ks_list_price: string | number | null;
  ks_discount_pct: string | number | null;
  match_names: string[] | null;
  patient: { display_name: string } | null;
};

export async function cargarPactos(
  db: SupabaseClient, companyId: string
): Promise<PactosCargados> {
  const { data, error } = await db
    .from("treatment_plans")
    .select("total_amount, currency, installments_total, is_additional_stage, ks_list_price, ks_discount_pct, match_names, patient:counterparties!treatment_plans_patient_id_company_id_fkey(display_name)")
    .eq("company_id", companyId)
    .eq("kind", "alineadores")
    .eq("status", "active")
    .limit(2000);
  if (error) throw new Error(`leer los pactos: ${error.message}`);

  const out: PactosCargados = {
    precioPactado: {}, precioPactadoUsd: {}, planPorPaciente: {},
    etapaAdicional: new Set(), costoEtapaAdicional: {}, descuentoKsEspecial: {},
    planes: 0,
  };

  for (const p of (data ?? []) as unknown as FilaPlan[] ) {
    const principal = p.patient?.display_name;
    if (!principal) continue;
    out.planes++;
    // Todas las grafías del paciente valen lo mismo: el costeo normaliza cada
    // una con clavePaciente(), así que alcanza con listarlas.
    const nombres = [principal, ...(p.match_names ?? [])].filter(Boolean);
    const total = p.total_amount == null ? null : Number(p.total_amount);
    const lista = p.ks_list_price == null ? null : Number(p.ks_list_price);
    const dto = p.ks_discount_pct == null ? null : Number(p.ks_discount_pct);
    for (const n of nombres) {
      if (total != null) {
        if (p.currency === "USD") out.precioPactadoUsd[n] = total;
        else out.precioPactado[n] = total;
      }
      if (p.installments_total) out.planPorPaciente[n] = p.installments_total;
      // etapaAdicional es "etapa adicional que NO cuesta". Una etapa CON precio
      // de lista no va ahí: va en costoEtapaAdicional y se cobra. Marcar las dos
      // cosas funcionaba de casualidad (el costeo mira el precio primero) y se
      // rompía solo el día que alguien le sacara el precio al plan.
      if (p.is_additional_stage && lista == null) out.etapaAdicional.add(n);
      if (lista != null) out.costoEtapaAdicional[n] = lista;
      if (dto) out.descuentoKsEspecial[n] = dto;
    }
  }
  return out;
}

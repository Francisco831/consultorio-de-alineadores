// Carga los pagos de Alineadores y devuelve la comisión de Claudia por mes.
// La usan Sueldos y Liquidaciones (misma cuenta, dos pantallas).
import type { SupabaseClient } from "@supabase/supabase-js";
import { comisionPorMes, tratamientosNuevos, type TratamientoNuevo } from "./comision-claudia";
import { cargarPactos } from "./pactos-db";

/** Los tratamientos nuevos con paciente y fecha. Única fuente: la comisión de
 *  Claudia y el contador del dashboard cuentan exactamente lo mismo. */
export async function cargarTratamientosNuevos(
  supabase: SupabaseClient, companyId: string
): Promise<TratamientoNuevo[]> {
  const { data: catAlin } = await supabase
    .from("categories").select("id")
    .eq("company_id", companyId).eq("name", "Alineadores").maybeSingle();
  if (!catAlin) return [];
  const { data: pagos } = await supabase
    .from("movements")
    .select("occurred_on, counterparty_id, description, counterparty:counterparties(display_name), account:accounts!movements_account_company_fk(separate_books)")
    .eq("company_id", companyId).eq("kind", "income")
    .eq("category_id", catAlin.id).neq("status", "void")
    .limit(2000);
  // Las etapas adicionales salen de treatment_plans, la misma fuente que usa el
  // costeo: si vivieran en dos lados, un día una etapa contaría como caso nuevo
  // en la comisión y como etapa en el costo.
  const pactos = await cargarPactos(supabase, companyId);
  const etapas = [
    ...pactos.etapaAdicional,
    ...Object.keys(pactos.costoEtapaAdicional),
  ];
  return tratamientosNuevos(
    (pagos ?? []).map((pg) => ({
      occurred_on: pg.occurred_on,
      counterparty_id: pg.counterparty_id,
      paciente: (pg.counterparty as { display_name?: string } | null)?.display_name ?? null,
      separada: Boolean((pg.account as { separate_books?: boolean } | null)?.separate_books),
      descripcion: pg.description,
    })),
    undefined,
    etapas
  );
}

export async function comisionClaudiaPorMes(supabase: SupabaseClient, companyId: string) {
  return comisionPorMes(await cargarTratamientosNuevos(supabase, companyId));
}

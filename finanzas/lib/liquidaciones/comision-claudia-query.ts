// Carga los pagos de Alineadores y devuelve la comisión de Claudia por mes.
// La usan Sueldos y Liquidaciones (misma cuenta, dos pantallas).
import type { SupabaseClient } from "@supabase/supabase-js";
import { comisionPorMes, tratamientosNuevos } from "./comision-claudia";

export async function comisionClaudiaPorMes(supabase: SupabaseClient, companyId: string) {
  const { data: catAlin } = await supabase
    .from("categories").select("id")
    .eq("company_id", companyId).eq("name", "Alineadores").maybeSingle();
  if (!catAlin) return new Map<string, { cantidad: number; comision: number; pacientes: string[] }>();
  const { data: pagos } = await supabase
    .from("movements")
    .select("occurred_on, counterparty_id, description, counterparty:counterparties(display_name), account:accounts!movements_account_company_fk(separate_books)")
    .eq("company_id", companyId).eq("kind", "income")
    .eq("category_id", catAlin.id).neq("status", "void")
    .limit(2000);
  const nuevos = tratamientosNuevos(
    (pagos ?? []).map((pg) => ({
      occurred_on: pg.occurred_on,
      counterparty_id: pg.counterparty_id,
      paciente: (pg.counterparty as { display_name?: string } | null)?.display_name ?? null,
      separada: Boolean((pg.account as { separate_books?: boolean } | null)?.separate_books),
      descripcion: pg.description,
    }))
  );
  return comisionPorMes(nuevos);
}

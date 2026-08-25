"use server";

// El pacto de un paciente: lo que acordó pagar, en cuántas cuotas, con qué
// descuento de KS y si es una etapa adicional.
//
// Son los números que deciden cuánto costo KS se le descuenta a la doctora en
// cada cobro. Hasta el 26/8/26 vivían en un archivo del repo y sólo se podían
// cambiar editando código y esperando un deploy; ahora están en
// treatment_plans, que además tiene trigger de auditoría: cada cambio queda
// registrado con quién y cuándo.
//
// Guardar recalcula: si no, el número nuevo no se ve hasta que alguien apriete
// Recalcular, y la liquidación sigue mostrando el costo viejo. Los meses
// confirmados o pagados no se tocan — están congelados por diseño.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";
import { recalcularLiquidaciones } from "@/lib/liquidaciones/recalcular";

const PactoSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  patientId: z.string().uuid(),
  /** Precio TOTAL acordado con el paciente. Null = todavía no se sabe. */
  total: z.number().positive().nullable(),
  currency: z.enum(["ARS", "USD"]),
  cuotas: z.number().int().positive().max(60).nullable(),
  /** Descuento extra sobre el costo KS de lista, en %. */
  descuentoPct: z.number().min(0).max(99).nullable(),
  etapaAdicional: z.boolean(),
  /** Precio de lista de la etapa adicional. Null = viene incluida, no cuesta. */
  precioListaEtapa: z.number().positive().nullable(),
  /** Otras grafías del paciente en la caja. */
  alias: z.array(z.string().trim().min(2).max(120)).max(20),
});

export async function guardarPacto(input: z.infer<typeof PactoSchema>) {
  const parsed = PactoSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  const { data: paciente } = await supabase
    .from("counterparties").select("id, display_name")
    .eq("id", d.patientId).eq("company_id", ctx.companyId).maybeSingle();
  if (!paciente) return { error: "El paciente no existe" };

  // Un plan de alineadores por paciente: si ya tiene, se actualiza.
  const { data: previo } = await supabase
    .from("treatment_plans").select("id")
    .eq("company_id", ctx.companyId).eq("patient_id", d.patientId)
    .eq("kind", "alineadores").maybeSingle();

  const fila = {
    company_id: ctx.companyId,
    patient_id: d.patientId,
    kind: "alineadores" as const,
    currency: d.currency,
    total_amount: d.total,
    installments_total: d.cuotas,
    ks_discount_pct: d.descuentoPct,
    is_additional_stage: d.etapaAdicional,
    // El precio de lista sólo tiene sentido en una etapa adicional: si el plan
    // deja de serlo, el precio se va con él en vez de quedar de fantasma.
    ks_list_price: d.etapaAdicional ? d.precioListaEtapa : null,
    match_names: d.alias,
    status: "active" as const,
  };

  const { error } = previo
    ? await supabase.from("treatment_plans").update(fila).eq("id", previo.id)
    : await supabase.from("treatment_plans").insert(fila);
  if (error) return { error: error.message };

  // El costeo acumula el costo del caso sobre TODA su historia, así que un
  // pacto nuevo puede mover meses viejos: se recalcula todo lo que esté abierto.
  try {
    const r = await recalcularLiquidaciones(supabase, ctx.companyId);
    revalidatePath(`/${d.empresa}/pacientes`);
    revalidatePath(`/${d.empresa}/liquidaciones`);
    return {
      ok: true,
      mensaje:
        `Pacto de ${paciente.display_name} guardado · ${r.guardadas} liquidación${r.guardadas === 1 ? "" : "es"} recalculada${r.guardadas === 1 ? "" : "s"}` +
        (r.congeladas.length ? ` · ${r.congeladas.length} cerrada${r.congeladas.length === 1 ? "" : "s"} sin tocar` : "") +
        (r.sinCostear ? ` · quedan ${r.sinCostear} cobro(s) sin costear` : " · no quedan cobros sin costear"),
    };
  } catch (e) {
    return { error: `Pacto guardado, pero el recálculo falló: ${(e as Error).message}` };
  }
}

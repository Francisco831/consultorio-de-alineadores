"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";
import { recalcularLiquidaciones } from "@/lib/liquidaciones/recalcular";

const MovimientoSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  kind: z.enum(["income", "expense"]),
  amount: z.number().positive(),
  accountId: z.string().uuid(),
  categoryId: z.string().uuid().nullable().optional(),
  counterpartyName: z.string().trim().max(200).optional(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().max(500).optional(),
  status: z.enum(["confirmed", "pending"]).default("confirmed"),
});

// contraparte por defecto según flujo y empresa (editable después en la ficha)
const CP_KIND: Record<string, Record<string, string>> = {
  income: { ar: "patient", mx: "doctor_customer" },
  expense: { ar: "supplier", mx: "supplier" },
};

export async function crearMovimiento(input: z.infer<typeof MovimientoSchema>) {
  const parsed = MovimientoSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  // moneda = la de la cuenta (el trigger/FK lo exige; acá la resolvemos)
  const { data: account } = await supabase
    .from("accounts")
    .select("id, currency")
    .eq("id", d.accountId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  if (!account) return { error: "Cuenta inexistente" };

  let counterpartyId: string | null = null;
  if (d.counterpartyName) {
    const kind = CP_KIND[d.kind][d.empresa];
    const { data: existing } = await supabase
      .from("counterparties")
      .select("id")
      .eq("company_id", ctx.companyId)
      .ilike("display_name", d.counterpartyName)
      .limit(1)
      .maybeSingle();
    if (existing) counterpartyId = existing.id;
    else {
      const { data: created, error } = await supabase
        .from("counterparties")
        .insert({ company_id: ctx.companyId, kind, display_name: d.counterpartyName })
        .select("id")
        .single();
      if (error) return { error: `No se pudo crear la contraparte: ${error.message}` };
      counterpartyId = created.id;
    }
  }

  const { error } = await supabase.from("movements").insert({
    company_id: ctx.companyId,
    account_id: account.id,
    currency: account.currency,
    kind: d.kind,
    status: d.status,
    occurred_on: d.occurredOn,
    amount: d.amount,
    category_id: d.categoryId ?? null,
    counterparty_id: counterpartyId,
    description: d.description || null,
    source: "manual",
    created_by: ctx.userId,
  });
  if (error) return { error: error.message };

  revalidatePath(`/${d.empresa}/movimientos`);
  revalidatePath(`/${d.empresa}/hoy`);
  return { ok: true };
}

const TransferenciaSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amountOut: z.number().positive(),
  amountIn: z.number().positive(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().max(500).optional(),
});

export async function crearTransferencia(input: z.infer<typeof TransferenciaSchema>) {
  const parsed = TransferenciaSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  const { error } = await supabase.rpc("create_transfer", {
    p_company_id: ctx.companyId,
    p_from_account: d.fromAccountId,
    p_to_account: d.toAccountId,
    p_amount_out: d.amountOut,
    p_amount_in: d.amountIn,
    p_date: d.occurredOn,
    p_description: d.description || null,
  });
  if (error) return { error: error.message };

  revalidatePath(`/${d.empresa}/movimientos`);
  revalidatePath(`/${d.empresa}/hoy`);
  return { ok: true };
}

export async function anularMovimiento(empresa: "mx" | "ar", movementId: string) {
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  // ¿Estaba liquidado? Se pregunta ANTES de anular, porque después el ítem se
  // limpia solo en el recálculo. Sin esto, anular un cobro lo sacaba del ledger
  // y lo dejaba igual en la liquidación de la doctora: el total la seguía
  // incluyendo y confirmar ahí pagaba el 40% de plata que ya no existe.
  const { data: liquidado } = await supabase.from("settlement_items")
    .select("id").eq("company_id", ctx.companyId).eq("movement_id", movementId).maybeSingle();

  const { error } = await supabase.rpc("void_movement", { p_movement_id: movementId });
  if (error) return { error: error.message };
  if (liquidado) await recalcularSiSePuede(supabase, ctx.companyId);
  revalidatePath(`/${empresa}/movimientos`);
  revalidatePath(`/${empresa}/hoy`);
  revalidatePath(`/${empresa}/liquidaciones`);
  return { ok: true };
}

const CorreccionSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  movementId: z.string().uuid(),
  accountId: z.string().uuid(),
  amount: z.number().positive(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoryId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(500).optional(),
});

/**
 * Corrige un movimiento en el lugar: la cuenta con la que se pagó, la fecha, el
 * monto, la categoría o el concepto. Las reglas (origen, conciliación, saldo de
 * la deuda) las decide correct_movement en la base, que es donde viven las otras.
 */
export async function corregirMovimiento(input: z.infer<typeof CorreccionSchema>) {
  const parsed = CorreccionSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  const { error } = await supabase.rpc("correct_movement", {
    p_movement_id: d.movementId,
    p_account_id: d.accountId,
    p_occurred_on: d.occurredOn,
    p_amount: d.amount,
    p_category_id: d.categoryId ?? null,
    p_description: d.description || null,
  });
  if (error) return { error: error.message };

  // Corregir el monto o la fecha de un cobro liquidado le cambia el número a la
  // doctora: la liquidación se rehace acá y no cuando alguien se acuerde.
  const { data: liquidado } = await supabase.from("settlement_items")
    .select("id").eq("company_id", ctx.companyId).eq("movement_id", d.movementId).maybeSingle();
  if (liquidado) await recalcularSiSePuede(supabase, ctx.companyId);

  for (const ruta of ["movimientos", "hoy", "pagar", "cobrar", "liquidaciones"]) {
    revalidatePath(`/${d.empresa}/${ruta}`);
  }
  return { ok: true };
}

/**
 * Rehace las liquidaciones abiertas después de tocar un cobro que estaba
 * liquidado. Si el recálculo falla no se deshace la corrección —el movimiento ya
 * cambió y eso está bien— pero tampoco se rompe la pantalla: el panel de
 * liquidaciones tiene su propio botón de Recalcular y avisa lo que encuentre.
 */
async function recalcularSiSePuede(
  supabase: Awaited<ReturnType<typeof createClient>>, companyId: string
) {
  try {
    await recalcularLiquidaciones(supabase, companyId);
  } catch {
    // el panel lo va a mostrar en su próximo recálculo
  }
}

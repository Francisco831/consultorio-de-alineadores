"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";

const CompraSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  supplierName: z.string().trim().min(1).max(200),
  purchasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().length(3),
  invoiceNo: z.string().trim().max(60).optional(),
  settlement: z.enum(["paid", "credit"]),
  /** solo si settlement = paid */
  accountId: z.string().uuid().optional(),
  /** solo si settlement = credit */
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  items: z.array(z.object({
    productName: z.string().trim().min(1).max(120),
    brand: z.string().trim().max(80).optional(),
    quantity: z.number().positive(),
    unit: z.string().trim().min(1).max(20),
    unitPrice: z.number().min(0),
  })).min(1).max(60),
});

/**
 * Registra una compra con su detalle. Es UNA operación: la compra, sus líneas,
 * el gasto (o la deuda) y el historial de precios salen todos de acá. Cargar el
 * detalle es lo que después permite decir "los guantes aumentaron 22%".
 */
export async function crearCompra(input: z.infer<typeof CompraSchema>) {
  const parsed = CompraSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  if (d.settlement === "paid" && !d.accountId) return { error: "Elegí de qué cuenta sale el pago" };
  if (d.settlement === "credit" && !d.dueOn) return { error: "Poné la fecha de vencimiento" };

  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();
  const currency = d.currency.toUpperCase();
  const total = Math.round(d.items.reduce((a, i) => a + i.quantity * i.unitPrice, 0) * 100) / 100;
  if (total <= 0) return { error: "El total de la compra es cero" };

  // proveedor
  let supplierId: string;
  const { data: ex } = await supabase.from("counterparties").select("id")
    .eq("company_id", ctx.companyId).ilike("display_name", d.supplierName).limit(1).maybeSingle();
  if (ex) supplierId = ex.id;
  else {
    const { data, error } = await supabase.from("counterparties")
      .insert({ company_id: ctx.companyId, kind: "supplier", display_name: d.supplierName })
      .select("id").single();
    if (error) return { error: error.message };
    supplierId = data.id;
  }

  // el gasto o la deuda
  let movementId: string | null = null;
  let payableId: string | null = null;
  if (d.settlement === "paid") {
    const { data: acc } = await supabase.from("accounts").select("id, currency")
      .eq("id", d.accountId!).eq("company_id", ctx.companyId).maybeSingle();
    if (!acc) return { error: "Cuenta inexistente" };
    if (acc.currency !== currency) return { error: `La cuenta es ${acc.currency} y la compra está en ${currency}` };
    const { data: mov, error } = await supabase.from("movements").insert({
      company_id: ctx.companyId, account_id: acc.id, currency,
      kind: "expense", status: "confirmed", occurred_on: d.purchasedOn,
      amount: total, category_id: d.categoryId ?? null, counterparty_id: supplierId,
      description: `Compra ${d.supplierName}${d.invoiceNo ? ` · FC ${d.invoiceNo}` : ""}`,
      source: "manual", created_by: ctx.userId,
    }).select("id").single();
    if (error) return { error: error.message };
    movementId = mov.id;
  } else {
    const { data: pay, error } = await supabase.from("payables").insert({
      company_id: ctx.companyId, counterparty_id: supplierId, category_id: d.categoryId ?? null,
      source: "purchase", concept: `Compra ${d.supplierName}${d.invoiceNo ? ` · FC ${d.invoiceNo}` : ""}`,
      currency, amount: total, due_on: d.dueOn!, created_by: ctx.userId,
    }).select("id").single();
    if (error) return { error: error.message };
    payableId = pay.id;
  }

  const { data: compra, error: eCompra } = await supabase.from("purchases").insert({
    company_id: ctx.companyId, supplier_id: supplierId, purchased_on: d.purchasedOn,
    currency, total, invoice_no: d.invoiceNo || null, settlement: d.settlement,
    movement_id: movementId, payable_id: payableId, created_by: ctx.userId,
  }).select("id").single();
  if (eCompra) return { error: eCompra.message };

  // productos get-or-create + líneas
  for (const item of d.items) {
    let productId: string;
    const { data: p } = await supabase.from("products").select("id")
      .eq("company_id", ctx.companyId).ilike("name", item.productName).limit(1).maybeSingle();
    if (p) productId = p.id;
    else {
      const { data, error } = await supabase.from("products")
        .insert({ company_id: ctx.companyId, name: item.productName, brand: item.brand || null,
                  default_unit: item.unit })
        .select("id").single();
      if (error) return { error: error.message };
      productId = data.id;
    }
    const { error } = await supabase.from("purchase_items").insert({
      company_id: ctx.companyId, purchase_id: compra.id, product_id: productId,
      brand: item.brand || null, quantity: item.quantity, unit: item.unit,
      unit_price: item.unitPrice,
      line_total: Math.round(item.quantity * item.unitPrice * 100) / 100,
    });
    if (error) return { error: error.message };
  }

  for (const p of ["compras", "proveedores", "movimientos", "pagar", "hoy", "costos"]) {
    revalidatePath(`/${d.empresa}/${p}`);
  }
  return { ok: true, total };
}

/** Último precio pagado por un producto, para avisar en el momento de cargar. */
export async function precioAnterior(empresa: "mx" | "ar", productName: string) {
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { data } = await supabase.from("v_product_prices")
    .select("product_name, precio_ultimo, precio_promedio, ultima_compra, currency")
    .eq("company_id", ctx.companyId).ilike("product_name", productName).limit(1).maybeSingle();
  return data ?? null;
}

const ProduccionSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  aligners: z.number().int().min(0),
  cases: z.number().int().min(0).optional(),
});

export async function guardarProduccion(input: z.infer<typeof ProduccionSchema>) {
  const parsed = ProduccionSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();
  const { error } = await supabase.from("production_months").upsert({
    company_id: ctx.companyId, period: d.period,
    aligners_produced: d.aligners, cases_shipped: d.cases ?? null,
    created_by: ctx.userId,
  }, { onConflict: "company_id,period" });
  if (error) return { error: error.message };
  revalidatePath(`/${d.empresa}/costos`);
  return { ok: true };
}

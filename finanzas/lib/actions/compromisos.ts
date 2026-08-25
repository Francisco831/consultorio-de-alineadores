"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";

const empresaEnum = z.enum(["mx", "ar"]);
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function refrescar(empresa: string) {
  for (const p of ["hoy", "pagar", "cobrar", "impuestos", "movimientos", "sueldos"]) {
    revalidatePath(`/${empresa}/${p}`);
  }
}

// ---------------------------------------------------------------- por pagar
const PayableSchema = z.object({
  empresa: empresaEnum,
  concept: z.string().trim().min(1).max(200),
  counterpartyName: z.string().trim().max(200).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  currency: z.string().length(3),
  amount: z.number().positive(),
  dueOn: fecha,
  notes: z.string().trim().max(500).optional(),
});

export async function crearPayable(input: z.infer<typeof PayableSchema>) {
  const parsed = PayableSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  let counterpartyId: string | null = null;
  if (d.counterpartyName) {
    const { data: ex } = await supabase.from("counterparties").select("id")
      .eq("company_id", ctx.companyId).ilike("display_name", d.counterpartyName).limit(1).maybeSingle();
    if (ex) counterpartyId = ex.id;
    else {
      const { data, error } = await supabase.from("counterparties")
        .insert({ company_id: ctx.companyId, kind: "supplier", display_name: d.counterpartyName })
        .select("id").single();
      if (error) return { error: error.message };
      counterpartyId = data.id;
    }
  }

  const { error } = await supabase.from("payables").insert({
    company_id: ctx.companyId, concept: d.concept, counterparty_id: counterpartyId,
    category_id: d.categoryId ?? null, currency: d.currency.toUpperCase(),
    amount: d.amount, due_on: d.dueOn, notes: d.notes || null,
    source: "manual", created_by: ctx.userId,
  });
  if (error) return { error: error.message };
  refrescar(d.empresa);
  return { ok: true };
}

const PagarSchema = z.object({
  empresa: empresaEnum,
  payableId: z.string().uuid(),
  accountId: z.string().uuid(),
  amount: z.number().positive(),
  date: fecha,
});

/** Marcar pagado GENERA el egreso: no hay forma de pagar sin mover una cuenta. */
export async function pagarPayable(input: z.infer<typeof PagarSchema>) {
  const parsed = PagarSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  await requireEmpresa(d.empresa);
  const supabase = await createClient();
  const { error } = await supabase.rpc("pay_payable", {
    p_payable_id: d.payableId, p_account_id: d.accountId,
    p_amount: d.amount, p_date: d.date,
  });
  if (error) return { error: error.message };
  refrescar(d.empresa);
  return { ok: true };
}

// --------------------------------------------------------------- por cobrar
const ReceivableSchema = z.object({
  empresa: empresaEnum,
  counterpartyName: z.string().trim().min(1).max(200),
  concept: z.string().trim().min(1).max(200),
  currency: z.string().length(3),
  amount: z.number().positive(),
  dueOn: fecha.optional(),
  installments: z.number().int().min(1).max(60).default(1),
  notes: z.string().trim().max(500).optional(),
});

/** Crea una deuda; con `installments` > 1 genera una cuota por mes. */
export async function crearReceivable(input: z.infer<typeof ReceivableSchema>) {
  const parsed = ReceivableSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  const kind = d.empresa === "ar" ? "patient" : "doctor_customer";
  let counterpartyId: string;
  const { data: ex } = await supabase.from("counterparties").select("id")
    .eq("company_id", ctx.companyId).ilike("display_name", d.counterpartyName).limit(1).maybeSingle();
  if (ex) counterpartyId = ex.id;
  else {
    const { data, error } = await supabase.from("counterparties")
      .insert({ company_id: ctx.companyId, kind, display_name: d.counterpartyName })
      .select("id").single();
    if (error) return { error: error.message };
    counterpartyId = data.id;
  }

  const cuotas = d.installments;
  const base = Math.floor((d.amount / cuotas) * 100) / 100;
  const filas = [];
  for (let i = 1; i <= cuotas; i++) {
    // la diferencia de redondeo va en la última cuota: el total siempre cierra
    const monto = i === cuotas ? Math.round((d.amount - base * (cuotas - 1)) * 100) / 100 : base;
    let due: string | null = d.dueOn ?? null;
    if (due && cuotas > 1) {
      const [y, m, dd] = due.split("-").map(Number);
      const f = new Date(Date.UTC(y, m - 1 + (i - 1), dd));
      due = f.toISOString().slice(0, 10);
    }
    filas.push({
      company_id: ctx.companyId, counterparty_id: counterpartyId,
      concept: cuotas > 1 ? `${d.concept} · cuota ${i} de ${cuotas}` : d.concept,
      currency: d.currency.toUpperCase(), amount: monto, due_on: due,
      installment_no: cuotas > 1 ? i : null, notes: d.notes || null, created_by: ctx.userId,
    });
  }
  const { error } = await supabase.from("receivables").insert(filas);
  if (error) return { error: error.message };
  refrescar(d.empresa);
  return { ok: true, cuotas };
}

const CobrarSchema = z.object({
  empresa: empresaEnum,
  receivableId: z.string().uuid(),
  accountId: z.string().uuid(),
  amount: z.number().positive(),
  date: fecha,
});

export async function cobrarReceivable(input: z.infer<typeof CobrarSchema>) {
  const parsed = CobrarSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  await requireEmpresa(d.empresa);
  const supabase = await createClient();
  const { error } = await supabase.rpc("collect_receivable", {
    p_receivable_id: d.receivableId, p_account_id: d.accountId,
    p_amount: d.amount, p_date: d.date,
  });
  if (error) return { error: error.message };
  refrescar(d.empresa);
  return { ok: true };
}

// ---------------------------------------------------------------- impuestos
const ObligacionSchema = z.object({
  empresa: empresaEnum,
  taxName: z.string().trim().min(1).max(80),
  jurisdiction: z.string().trim().min(1).max(80),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  dueOn: fecha,
  amountEstimated: z.number().positive().optional(),
  amountFinal: z.number().positive().optional(),
});

export async function guardarObligacion(input: z.infer<typeof ObligacionSchema>) {
  const parsed = ObligacionSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  const { data: tax, error: eTax } = await supabase.from("taxes").upsert(
    { company_id: ctx.companyId, name: d.taxName, jurisdiction: d.jurisdiction },
    { onConflict: "company_id,name,jurisdiction" }
  ).select("id").single();
  if (eTax) return { error: eTax.message };

  const { error } = await supabase.from("tax_obligations").upsert({
    company_id: ctx.companyId, tax_id: tax.id, period: d.period, due_on: d.dueOn,
    amount_estimated: d.amountEstimated ?? null,
    amount_final: d.amountFinal ?? null,
    status: d.amountFinal ? "final" : "estimated",
  }, { onConflict: "company_id,tax_id,period" });
  if (error) return { error: error.message };
  refrescar(d.empresa);
  return { ok: true };
}

/** Pasa la obligación a "definitiva" y la manda a la bandeja de pagos. */
export async function obligacionAPagar(empresa: "mx" | "ar", obligacionId: string) {
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  const { data: ob } = await supabase.from("tax_obligations")
    .select("id, period, due_on, amount_final, amount_estimated, payable_id, tax:taxes(name, jurisdiction)")
    .eq("id", obligacionId).eq("company_id", ctx.companyId).maybeSingle();
  if (!ob) return { error: "La obligación no existe" };
  if (ob.payable_id) return { error: "Ya está en la bandeja de pagos" };

  const monto = Number(ob.amount_final ?? ob.amount_estimated ?? 0);
  if (monto <= 0) return { error: "Cargá el monto antes de mandarla a pagar" };

  const tax = ob.tax as unknown as { name: string; jurisdiction: string } | null;
  const { data: cat } = await supabase.from("categories").select("id")
    .eq("company_id", ctx.companyId).ilike("name", "%impuesto%").limit(1).maybeSingle();
  const { data: cia } = await supabase.from("companies").select("currencies")
    .eq("id", ctx.companyId).single();

  const { data: pay, error } = await supabase.from("payables").insert({
    company_id: ctx.companyId, source: "tax", source_id: ob.id,
    concept: `${tax?.name ?? "Impuesto"} ${ob.period}`,
    category_id: cat?.id ?? null,
    currency: (cia?.currencies as string[] | null)?.[0] ?? "ARS",
    amount: monto, due_on: ob.due_on, created_by: ctx.userId,
  }).select("id").single();
  if (error) return { error: error.message };

  await supabase.from("tax_obligations")
    .update({ payable_id: pay.id, status: "final" }).eq("id", ob.id);
  refrescar(empresa);
  return { ok: true };
}

// ----------------------------------------------------------- liquidaciones
/**
 * Vuelve una liquidación confirmada a borrador para poder recalcularla.
 *
 * La cuenta la hace reopen_settlement() en la base (0027/0028) y no acá: reabrir
 * toca payables, que el rol de la app no puede escribir a propósito ("las deudas
 * se anulan con status, nunca se borran"). La función anula la deuda, y
 * confirm_settlement sabe revivirla — así una liquidación se puede reabrir y
 * volver a confirmar sin chocar contra el unique de una deuda por liquidación.
 *
 * Una liquidación PAGADA no se reabre: la función la rechaza. Esa plata ya salió.
 */
export async function reabrirLiquidacion(empresa: "mx" | "ar", settlementId: string) {
  if (!empresaEnum.safeParse(empresa).success) return { error: "Datos inválidos" };
  await requireEmpresa(empresa);
  const supabase = await createClient();
  const { error } = await supabase.rpc("reopen_settlement", { p_settlement_id: settlementId });
  if (error) return { error: error.message };
  refrescar(empresa);
  revalidatePath(`/${empresa}/liquidaciones`);
  return { ok: true };
}

export async function confirmarLiquidacion(
  empresa: "mx" | "ar", settlementId: string, dueOn?: string
) {
  await requireEmpresa(empresa);
  const supabase = await createClient();
  const { error } = await supabase.rpc("confirm_settlement", {
    p_settlement_id: settlementId,
    p_due_on: dueOn ?? null,
  });
  if (error) return { error: error.message };
  refrescar(empresa);
  revalidatePath(`/${empresa}/liquidaciones`);
  return { ok: true };
}

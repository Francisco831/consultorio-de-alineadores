"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";

const CuentaSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  type: z.enum(["bank", "mercadopago", "cash", "external"]),
  currency: z.string().length(3),
  bankName: z.string().trim().max(80).optional(),
  includeInTotals: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

export async function guardarCuenta(input: z.infer<typeof CuentaSchema>) {
  const parsed = CuentaSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  if (d.id) {
    // la moneda de una cuenta con movimientos no se toca (lo garantiza la FK compuesta)
    const { error } = await supabase
      .from("accounts")
      .update({
        name: d.name, type: d.type, bank_name: d.bankName || null,
        include_in_totals: d.includeInTotals, is_active: d.isActive,
      })
      .eq("id", d.id)
      .eq("company_id", ctx.companyId);
    if (error) return { error: error.message };
  } else {
    const { error } = await supabase.from("accounts").insert({
      company_id: ctx.companyId,
      name: d.name, type: d.type, currency: d.currency.toUpperCase(),
      bank_name: d.bankName || null, include_in_totals: d.includeInTotals,
    });
    if (error) return { error: error.message };
  }
  revalidatePath(`/${d.empresa}/configuracion`);
  revalidatePath(`/${d.empresa}/hoy`);
  return { ok: true };
}

const CategoriaSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  name: z.string().trim().min(1).max(80),
  flow: z.enum(["income", "expense"]),
  costBehavior: z.enum(["fixed", "variable"]).nullable().optional(),
});

export async function crearCategoria(input: z.infer<typeof CategoriaSchema>) {
  const parsed = CategoriaSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();
  const { error } = await supabase.from("categories").insert({
    company_id: ctx.companyId,
    name: d.name, flow: d.flow, cost_behavior: d.costBehavior ?? null,
  });
  if (error) return { error: error.message };
  revalidatePath(`/${d.empresa}/configuracion/categorias`);
  return { ok: true };
}

export async function toggleCategoria(empresa: "mx" | "ar", id: string, activa: boolean) {
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  // las de sistema no se desactivan
  const { data: cat } = await supabase.from("categories").select("is_system")
    .eq("id", id).eq("company_id", ctx.companyId).maybeSingle();
  if (!cat) return { error: "Categoría inexistente" };
  if (cat.is_system && !activa) return { error: "Las categorías de sistema no se desactivan" };
  const { error } = await supabase.from("categories").update({ is_active: activa })
    .eq("id", id).eq("company_id", ctx.companyId);
  if (error) return { error: error.message };
  revalidatePath(`/${empresa}/configuracion/categorias`);
  return { ok: true };
}

"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";

const Schema = z.object({
  empresa: z.enum(["mx", "ar"]),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  categoryId: z.string().uuid(),
  currency: z.string().length(3),
  amount: z.number().min(0),
});

export async function guardarPresupuesto(input: z.infer<typeof Schema>) {
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();
  const { error } = await supabase.from("budgets").upsert({
    company_id: ctx.companyId, period: d.period, category_id: d.categoryId,
    currency: d.currency.toUpperCase(), amount: d.amount,
  }, { onConflict: "company_id,period,category_id,currency" });
  if (error) return { error: error.message };
  revalidatePath(`/${d.empresa}/presupuesto`);
  return { ok: true };
}

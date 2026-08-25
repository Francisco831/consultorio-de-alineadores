"use server";

// Listas de precios KS y porcentaje de cada doctora: los dos últimos datos del
// costeo que sólo se podían tocar por script.
//
// La lista es lo que el consultorio le paga a la fábrica por cada tratamiento,
// y cada caso paga la lista vigente CUANDO ENTRÓ (regla de Pancho, 24/8/26). Por
// eso las vigencias viejas no se borran nunca: son las que costean los casos
// viejos. Acá sólo se agrega una vigencia nueva o se corrige una existente.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";
import { recalcularLiquidaciones } from "@/lib/liquidaciones/recalcular";

const PrecioSchema = z.object({
  audience: z.string().trim().min(1).max(20),
  scope: z.string().trim().min(1).max(20),
  arcades: z.number().int().min(1).max(2),
  listPrice: z.number().positive(),
});

const VigenciaSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  discountPct: z.number().min(0).max(99),
  precios: z.array(PrecioSchema).min(1).max(60),
});

export async function guardarVigenciaPrecios(input: z.infer<typeof VigenciaSchema>) {
  const parsed = VigenciaSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  const { data: existentes } = await supabase
    .from("ks_price_list").select("id, audience, scope, arcades")
    .eq("company_id", ctx.companyId).eq("valid_from", d.validFrom);
  const idPorClave = new Map(
    (existentes ?? []).map((r) => [`${r.audience}/${r.scope}/${r.arcades}`, r.id as string])
  );

  // Se actualiza fila por fila en vez de borrar y reinsertar: un DELETE sobre
  // ks_price_list deja sin precio a todos los casos que entraron con esa lista
  // si algo falla en el medio.
  for (const p of d.precios) {
    const clave = `${p.audience}/${p.scope}/${p.arcades}`;
    const fila = {
      company_id: ctx.companyId, valid_from: d.validFrom,
      audience: p.audience, scope: p.scope, arcades: p.arcades,
      list_price: p.listPrice, discount_pct: d.discountPct,
    };
    const id = idPorClave.get(clave);
    const { error } = id
      ? await supabase.from("ks_price_list").update(fila).eq("id", id)
      : await supabase.from("ks_price_list").insert(fila);
    if (error) return { error: `${clave}: ${error.message}` };
  }

  try {
    const r = await recalcularLiquidaciones(supabase, ctx.companyId);
    revalidatePath(`/${d.empresa}/configuracion`);
    revalidatePath(`/${d.empresa}/liquidaciones`);
    return {
      ok: true,
      mensaje:
        `Lista del ${d.validFrom} guardada (${d.precios.length} precios) · ` +
        `${r.guardadas} liquidación${r.guardadas === 1 ? "" : "es"} recalculada${r.guardadas === 1 ? "" : "s"}` +
        (r.congeladas.length ? ` · ${r.congeladas.length} cerrada(s) sin tocar` : ""),
    };
  } catch (e) {
    return { error: `Lista guardada, pero el recálculo falló: ${(e as Error).message}` };
  }
}

const ProfesionalSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  counterpartyId: z.string().uuid(),
  settlementPct: z.number().min(0).max(100),
  settlesSeparately: z.boolean(),
  active: z.boolean(),
});

export async function guardarProfesional(input: z.infer<typeof ProfesionalSchema>) {
  const parsed = ProfesionalSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  const { error } = await supabase.from("professionals")
    .update({
      settlement_pct: d.settlementPct,
      settles_separately: d.settlesSeparately,
      active: d.active,
    })
    .eq("company_id", ctx.companyId).eq("counterparty_id", d.counterpartyId);
  if (error) return { error: error.message };

  // El % se congela en cada liquidación al guardarla, así que cambiarlo mueve
  // las abiertas y deja las cerradas como estaban. Se recalcula para que el
  // número nuevo se vea, en vez de esperar a que alguien apriete Recalcular.
  try {
    const r = await recalcularLiquidaciones(supabase, ctx.companyId);
    revalidatePath(`/${d.empresa}/configuracion`);
    revalidatePath(`/${d.empresa}/liquidaciones`);
    return {
      ok: true,
      mensaje: `Guardado · ${r.guardadas} liquidación${r.guardadas === 1 ? "" : "es"} recalculada${r.guardadas === 1 ? "" : "s"}` +
        (r.congeladas.length ? ` · ${r.congeladas.length} cerrada(s) sin tocar` : ""),
    };
  } catch (e) {
    return { error: `Guardado, pero el recálculo falló: ${(e as Error).message}` };
  }
}

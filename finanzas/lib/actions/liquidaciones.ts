"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";
import {
  recalcularLiquidaciones, periodoDeMovimiento, type MovimientoBase,
} from "@/lib/liquidaciones/recalcular";
import { estaCongelada } from "@/lib/liquidaciones/imputacion";

const empresaEnum = z.enum(["mx", "ar"]);
const periodoRe = z.string().regex(/^\d{4}-\d{2}$/);

function refrescar(empresa: string) {
  revalidatePath(`/${empresa}/liquidaciones`);
  for (const p of ["hoy", "pagar", "reportes", "pacientes"]) revalidatePath(`/${empresa}/${p}`);
}

/** Vuelve a calcular un mes con lo que hay hoy en el ledger. */
export async function recalcularPeriodo(empresa: "mx" | "ar", periodo: string) {
  if (!empresaEnum.safeParse(empresa).success || !periodoRe.safeParse(periodo).success) {
    return { error: "Datos inválidos" };
  }
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  try {
    const r = await recalcularLiquidaciones(supabase, ctx.companyId, { periodos: [periodo] });
    refrescar(empresa);
    return {
      ok: true,
      mensaje:
        `${r.guardadas} liquidación${r.guardadas === 1 ? "" : "es"} recalculada${r.guardadas === 1 ? "" : "s"}` +
        ` · ${r.items} línea${r.items === 1 ? "" : "s"}` +
        (r.congeladas.length ? ` · ${r.congeladas.length} congelada${r.congeladas.length === 1 ? "" : "s"} sin tocar` : "") +
        (r.anuladas.length ? ` · ${r.anuladas.length} anulada${r.anuladas.length === 1 ? "" : "s"} por quedarse sin cobros` : ""),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const ImputarSchema = z.object({
  empresa: empresaEnum,
  movementId: z.string().uuid(),
  // uuid de la profesional · "casa" = no se liquida a nadie · "caja" = respetar
  // la columna doctora de la caja (es lo mismo que no tener corrección, pero
  // deja constancia de que la línea se miró)
  destino: z.union([z.string().uuid(), z.literal("casa"), z.literal("caja")]),
  motivo: z.string().trim().max(200).optional(),
});

/**
 * Corrige a quién se le liquida un cobro y recalcula el mes en el acto.
 *
 * "casa" es el caso que motivó todo: la paciente sólo pasó a retirar sus
 * alineadores, no hubo trabajo profesional detrás y esa plata no se le liquida
 * a nadie. Elegir cualquier destino marca la línea como REVISADA: decidir ya es
 * revisar, y obligar a tildar además sería pedir dos gestos para una decisión.
 */
export async function imputarCobro(input: z.infer<typeof ImputarSchema>) {
  const parsed = ImputarSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const { empresa, movementId, destino, motivo } = parsed.data;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  const { data: mov } = await supabase.from("movements")
    .select("id, occurred_on, kind, amount, currency, meta, counterparties(display_name)")
    .eq("company_id", ctx.companyId).eq("id", movementId).maybeSingle();
  if (!mov) return { error: "El movimiento no existe" };
  const periodo = periodoDeMovimiento(mov as unknown as MovimientoBase);
  const doctoraCaja = (mov.meta as { doctora?: string } | null)?.doctora ?? "";

  // A quién le toca hoy y a quién le tocaría: si CUALQUIERA de las dos
  // liquidaciones de ese mes ya está confirmada o pagada, mover el cobro
  // cambiaría plata que ya se prometió. Se frena y se dice por qué.
  const { data: imp } = await supabase.from("settlement_imputations")
    .select("destino, professional_id, revisado")
    .eq("company_id", ctx.companyId).eq("movement_id", movementId).maybeSingle();
  const { data: profs } = await supabase.from("professionals")
    .select("counterparty_id, cp:counterparties!inner(display_name)").eq("company_id", ctx.companyId);
  const idPorNombre = new Map((profs ?? []).map((p) =>
    [(p.cp as unknown as { display_name: string }).display_name, p.counterparty_id as string]));
  const idDeLaCaja = idPorNombre.get(doctoraCaja) ?? null;

  const actualId = !imp || imp.destino === "caja"
    ? idDeLaCaja
    : (imp.professional_id as string | null);
  const destinoId = destino === "casa" ? null : destino === "caja" ? idDeLaCaja : destino;

  const afectadas = [...new Set([actualId, destinoId].filter(Boolean) as string[])];
  if (afectadas.length) {
    const { data: sets } = await supabase.from("professional_settlements")
      .select("status, professional:counterparties(display_name)")
      .eq("company_id", ctx.companyId).eq("period", periodo).in("professional_id", afectadas);
    const congelada = (sets ?? []).find((s) => estaCongelada(s.status as string));
    if (congelada) {
      const quien = (congelada.professional as unknown as { display_name?: string } | null)?.display_name ?? "esa doctora";
      return { error: `La liquidación de ${quien} de ${periodo} ya está ${congelada.status === "paid" ? "pagada" : "confirmada"}: no se puede mover un cobro de ese mes.` };
    }
  }

  const { error } = await supabase.from("settlement_imputations").upsert({
    company_id: ctx.companyId, movement_id: movementId,
    destino: destino === "casa" ? "casa" : destino === "caja" ? "caja" : "profesional",
    professional_id: destino === "casa" || destino === "caja" ? null : destino,
    reason: motivo ?? null, created_by: ctx.userId,
    revisado: true, revisado_at: new Date().toISOString(), revisado_by: ctx.userId,
  }, { onConflict: "movement_id" });
  if (error) return { error: error.message };

  try {
    await recalcularLiquidaciones(supabase, ctx.companyId, { periodos: [periodo] });
  } catch (e) {
    return { error: `Imputación guardada, pero el recálculo falló: ${(e as Error).message}` };
  }
  refrescar(empresa);
  return { ok: true, periodo };
}

const RevisarSchema = z.object({
  empresa: empresaEnum,
  movementId: z.string().uuid(),
  revisado: z.boolean(),
});

/**
 * Tilda (o destilda) una línea como revisada. NO mueve un peso: sólo deja dicho
 * "esta ya la miré y está bien como viene", para no volver a revisarla el mes
 * que viene. Por eso no recalcula nada.
 */
export async function marcarRevisado(input: z.infer<typeof RevisarSchema>) {
  const parsed = RevisarSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const { empresa, movementId, revisado } = parsed.data;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  const { data: mov } = await supabase.from("movements").select("id")
    .eq("company_id", ctx.companyId).eq("id", movementId).maybeSingle();
  if (!mov) return { error: "El movimiento no existe" };

  const { data: imp } = await supabase.from("settlement_imputations")
    .select("id, destino").eq("company_id", ctx.companyId).eq("movement_id", movementId).maybeSingle();

  const marca = {
    revisado,
    revisado_at: revisado ? new Date().toISOString() : null,
    revisado_by: revisado ? ctx.userId : null,
  };
  // Si la línea ya tenía una corrección se toca SÓLO el tilde: destildar no
  // puede devolverle un cobro a una doctora de la que Pancho lo había sacado.
  // Son dos decisiones distintas y perder plata por destildar sería una trampa.
  const { error } = imp
    ? await supabase.from("settlement_imputations").update(marca).eq("id", imp.id)
    : revisado
      ? await supabase.from("settlement_imputations").insert({
          company_id: ctx.companyId, movement_id: movementId,
          destino: "caja", professional_id: null, created_by: ctx.userId, ...marca,
        })
      : { error: null };   // nada que destildar
  if (error) return { error: error.message };

  refrescar(empresa);
  return { ok: true };
}

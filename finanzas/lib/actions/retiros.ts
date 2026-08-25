"use server";

// Retiros de los dueños: plata que sale de la caja para Pancho, o para Gaby y
// Germán. Es un egreso más del ledger, pero se anota por separado porque son la
// pregunta que uno se hace todos los meses ("¿cuánto saqué?") y porque no hay
// que confundirlos con los retiros de las DOCTORAS, que son a cuenta de su
// liquidación y sí le descuentan saldo a alguien.
//
// La diferencia la marca meta.tipo_origen: 'retiro_socio' acá,
// 'retiro_liquidacion' allá. Y estos movimientos NUNCA llevan meta.doctora —
// con doctora entrarían al cálculo de liquidaciones y le comerían el saldo a
// una profesional que no tiene nada que ver.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";
import { TIPO_RETIRO_SOCIO } from "@/lib/retiros";

const RetiroSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  quien: z.string().trim().min(2).max(120),
  amount: z.number().positive(),
  accountId: z.string().uuid(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nota: z.string().trim().max(300).optional(),
});

export async function registrarRetiro(input: z.infer<typeof RetiroSchema>) {
  const parsed = RetiroSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  // La moneda la manda la cuenta: un retiro en la caja de dólares es en dólares.
  const { data: cuenta } = await supabase
    .from("accounts").select("id, currency, name")
    .eq("id", d.accountId).eq("company_id", ctx.companyId).maybeSingle();
  if (!cuenta) return { error: "Cuenta inexistente" };

  // Una contraparte por persona, reutilizada: así "Pancho" es siempre el mismo
  // y los totales por quién retira salen solos.
  const { data: existente } = await supabase
    .from("counterparties").select("id")
    .eq("company_id", ctx.companyId).ilike("display_name", d.quien)
    .limit(1).maybeSingle();
  let counterpartyId = existente?.id as string | undefined;
  if (!counterpartyId) {
    const { data: creada, error } = await supabase
      .from("counterparties")
      .insert({ company_id: ctx.companyId, kind: "other", display_name: d.quien })
      .select("id").single();
    if (error) return { error: `No se pudo crear la contraparte: ${error.message}` };
    counterpartyId = creada.id as string;
  }

  const { error } = await supabase.from("movements").insert({
    company_id: ctx.companyId,
    account_id: cuenta.id,
    currency: cuenta.currency,
    kind: "expense",
    status: "confirmed",
    occurred_on: d.occurredOn,
    amount: d.amount,
    counterparty_id: counterpartyId,
    description: d.nota ? `Retiro ${d.quien} · ${d.nota}` : `Retiro ${d.quien}`,
    source: "manual",
    meta: { tipo_origen: TIPO_RETIRO_SOCIO, quien: d.quien },
    created_by: ctx.userId,
  });
  if (error) return { error: error.message };

  revalidatePath(`/${d.empresa}/retiros`);
  revalidatePath(`/${d.empresa}/movimientos`);
  revalidatePath(`/${d.empresa}/hoy`);
  return { ok: true };
}

/** Anula un retiro (el movimiento queda, con status void: la plata no se borra). */
export async function anularRetiro(empresa: "mx" | "ar", movementId: string) {
  if (!z.string().uuid().safeParse(movementId).success) return { error: "Datos inválidos" };
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  const { data: mov } = await supabase
    .from("movements").select("id, meta")
    .eq("id", movementId).eq("company_id", ctx.companyId).maybeSingle();
  if (!mov) return { error: "El movimiento no existe" };
  // Este botón sólo anula retiros: para cualquier otro egreso está Movimientos,
  // que tiene su propio circuito y sus propias advertencias.
  if ((mov.meta as { tipo_origen?: string } | null)?.tipo_origen !== TIPO_RETIRO_SOCIO) {
    return { error: "Ese movimiento no es un retiro" };
  }

  const { error } = await supabase
    .from("movements").update({ status: "void" }).eq("id", movementId);
  if (error) return { error: error.message };

  revalidatePath(`/${empresa}/retiros`);
  revalidatePath(`/${empresa}/movimientos`);
  return { ok: true };
}

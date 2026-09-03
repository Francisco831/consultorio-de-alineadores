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
        (r.anuladas.length ? ` · ${r.anuladas.length} anulada${r.anuladas.length === 1 ? "" : "s"} por quedarse sin cobros` : "") +
        // Un cobro que el cálculo querría mover pero sigue liquidado en una
        // cerrada: si no se dijera acá, el recálculo parecería haber funcionado
        // y ese cobro estaría en otra liquidación que la del panel muestra.
        (r.trabados.length
          ? ` · ⚠ ${r.trabados.length} cobro${r.trabados.length === 1 ? "" : "s"} no se movió: sigue${r.trabados.length === 1 ? "" : "n"} en una liquidación cerrada`
          : "") +
        // El dato existía desde siempre y el mensaje no lo decía: un cobro sin
        // costear se liquida al 40% del bruto, así que es lo más caro que puede
        // reportar este botón.
        (r.sinCostear
          ? ` · ⚠ ${r.sinCostear} cobro${r.sinCostear === 1 ? "" : "s"} sin costo KS (falta el precio pactado)`
          : "") +
        (r.huerfanas
          ? ` · ⚠ ${r.huerfanas} imputación${r.huerfanas === 1 ? "" : "es"} apunta${r.huerfanas === 1 ? "" : "n"} a un movimiento anulado`
          : ""),
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

// ---------------------------------------------------------------------------
// Poner una línea a mano (0030): corregir sus números, deshacer la corrección,
// o agregar una línea que la caja no tiene.
//
// POR QUÉ NO SE ESCRIBE SOBRE settlement_items. La liquidación se REESCRIBE
// entera en cada recálculo, y el recálculo no lo dispara sólo el botón:
// también guardar un pacto o tocar la lista de precios. Un número escrito en el
// resultado dura hasta que nadie lo esté mirando. Por eso vive en
// settlement_line_overrides, que el motor lee en calcularTodo().
// ---------------------------------------------------------------------------

const montoOpcional = z.number().nonnegative().nullable().optional();

const EditarLineaSchema = z.object({
  empresa: empresaEnum,
  movementId: z.string().uuid(),
  /** Lo cobrado de esa línea, en pesos. null = vale lo que dice la caja. */
  cobradoArs: montoOpcional,
  /** El costo KS de esa línea, en pesos. null = vale lo que calculó el costeo. */
  costoKsArs: montoOpcional,
  motivo: z.string().trim().min(3).max(300),
});

/**
 * La liquidación que hoy contiene ese cobro, si está cerrada. Es la misma
 * pregunta que hace imputarCobro() antes de mover un cobro de doctora: plata ya
 * confirmada o pagada no se toca desde acá, se reabre primero.
 *
 * Se pregunta DOS VECES a propósito. Lo natural es buscar el settlement_item del
 * cobro, pero hay liquidaciones cerradas SIN detalle: al 2/9/26 son siete
 * (Mónica enero a junio y Matelli enero), 307 cobros por ~$21,8M cuyo
 * movement_id no figura en ningún ítem — el agujero que la 0025 ya había
 * documentado ("las cerradas sin detalle no tienen línea, y justo ahí están los
 * cobros más grandes"). Para esos, preguntar por el ítem devuelve "no está
 * cerrada" y se podría editar a mano un mes ya pagado. Por eso, si no hay ítem,
 * se pregunta por el período y la doctora del cobro.
 */
async function liquidacionCerradaDe(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  mov: { id: string; meta: unknown; occurred_on: string; amount: string | number }
): Promise<string | null> {
  const cerrada = (s: { period: string; status: string; professional: { display_name?: string } | null }) =>
    `La liquidación de ${s.professional?.display_name ?? "esa doctora"} de ${s.period} ya está ` +
    `${s.status === "paid" ? "pagada" : "confirmada"}: reabrila antes de tocar la línea.`;

  const { data } = await supabase.from("settlement_items")
    .select("settlement:professional_settlements(period, status, professional:counterparties(display_name))")
    .eq("company_id", companyId).eq("movement_id", mov.id).maybeSingle();
  const s = (data?.settlement ?? null) as unknown as
    { period: string; status: string; professional: { display_name?: string } | null } | null;
  if (s) return estaCongelada(s.status) ? cerrada(s) : null;

  // Sin ítem: se busca la liquidación del mes de ese cobro para la doctora que
  // dice la caja (o la corrección de la 0022, que manda sobre ella).
  const periodo = periodoDeMovimiento(mov as unknown as MovimientoBase);
  const { data: imp } = await supabase.from("settlement_imputations")
    .select("destino, professional_id").eq("company_id", companyId)
    .eq("movement_id", mov.id).maybeSingle();
  let profId = (imp?.destino === "profesional" ? (imp.professional_id as string) : null) ?? null;
  if (imp?.destino === "casa") return null;                  // no se liquida a nadie
  if (!profId) {
    const doctoraCaja = (mov.meta as { doctora?: string } | null)?.doctora;
    if (!doctoraCaja) return null;
    const { data: cp } = await supabase.from("counterparties")
      .select("id").eq("company_id", companyId).eq("display_name", doctoraCaja).maybeSingle();
    profId = (cp?.id as string) ?? null;
  }
  if (!profId) return null;
  const { data: set } = await supabase.from("professional_settlements")
    .select("period, status, professional:counterparties(display_name)")
    .eq("company_id", companyId).eq("period", periodo).eq("professional_id", profId).maybeSingle();
  const s2 = (set ?? null) as unknown as
    { period: string; status: string; professional: { display_name?: string } | null } | null;
  return s2 && estaCongelada(s2.status) ? cerrada(s2) : null;
}

export async function editarLineaLiquidacion(input: z.infer<typeof EditarLineaSchema>) {
  const parsed = EditarLineaSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos: revisá los montos y el motivo" };
  const { empresa, movementId, cobradoArs, costoKsArs, motivo } = parsed.data;
  if (cobradoArs == null && costoKsArs == null) {
    return { error: "No hay nada que corregir: dejá al menos uno de los dos números" };
  }
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  const { data: mov } = await supabase.from("movements")
    .select("id, occurred_on, kind, amount, currency, meta, counterparties(display_name)")
    .eq("company_id", ctx.companyId).eq("id", movementId).maybeSingle();
  if (!mov) return { error: "El movimiento no existe" };
  const cerrada = await liquidacionCerradaDe(supabase, ctx.companyId, mov as never);
  if (cerrada) return { error: cerrada };

  const periodo = periodoDeMovimiento(mov as unknown as MovimientoBase);
  // Lo que el cálculo decía ANTES de la corrección. Se guarda con la fila para
  // poder mostrar el "de → a" en el panel sin volver a correr el motor (tarda
  // ~3 segundos) y para saber qué se había corregido el día que la caja edite
  // esa fila y el movimiento quede anulado.
  //
  // OJO con la SEGUNDA edición: para entonces el ítem ya tiene el número puesto
  // a mano, así que tomarlo de ahí haría que el panel diga "de $3.000.000 →
  // $3.200.000" como si los 3 millones los hubiera calculado el sistema. El
  // snapshot es el del cálculo original y no se pisa nunca.
  const { data: previo } = await supabase.from("settlement_line_overrides")
    .select("snapshot").eq("company_id", ctx.companyId)
    .eq("movement_id", movementId).maybeSingle();
  const { data: item } = await supabase.from("settlement_items")
    .select("base_amount, ks_cost").eq("company_id", ctx.companyId)
    .eq("movement_id", movementId).maybeSingle();
  const snapshotPrevio = (previo?.snapshot ?? null) as Record<string, unknown> | null;

  const { error } = await supabase.from("settlement_line_overrides").upsert({
    company_id: ctx.companyId,
    movement_id: movementId,
    collected_ars: cobradoArs ?? null,
    ks_cost_ars: costoKsArs ?? null,
    reason: motivo,
    status: "active",
    snapshot: snapshotPrevio && snapshotPrevio.cobrado_calculado !== undefined
      ? snapshotPrevio
      : {
          fecha: mov.occurred_on,
          paciente: (mov.counterparties as unknown as { display_name?: string } | null)?.display_name ?? null,
          doctora: (mov.meta as { doctora?: string } | null)?.doctora ?? null,
          periodo,
          monto_caja: Number(mov.amount),
          moneda: mov.currency,
          cobrado_calculado: item ? Number(item.base_amount) : null,
          costo_calculado: item ? Number(item.ks_cost) : null,
        },
    created_by: ctx.userId,
  }, { onConflict: "movement_id" });
  if (error) return { error: error.message };

  // TODOS los períodos, no el del cobro. El costo KS se acumula por CASO con
  // tope a lo largo del año: poner a mano el costo de una cuota deja en $0 las
  // cuotas siguientes del mismo paciente, y ésas viven en otros meses (29 de los
  // 61 pacientes de alineadores tienen cobros en más de un mes). Guardando sólo
  // este mes, los otros quedan con el número viejo hasta que alguien dispare un
  // recálculo completo —guardar un pacto, tocar la lista de precios— y ahí el
  // número de una doctora cambia solo, sin que nadie haya tocado ese mes. Es la
  // misma razón por la que guardarPacto() recalcula todo (lib/actions/pactos.ts).
  try {
    await recalcularLiquidaciones(supabase, ctx.companyId);
  } catch (e) {
    return { error: `Corrección guardada, pero el recálculo falló: ${(e as Error).message}` };
  }
  refrescar(empresa);
  return { ok: true, periodo };
}

/**
 * Volver atrás: la línea vuelve a valer lo que dice el cálculo.
 *
 * No se borra la fila. audit_row_changes() (0005) no registra los DELETE y en el
 * INSERT anota los valores en NULL: borrar dejaría la liquidación en otro número
 * sin ningún rastro de que alguna vez hubo un número a mano. Un update de status
 * sí queda anotado, con su valor viejo y el nuevo.
 */
export async function deshacerLineaLiquidacion(
  input: { empresa: "mx" | "ar"; movementId: string }
) {
  const parsed = z.object({ empresa: empresaEnum, movementId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const { empresa, movementId } = parsed.data;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  const { data: mov } = await supabase.from("movements")
    .select("id, occurred_on, kind, amount, currency, meta, counterparties(display_name)")
    .eq("company_id", ctx.companyId).eq("id", movementId).maybeSingle();
  if (!mov) return { error: "El movimiento no existe" };
  const cerrada = await liquidacionCerradaDe(supabase, ctx.companyId, mov as never);
  if (cerrada) return { error: cerrada };

  const { error } = await supabase.from("settlement_line_overrides")
    .update({ status: "void" })
    .eq("company_id", ctx.companyId).eq("movement_id", movementId).eq("status", "active");
  if (error) return { error: error.message };

  const periodo = periodoDeMovimiento(mov as unknown as MovimientoBase);
  // Completo por lo mismo que al guardar: sacar un costo a mano devuelve su
  // share a las cuotas siguientes del caso, que están en otros meses.
  try {
    await recalcularLiquidaciones(supabase, ctx.companyId);
  } catch (e) {
    return { error: `Corrección deshecha, pero el recálculo falló: ${(e as Error).message}` };
  }
  refrescar(empresa);
  return { ok: true, periodo };
}

/** Orden de una línea que no vino de la caja: después de cualquier fila real. */
const SEQ_A_MANO = 900000;

const AgregarLineaSchema = z.object({
  empresa: empresaEnum,
  profesionalId: z.string().uuid(),
  periodo: periodoRe,
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paciente: z.string().trim().min(2).max(200),
  concepto: z.string().trim().min(3).max(300),
  monto: z.number().positive(),
  cuentaId: z.string().uuid(),
  /** Es una cuota de alineadores: entonces tiene que pasar por el costeo KS. */
  esAlineadores: z.boolean(),
});

/**
 * Agregar a la liquidación un cobro que la caja no tiene.
 *
 * La línea NO se inventa en la liquidación: se carga el cobro en el ledger —un
 * movimiento manual, que es por donde entra toda la plata de este sistema— y se
 * le imputa la doctora con la tabla de la 0022. Así el cobro aparece en la
 * caja, en el saldo de la cuenta y en la conciliación, que es lo que tiene que
 * pasar cuando entró plata de verdad. Si la plata NO entró, esto no es lo que
 * hay que usar.
 */
export async function agregarLineaLiquidacion(input: z.infer<typeof AgregarLineaSchema>) {
  const parsed = AgregarLineaSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos: revisá la fecha, el monto y el concepto" };
  const d = parsed.data;
  if (d.fecha.slice(0, 7) !== d.periodo) {
    return { error: `La fecha tiene que caer en ${d.periodo}: el mes de la liquidación lo decide la fecha del cobro` };
  }
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  const { data: prof } = await supabase.from("professionals")
    .select("counterparty_id, cp:counterparties!inner(display_name)")
    .eq("company_id", ctx.companyId).eq("counterparty_id", d.profesionalId).maybeSingle();
  if (!prof) return { error: "Esa profesional no existe" };
  const doctora = (prof.cp as unknown as { display_name: string }).display_name;

  const { data: sett } = await supabase.from("professional_settlements")
    .select("status").eq("company_id", ctx.companyId)
    .eq("period", d.periodo).eq("professional_id", d.profesionalId).maybeSingle();
  if (sett && estaCongelada(sett.status as string)) {
    return { error: `La liquidación de ${doctora} de ${d.periodo} ya está ${sett.status === "paid" ? "pagada" : "confirmada"}: reabrila antes de agregarle una línea.` };
  }

  const { data: cuenta } = await supabase.from("accounts")
    .select("id, currency").eq("company_id", ctx.companyId).eq("id", d.cuentaId).maybeSingle();
  if (!cuenta) return { error: "Cuenta inexistente" };

  // El paciente se busca por nombre y se crea si no está, igual que en el alta
  // rápida de un movimiento (lib/actions/movimientos.ts).
  const { data: existente } = await supabase.from("counterparties")
    .select("id").eq("company_id", ctx.companyId)
    .ilike("display_name", d.paciente).limit(1).maybeSingle();
  let pacienteId = existente?.id as string | undefined;
  if (!pacienteId) {
    const { data: creado, error: eCp } = await supabase.from("counterparties")
      .insert({ company_id: ctx.companyId, kind: "patient", display_name: d.paciente })
      .select("id").single();
    if (eCp) return { error: `No se pudo crear el paciente: ${eCp.message}` };
    pacienteId = creado.id as string;
  }

  const { data: nuevo, error: eMov } = await supabase.from("movements").insert({
    company_id: ctx.companyId,
    account_id: cuenta.id,
    currency: cuenta.currency,
    kind: "income",
    status: "confirmed",
    occurred_on: d.fecha,
    amount: d.monto,
    counterparty_id: pacienteId,
    description: d.concepto,
    // El motivo es lo que la doctora lee en su detalle: el label de la línea lo
    // arma filaDeItem() desde meta.motivo, no desde description.
    //
    // categoria_origen decide si el cobro pasa por el costeo KS. Sin ella, una
    // cuota de alineadores cargada acá entraría con costo $0 y se liquidaría el
    // 40% del BRUTO — el mismo agujero de $655.440 que abrió esta pantalla. Con
    // ella, o se costea sola, o cae en el cartel de "cobros sin costo KS", que
    // es donde tiene que estar hasta que alguien le ponga precio.
    //
    // meta.seq es obligatorio para los cobros de alineadores: calcularTodo()
    // frena si falta (el orden de la caja decide qué cuota define el pacto). Un
    // cobro que no vino de la caja no tiene fila, así que va con un número alto
    // para que ordene después de todos los de ese día.
    meta: {
      motivo: d.concepto, tipo_origen: "cobro", doctora, agregado_a_mano: true,
      ...(d.esAlineadores ? { categoria_origen: "Alineadores", seq: SEQ_A_MANO } : {}),
    },
    source: "manual",
    created_by: ctx.userId,
  }).select("id").single();
  if (eMov) return { error: eMov.message };

  // La doctora se fija por imputación y no sólo por meta.doctora: es la capa
  // que el motor respeta siempre, y deja la decisión escrita y reversible.
  const { error: eImp } = await supabase.from("settlement_imputations").insert({
    company_id: ctx.companyId, movement_id: nuevo.id,
    destino: "profesional", professional_id: d.profesionalId,
    reason: "línea agregada a mano desde Liquidaciones", created_by: ctx.userId,
    revisado: true, revisado_at: new Date().toISOString(), revisado_by: ctx.userId,
  });
  if (eImp) return { error: `Cobro cargado, pero no se pudo imputar: ${eImp.message}` };

  // Completo: si es una cuota de alineadores, entra al costeo del caso y puede
  // mover el costo de las cuotas de otros meses (el tope se acumula por caso).
  try {
    await recalcularLiquidaciones(supabase, ctx.companyId);
  } catch (e) {
    return { error: `Cobro cargado, pero el recálculo falló: ${(e as Error).message}` };
  }
  refrescar(d.empresa);
  revalidatePath(`/${d.empresa}/movimientos`);
  return { ok: true };
}

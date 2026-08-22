// Tools de CONDICIONES COMERCIALES (migración 0022, tabla commercial_offers).
//
// Regla de la casa: precios, descuentos y campañas cambian, así que NO viven en
// el prompt. La única fuente autorizada de un incentivo es esta tabla. Si no hay
// fila vigente, el agente NO inventa: responde "no hay una condición comercial
// vigente configurada". Los porcentajes que aparecen en el Brain (escalera de
// categorías, esquemas históricos de arranque) son historia documentada, NO
// cotizables a un doctor.
//
// La tabla está VACÍA a propósito: el descuento de arranque de México sigue sin
// resolverse. Mientras siga vacía, la respuesta correcta es "no hay oferta".

import { z } from "zod";
import { createAiReadClient } from "@/lib/ai/read-client";
import { toStrictJsonSchema } from "@/lib/ai/schemas";
import { todayMX } from "@/lib/dates";
import type { AiToolDef, AiToolResult } from "@/lib/ai/types";

const MAX_ROWS = 50;

/** Texto EXACTO que el agente debe usar cuando no hay condición vigente. */
export const SIN_OFERTA_VIGENTE = "no hay una condición comercial vigente configurada";

const NO_NUMBER_RULE =
  "PROHIBIDO citar cualquier porcentaje, precio, cuota o condición de pago que no salga de esta respuesta — incluidos los números que figuren en el Brain (escalera de categorías, esquemas de arranque, campañas históricas): son historia documentada, no ofertas cotizables.";

function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.output<S>) => Promise<AiToolResult>;
}): AiToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: toStrictJsonSchema(def.schema),
    handler: async (args) => def.handler(def.schema.parse(args)),
  };
}

function bail(message: string): never {
  throw new Error(message);
}

interface OfferRow {
  id: string;
  market: string;
  name: string;
  offer_type: string;
  lifecycle_stage: string | null;
  percentage: number | string | null;
  amount_mxn: number | string | null;
  valid_from: string | null;
  valid_to: string | null;
  conditions: string | null;
  requires_approval: boolean;
  notes: string | null;
}

/** La ventana cubre hoy: extremos nulos = sin límite (fechas YYYY-MM-DD, comparación lexicográfica exacta). */
function coversToday(o: OfferRow, today: string): boolean {
  if (o.valid_from != null && o.valid_from.slice(0, 10) > today) return false;
  if (o.valid_to != null && o.valid_to.slice(0, 10) < today) return false;
  return true;
}

export const getActiveCommercialOffers = defineTool({
  name: "getActiveCommercialOffers",
  description:
    "Condiciones comerciales VIGENTES hoy configuradas en el CRM (tabla commercial_offers) para un mercado y, opcionalmente, una etapa del lifecycle. OBLIGATORIO: llámala ANTES de mencionar cualquier incentivo — descuento, promoción, campaña, bonificación, condición de arranque, de reactivación o de categoría. Es la ÚNICA fuente autorizada de un número comercial. Si devuelve hay_oferta_vigente=false, la respuesta al usuario es literalmente \"no hay una condición comercial vigente configurada\" + proponer confirmarlo con dirección comercial, y NUNCA un porcentaje. Si devuelve ofertas, cita solo esas y aclara cuando requieren aprobación.",
  schema: z.strictObject({
    market: z
      .string()
      .nullish()
      .describe("mercado (default 'MX'). El CRM es de México: usar otro mercado con un doctor mexicano viola el firewall de país"),
    lifecycle_stage: z
      .string()
      .nullish()
      .describe(
        "etapa del lifecycle a la que apunta la oferta (ej. 'en_activacion', 'dormido'). Las ofertas sin etapa aplican a todas y siempre se devuelven"
      ),
  }),
  handler: async ({ market, lifecycle_stage }) => {
    const supabase = await createAiReadClient();
    const today = todayMX();
    const mercado = (market ?? "MX").trim().toUpperCase() || "MX";
    const etapa = lifecycle_stage?.trim().toLowerCase() || null;

    const { data, error } = await supabase
      .from("commercial_offers")
      .select(
        "id, market, name, offer_type, lifecycle_stage, percentage, amount_mxn, valid_from, valid_to, conditions, requires_approval, notes"
      )
      .eq("active", true)
      .eq("market", mercado)
      .order("lifecycle_stage", { ascending: true, nullsFirst: true })
      .order("name", { ascending: true })
      .limit(MAX_ROWS);

    // Un error de lectura NO es "no hay oferta": afirmar que no hay condición
    // vigente cuando en realidad no se pudo leer es exactamente el error que
    // esta capa existe para evitar.
    if (error)
      bail(
        `No se pudieron leer las condiciones comerciales configuradas: ${error.message}. NO afirmes que no hay oferta vigente: el dato no se pudo consultar.`
      );

    const activas = (data ?? []) as OfferRow[];
    const vigentes = activas.filter((o) => coversToday(o, today));
    const aplicables = etapa
      ? vigentes.filter(
          (o) => o.lifecycle_stage == null || o.lifecycle_stage.trim().toLowerCase() === etapa
        )
      : vigentes;

    const base = {
      consultado_al: today,
      mercado,
      etapa_consultada: etapa,
      ...(mercado !== "MX"
        ? {
            advertencia_firewall:
              "Mercado distinto de MX: el firewall de país prohíbe usar condiciones de otro país con un doctor mexicano.",
          }
        : {}),
    };

    if (aplicables.length === 0) {
      const motivo =
        activas.length === 0
          ? `No hay ninguna oferta activa configurada para el mercado ${mercado}.`
          : vigentes.length === 0
            ? `Hay ${activas.length} oferta(s) configurada(s) para ${mercado}, pero ninguna con ventana de vigencia que cubra hoy (${today}).`
            : `Hay ${vigentes.length} oferta(s) vigente(s) para ${mercado}, pero ninguna aplica a la etapa "${etapa}".`;
      return {
        data: {
          ...base,
          hay_oferta_vigente: false,
          ofertas: [],
          motivo,
          etapas_con_oferta_vigente: [
            ...new Set(vigentes.map((o) => o.lifecycle_stage ?? "todas")),
          ],
          respuesta_autorizada: SIN_OFERTA_VIGENTE,
          instruccion: `Dilo con esas palabras ("${SIN_OFERTA_VIGENTE}") y propón confirmar el esquema con dirección comercial. ${NO_NUMBER_RULE}`,
        },
        rows: 0,
      };
    }

    return {
      data: {
        ...base,
        hay_oferta_vigente: true,
        ofertas: aplicables.map((o) => ({
          nombre: o.name,
          tipo: o.offer_type,
          etapa: o.lifecycle_stage ?? "todas",
          porcentaje: o.percentage == null ? null : Number(o.percentage),
          monto_mxn: o.amount_mxn == null ? null : Number(o.amount_mxn),
          vigente_desde: o.valid_from,
          vigente_hasta: o.valid_to,
          condiciones: o.conditions,
          requiere_aprobacion: o.requires_approval,
          notas: o.notes,
        })),
        instruccion: `Cita ÚNICAMENTE estas condiciones, tal cual están configuradas (nombre, porcentaje o monto en MXN, y condiciones), y siempre junto con sus condiciones. Si requiere_aprobacion es true, di explícitamente que queda sujeta a aprobación de dirección comercial y no la presentes como cerrada. ${NO_NUMBER_RULE}`,
      },
      rows: aplicables.length,
    };
  },
});

export const OFFER_TOOLS: AiToolDef[] = [getActiveCommercialOffers];

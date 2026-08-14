// Puerta de entrada única de /api/ai/*: quién puede invocar agentes y hasta
// cuánto se puede gastar en un día.
//
// Por qué existe:
//  1. El chequeo de sesión + rol estaba copiado tres veces (analyze y ask
//     literalmente idénticos, brief con su propio helper local). Si mañana cambia
//     la regla hay que acertar en tres lugares, y olvidarse de uno deja un
//     endpoint con la regla vieja.
//  2. No había NINGÚN límite de gasto. Cada corrida cuesta dinero real —medido:
//     ~USD 0,42 por análisis de doctor con effort high— y hasta el 13/8/2026 un
//     solo usuario podía generar cientos de dólares en una tarde sin que nada lo
//     frenara ni lo avisara. El costo ya se calculaba y se persistía en
//     agent_runs.cost_usd; simplemente nadie lo leía para decidir.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAiServiceClient, aiConfigured } from "@/lib/ai/db";
import { todayMX } from "@/lib/dates";
import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Corta-corriente de gasto diario, en USD. No es un presupuesto de negocio: es el
 * freno que evita que un bucle, un doble click insistente o una tarde entusiasta
 * se descubran recién en la factura. Se sube con AI_DAILY_BUDGET_USD.
 */
export const AI_DAILY_BUDGET_USD = (() => {
  const v = process.env.AI_DAILY_BUDGET_USD?.trim();
  if (!v) return 25;
  const n = Number(v);
  // Igual que AI_EFFORT: se falla al arrancar en vez de caer a un default en
  // silencio. Un tope mal escrito es peor que no tener tope, porque da confianza.
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`AI_DAILY_BUDGET_USD="${v}" no es un número positivo.`);
  }
  return n;
})();

/** Cota de la pregunta libre de Ask CRM. Cada carácter es tokens y plata. */
export const MAX_PREGUNTA_CHARS = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export type Invocador = { supabase: SupabaseClient; user: User };
export type Guard<T> = { ok: true; invocador: T } | { ok: false; res: NextResponse };

/**
 * Sesión + rol. Es lo que necesita un endpoint que solo LEE lo que la capa AI ya
 * dejó escrito (por ejemplo el GET del brief, que devuelve el último persistido):
 * no llama al modelo, así que no corresponde exigirle clave ni presupuesto.
 */
export async function requireSession(): Promise<Guard<Invocador>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "No autenticado" }, { status: 401 }) };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user.id)
    .single();
  if (!profile || profile.rol === "VIEWER") {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "Tu rol no tiene permisos para invocar agentes" },
        { status: 403 }
      ),
    };
  }

  return { ok: true, invocador: { supabase, user } };
}

/**
 * Lo anterior + clave del modelo + presupuesto del día. Es lo que tiene que pasar
 * todo endpoint que vaya a GASTAR: analyze, ask y el POST del brief.
 */
export async function requireAgentInvoker(): Promise<Guard<Invocador>> {
  const sesion = await requireSession();
  if (!sesion.ok) return sesion;

  if (!aiConfigured()) {
    return {
      ok: false,
      res: NextResponse.json({ error: "Falta ANTHROPIC_API_KEY" }, { status: 503 }),
    };
  }

  const gasto = await gastoDeHoyUSD();
  if (gasto != null && gasto >= AI_DAILY_BUDGET_USD) {
    return {
      ok: false,
      res: NextResponse.json(
        {
          error:
            `Se alcanzó el tope de gasto de IA del día ` +
            `(USD ${gasto.toFixed(2)} de ${AI_DAILY_BUDGET_USD}). ` +
            `Vuelve a habilitarse mañana, o se sube con AI_DAILY_BUDGET_USD.`,
        },
        { status: 429 }
      ),
    };
  }

  return sesion;
}

/**
 * Lo gastado hoy según agent_runs, en huso de México (el mismo corte de día que
 * usa el resto del CRM, para que "hoy" signifique lo mismo en todas partes).
 *
 * Devuelve null si la consulta falla: un problema para LEER el gasto no puede
 * dejar la capa AI caída — se prefiere seguir y que el tope no aplique esta vez,
 * antes que bloquear el trabajo del equipo por un error de lectura.
 */
export async function gastoDeHoyUSD(): Promise<number | null> {
  try {
    const db = createAiServiceClient();
    const { data, error } = await db
      .from("agent_runs")
      .select("cost_usd")
      .gte("created_at", `${todayMX()}T00:00:00-06:00`);
    if (error) return null;
    return (data ?? []).reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
  } catch {
    return null;
  }
}

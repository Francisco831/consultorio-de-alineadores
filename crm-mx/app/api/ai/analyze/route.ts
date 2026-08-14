// POST /api/ai/analyze — corre el orchestrator sobre un doctor (Doctor 360).
// Sesión, rol, clave y tope de gasto: lib/ai/guard.ts (una sola regla para las 3 rutas).

import { NextResponse } from "next/server";
import { requireAgentInvoker, esUuid } from "@/lib/ai/guard";
import { analyzeDoctor } from "@/lib/ai/orchestrator";

export const maxDuration = 300;

export async function POST(request: Request) {
  const guard = await requireAgentInvoker();
  if (!guard.ok) return guard.res;
  const { user } = guard.invocador;

  let doctorId = "";
  try {
    const body = (await request.json()) as { doctorId?: unknown };
    doctorId = String(body?.doctorId ?? "").trim();
  } catch {
    // body inválido → cae al 400 de abajo
  }
  if (!doctorId) {
    return NextResponse.json({ error: "Falta doctorId" }, { status: 400 });
  }
  // Se valida acá y no en Postgres: un id con formato inválido volvía como 500 con
  // el mensaje crudo del driver, que no le sirve a nadie y expone el error interno.
  if (!esUuid(doctorId)) {
    return NextResponse.json({ error: "doctorId no es un UUID" }, { status: 400 });
  }

  try {
    const assessment = await analyzeDoctor(doctorId, {
      requestedBy: user.id,
      trigger: "doctor360",
    });
    return NextResponse.json(assessment);
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Error inesperado al analizar el doctor";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

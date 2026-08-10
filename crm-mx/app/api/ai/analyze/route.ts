// POST /api/ai/analyze — corre el orchestrator sobre un doctor (Doctor 360).
// Auth adentro del handler (además del proxy): sesión Supabase + rol ≠ VIEWER.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { aiConfigured } from "@/lib/ai/db";
import { analyzeDoctor } from "@/lib/ai/orchestrator";

export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user.id)
    .single();
  if (!profile || profile.rol === "VIEWER") {
    return NextResponse.json(
      { error: "Tu rol no tiene permisos para invocar agentes" },
      { status: 403 }
    );
  }
  if (!aiConfigured()) {
    return NextResponse.json({ error: "Falta ANTHROPIC_API_KEY" }, { status: 503 });
  }

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

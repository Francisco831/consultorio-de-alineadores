// POST /api/ai/ask — Ask Your CRM: pregunta libre al commercial_director.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { aiConfigured } from "@/lib/ai/db";
import { askDirector } from "@/lib/ai/director";

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

  let question = "";
  try {
    const body = (await request.json()) as { question?: unknown };
    question = String(body?.question ?? "").trim();
  } catch {
    // body inválido → cae al 400 de abajo
  }
  if (!question) {
    return NextResponse.json({ error: "Falta la pregunta" }, { status: 400 });
  }

  try {
    const brief = await askDirector(question, { requestedBy: user.id });
    return NextResponse.json(brief);
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Error inesperado al responder la pregunta";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

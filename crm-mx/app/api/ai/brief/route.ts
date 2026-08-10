// /api/ai/brief — AI Morning Brief del commercial_director.
// POST genera uno nuevo (LLM); GET devuelve el último persistido en agent_runs.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { aiConfigured } from "@/lib/ai/db";
import { generateMorningBrief } from "@/lib/ai/director";
import type { SupabaseClient, User } from "@supabase/supabase-js";

export const maxDuration = 300;

async function authorize(): Promise<
  { supabase: SupabaseClient; user: User } | { response: NextResponse }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      response: NextResponse.json({ error: "No autenticado" }, { status: 401 }),
    };
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user.id)
    .single();
  if (!profile || profile.rol === "VIEWER") {
    return {
      response: NextResponse.json(
        { error: "Tu rol no tiene permisos para invocar agentes" },
        { status: 403 }
      ),
    };
  }
  return { supabase, user };
}

export async function POST() {
  const auth = await authorize();
  if ("response" in auth) return auth.response;
  if (!aiConfigured()) {
    return NextResponse.json({ error: "Falta ANTHROPIC_API_KEY" }, { status: 503 });
  }
  try {
    const { brief, runId } = await generateMorningBrief({
      requestedBy: auth.user.id,
    });
    return NextResponse.json({ brief, runId });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Error inesperado al generar el brief";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  const auth = await authorize();
  if ("response" in auth) return auth.response;
  const { data, error } = await auth.supabase
    .from("agent_runs")
    .select("id, result, created_at")
    .eq("agent", "commercial_director")
    .eq("trigger", "hoy")
    .eq("status", "ok")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data?.result) {
    return NextResponse.json({ brief: null });
  }
  return NextResponse.json({
    brief: data.result,
    runId: data.id,
    created_at: data.created_at,
  });
}

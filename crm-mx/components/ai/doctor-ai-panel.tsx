// Panel "Inteligencia comercial" del Doctor 360 (server component).
// Reemplaza la card "Próxima acción recomendada": el motor determinístico
// sigue visible adentro ("Motor de reglas sugiere…") y arriba va la capa AI:
// ai_summary del orchestrator, agentes involucrados, recomendaciones con
// Aceptar/Descartar y el perfil cualitativo del doctor.

import { createClient } from "@/lib/supabase/server";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { AgentBadge } from "@/components/ai/agent-badge";
import { AnalyzeButton } from "@/components/ai/analyze-button";
import { RecommendationCard } from "@/components/ai/recommendation-card";
import { relativeDays } from "@/lib/format";
import {
  AGENT_LABELS,
  type AgentKey,
  type AgentRunRow,
  type AiRecommendationRow,
  type DoctorAiProfileFields,
  type DoctorAiProfileRow,
} from "@/lib/ai/types";
import type { PriorityReason, RecommendedAction } from "@/lib/types";

const PROFILE_FIELDS: { key: keyof DoctorAiProfileFields; label: string }[] = [
  { key: "experience_with_aligners", label: "Experiencia con alineadores" },
  { key: "clinical_confidence", label: "Confianza clínica" },
  { key: "main_concerns", label: "Preocupaciones principales" },
  { key: "preferred_contact_style", label: "Estilo de contacto preferido" },
  { key: "business_goals", label: "Objetivos de negocio" },
  { key: "growth_ambition", label: "Ambición de crecimiento" },
  { key: "known_objections", label: "Objeciones conocidas" },
  { key: "competitor_relationship", label: "Relación con competencia" },
  { key: "previous_bad_experiences", label: "Malas experiencias previas" },
  { key: "relationship_notes", label: "Notas de la relación" },
  { key: "team_readiness", label: "Equipo del consultorio" },
  { key: "patient_acquisition_problem", label: "Captación de pacientes" },
  { key: "education_needs", label: "Necesidades de formación" },
];

function isAgentKey(x: unknown): x is AgentKey {
  return typeof x === "string" && x in AGENT_LABELS;
}

export async function DoctorAIPanel({ doctorId }: { doctorId: string }) {
  const supabase = await createClient();

  const [
    { data: doctorRow },
    { data: proposedRaw },
    { data: decidedRaw },
    { data: profileRaw },
    { data: runsRaw },
  ] = await Promise.all([
    supabase
      .from("doctors")
      .select("recommended_action, priority_reasons")
      .eq("id", doctorId)
      .maybeSingle(),
    supabase
      .from("ai_recommendations")
      .select("*")
      .eq("doctor_id", doctorId)
      .eq("status", "propuesta")
      .order("commercial_priority", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("ai_recommendations")
      .select("*")
      .eq("doctor_id", doctorId)
      .neq("status", "propuesta")
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("doctor_ai_profile")
      .select("*")
      .eq("doctor_id", doctorId)
      .maybeSingle(),
    supabase
      .from("agent_runs")
      .select("*")
      .eq("doctor_id", doctorId)
      .eq("agent", "orchestrator")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const proposed = (proposedRaw ?? []) as AiRecommendationRow[];
  const decided = (decidedRaw ?? []) as AiRecommendationRow[];
  const profile = (profileRaw ?? null) as DoctorAiProfileRow | null;
  const lastRun = ((runsRaw ?? []) as AgentRunRow[])[0] ?? null;

  // el assessment del orchestrator queda persistido en agent_runs.result
  const result = (lastRun?.result ?? null) as {
    ai_summary?: unknown;
    involvements?: { agent?: unknown; reason?: unknown }[];
  } | null;
  const aiSummary =
    typeof result?.ai_summary === "string" ? result.ai_summary : null;
  const involvements = (result?.involvements ?? [])
    .filter((i) => isAgentKey(i.agent))
    .map((i) => ({
      agent: i.agent as AgentKey,
      reason: typeof i.reason === "string" ? i.reason : undefined,
    }));

  const recommendedAction =
    (doctorRow?.recommended_action ?? null) as RecommendedAction | null;
  const reasons = ((doctorRow?.priority_reasons ?? []) as PriorityReason[]) ?? [];

  const profileEntries = profile
    ? PROFILE_FIELDS.map((f) => ({ ...f, value: profile[f.key] })).filter(
        (e) =>
          e.value != null &&
          e.value !== "" &&
          !(e.key === "clinical_confidence" && e.value === "desconocida")
      )
    : [];

  return (
    <Card size="sm">
      <Toaster position="bottom-right" />
      <CardHeader>
        <CardTitle>Inteligencia comercial</CardTitle>
        <CardAction>
          <AnalyzeButton doctorId={doctorId} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ---------- resumen AI + agentes involucrados ---------- */}
        {aiSummary ? (
          <div className="space-y-2">
            <p className="text-sm">{aiSummary}</p>
            {involvements.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1">
                {involvements.map((i) => (
                  <AgentBadge key={i.agent} agent={i.agent} title={i.reason} />
                ))}
              </div>
            ) : null}
            {lastRun ? (
              <p className="text-[11px] text-muted-foreground">
                Último análisis: {relativeDays(lastRun.created_at)}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Todavía sin análisis. Tocá «Analizar con AI» para que los agentes
            evalúen a este doctor.
          </p>
        )}

        {/* ---------- motor determinístico (recompute_doctor) ---------- */}
        {recommendedAction || reasons.length > 0 ? (
          <div className="rounded-lg border bg-muted/40 p-3">
            {recommendedAction ? (
              <p className="text-sm font-medium">
                Motor de reglas sugiere: {recommendedAction.label}
              </p>
            ) : null}
            {reasons.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                {reasons.map((r) => (
                  <li key={r.code}>• {r.text}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* ---------- recomendaciones propuestas (HITL) ---------- */}
        {proposed.length > 0 ? (
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Recomendaciones ({proposed.length})
            </p>
            {proposed.map((rec) => (
              <RecommendationCard key={rec.id} rec={rec} />
            ))}
          </div>
        ) : null}

        {/* ---------- últimas decisiones ---------- */}
        {decided.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer select-none text-muted-foreground">
              Decisiones recientes ({decided.length})
            </summary>
            <div className="mt-2 space-y-2">
              {decided.map((rec) => (
                <RecommendationCard key={rec.id} rec={rec} />
              ))}
            </div>
          </details>
        ) : null}

        {/* ---------- perfil cualitativo (memoria controlada) ---------- */}
        {profileEntries.length > 0 ? (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Perfil AI del doctor
            </p>
            <dl className="mt-1.5 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
              {profileEntries.map((e) => (
                <div key={e.key}>
                  <dt className="text-xs text-muted-foreground">{e.label}</dt>
                  <dd>{e.value}</dd>
                </div>
              ))}
            </dl>
            {profile ? (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Actualizado {relativeDays(profile.updated_at)} ·{" "}
                {profile.last_source === "humano"
                  ? "input humano"
                  : "propuesta AI confirmada"}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  recalcularScores,
  ejecutarAutomatizaciones,
  purgarDemo,
  toggleRegla,
  guardarObjetivo,
} from "@/lib/actions/admin";
import { formatDate } from "@/lib/format";
import { AgentBadge } from "@/components/ai/agent-badge";
import { BRAIN_VERSION } from "@/lib/ai/brain";
import { AI_MODEL, aiConfigured } from "@/lib/ai/db";
import type {
  AgentRunRow,
  AgentRunTrigger,
  RecommendationStatus,
} from "@/lib/ai/types";

const REC_STATUSES: RecommendationStatus[] = [
  "propuesta",
  "aceptada",
  "descartada",
  "ejecutada",
  "expirada",
];

const REC_STATUS_LABELS: Record<RecommendationStatus, string> = {
  propuesta: "Propuestas",
  aceptada: "Aceptadas",
  descartada: "Descartadas",
  ejecutada: "Ejecutadas",
  expirada: "Expiradas",
};

const TRIGGER_LABELS: Record<AgentRunTrigger, string> = {
  doctor360: "Doctor 360",
  hoy: "Hoy",
  ask: "Ask CRM",
  manual: "Manual",
};

interface Rule {
  id: string;
  key: string;
  nombre: string;
  descripcion: string | null;
  enabled: boolean;
  params: Record<string, unknown>;
  last_run_at: string | null;
}

export default async function AjustesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user!.id)
    .single();
  const isManager = ["ADMIN", "COUNTRY_MANAGER", "SALES_MANAGER"].includes(
    profile?.rol ?? ""
  );

  const [{ data: rulesRaw }, { data: goalsRaw }, { data: profilesRaw }] =
    await Promise.all([
      supabase.from("automation_rules").select("*").order("key"),
      supabase
        .from("goals")
        .select("*")
        .eq("metric", "paid_cases")
        .is("user_id", null)
        .order("period", { ascending: true }),
      supabase.from("profiles").select("*").order("nombre"),
    ]);
  const rules = (rulesRaw ?? []) as Rule[];
  const goals = (goalsRaw ?? []) as { id: string; period: string; target: number }[];
  const team = (profilesRaw ?? []) as {
    id: string;
    nombre: string;
    rol: string;
    activo: boolean;
  }[];

  // ---------- capa AI: stats de recomendaciones + últimas corridas ----------
  const [recStatusCounts, { data: aiRunsRaw }] = await Promise.all([
    Promise.all(
      REC_STATUSES.map(async (s) => {
        const { count } = await supabase
          .from("ai_recommendations")
          .select("id", { count: "exact", head: true })
          .eq("status", s);
        return [s, count ?? 0] as const;
      })
    ),
    supabase
      .from("agent_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  const recCounts = Object.fromEntries(recStatusCounts) as Record<
    RecommendationStatus,
    number
  >;
  const aiRuns = (aiRunsRaw ?? []) as AgentRunRow[];
  const runDoctorIds = [
    ...new Set(
      aiRuns.map((r) => r.doctor_id).filter((x): x is string => x != null)
    ),
  ];
  const { data: runDoctorsRaw } = runDoctorIds.length
    ? await supabase.from("doctors").select("id, nombre").in("id", runDoctorIds)
    : { data: [] };
  const runDoctorName = new Map(
    ((runDoctorsRaw ?? []) as { id: string; nombre: string }[]).map((d) => [
      d.id,
      d.nombre,
    ])
  );
  const decididas =
    recCounts.aceptada + recCounts.ejecutada + recCounts.descartada;
  const acceptanceRate =
    decididas > 0
      ? Math.round(((recCounts.aceptada + recCounts.ejecutada) / decididas) * 100)
      : null;

  const thisMonth = new Date().toISOString().slice(0, 7);

  return (
    <div className="max-w-3xl space-y-8 p-6">
      <h1 className="text-lg font-semibold tracking-tight">Ajustes</h1>

      {!isManager ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          Esta sección es de solo lectura para tu rol. Los cambios los hace un
          manager.
        </p>
      ) : null}

      {/* ---------- mantenimiento ---------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Sistema
        </h2>
        <div className="flex flex-wrap gap-2">
          <form action={recalcularScores}>
            <Button variant="outline" disabled={!isManager}>
              Recalcular scores
            </Button>
          </form>
          <form action={ejecutarAutomatizaciones}>
            <Button variant="outline" disabled={!isManager}>
              Ejecutar automatizaciones ahora
            </Button>
          </form>
          <form action={purgarDemo}>
            <Button variant="destructive" disabled={!isManager}>
              Borrar datos demo
            </Button>
          </form>
        </div>
        <p className="text-xs text-muted-foreground">
          Los scores se recalculan solos cada noche (05:00 México) y las
          automatizaciones corren cada hora. Estos botones fuerzan una corrida
          inmediata. “Borrar datos demo” elimina todo lo marcado como demo y no
          tiene vuelta atrás.
        </p>
      </section>

      {/* ---------- objetivos ---------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Objetivo mensual de casos (país)
        </h2>
        <ul className="divide-y rounded-lg border">
          {goals.map((g) => (
            <li key={g.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="capitalize">
                {new Date(g.period + "T12:00:00").toLocaleDateString("es-MX", {
                  month: "long",
                  year: "numeric",
                })}
              </span>
              <span className="font-medium tabular-nums">{g.target} casos</span>
            </li>
          ))}
          {goals.length === 0 ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">
              Sin objetivos cargados. La rampa H2: ago 24 · sep 26 · oct 28 ·
              nov 30 · dic 30.
            </li>
          ) : null}
        </ul>
        {isManager ? (
          <form action={guardarObjetivo} className="flex items-end gap-2">
            <div className="space-y-1">
              <label htmlFor="goal-period" className="text-xs text-muted-foreground">
                Mes
              </label>
              <Input
                id="goal-period"
                name="period"
                type="month"
                defaultValue={thisMonth}
                className="w-40"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="goal-target" className="text-xs text-muted-foreground">
                Casos
              </label>
              <Input
                id="goal-target"
                name="target"
                type="number"
                min="1"
                className="w-24"
                required
              />
            </div>
            <Button type="submit" variant="outline">
              Guardar
            </Button>
          </form>
        ) : null}
      </section>

      {/* ---------- automatizaciones ---------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Automatizaciones
        </h2>
        <ul className="divide-y rounded-lg border">
          {rules.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{r.nombre}</span>
                  <Badge
                    variant="outline"
                    className={
                      r.enabled
                        ? "font-normal text-emerald-700 dark:text-emerald-400"
                        : "font-normal text-muted-foreground"
                    }
                  >
                    {r.enabled ? "Activa" : "Apagada"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{r.descripcion}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                  Parámetros: {JSON.stringify(r.params)}
                  {r.last_run_at ? ` · Última corrida: ${formatDate(r.last_run_at)}` : ""}
                </p>
              </div>
              {isManager ? (
                <form action={toggleRegla}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="enabled" value={String(r.enabled)} />
                  <Button variant="ghost" size="sm">
                    {r.enabled ? "Apagar" : "Activar"}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
          {rules.length === 0 ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">
              Sin reglas. Aplicar la migración 0006.
            </li>
          ) : null}
        </ul>
      </section>

      {/* ---------- equipo ---------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Equipo
        </h2>
        <ul className="divide-y rounded-lg border">
          {team.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span>{p.nombre}</span>
              <span className="text-muted-foreground">{p.rol}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Los usuarios se crean con scripts/create-users.ts (invite-only).
        </p>
      </section>

      {/* ---------- inteligencia comercial (AI) ---------- */}
      {isManager ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Inteligencia comercial (AI)
          </h2>

          <ul className="divide-y rounded-lg border">
            <li className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-muted-foreground">Commercial Brain</span>
              <span className="font-medium tabular-nums">v{BRAIN_VERSION}</span>
            </li>
            <li className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-muted-foreground">Modelo</span>
              <span className="font-medium">{AI_MODEL}</span>
            </li>
            <li className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-muted-foreground">API key de Anthropic</span>
              <Badge
                variant="outline"
                className={
                  aiConfigured()
                    ? "font-normal text-emerald-700 dark:text-emerald-400"
                    : "font-normal text-orange-600 dark:text-orange-400"
                }
              >
                {aiConfigured() ? "Configurada" : "Falta ANTHROPIC_API_KEY"}
              </Badge>
            </li>
          </ul>

          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-6">
            {REC_STATUSES.map((s) => (
              <div key={s} className="bg-background p-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {REC_STATUS_LABELS[s]}
                </div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums">
                  {recCounts[s]}
                </div>
              </div>
            ))}
            <div className="bg-background p-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Aceptación
              </div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">
                {acceptanceRate != null ? `${acceptanceRate}%` : "—"}
              </div>
            </div>
          </div>

          {aiRuns.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Sin corridas de agentes todavía. El primer análisis aparece acá.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Agente</TableHead>
                    <TableHead>Doctor</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Latencia</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead>Fecha</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {aiRuns.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <AgentBadge agent={r.agent} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.doctor_id
                          ? (runDoctorName.get(r.doctor_id) ?? "—")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {TRIGGER_LABELS[r.trigger] ?? r.trigger}
                      </TableCell>
                      <TableCell>
                        <span
                          className={
                            r.status === "ok"
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-red-600 dark:text-red-400"
                          }
                        >
                          {r.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.latency_ms != null
                          ? `${(r.latency_ms / 1000).toFixed(1)}s`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.input_tokens != null || r.output_tokens != null
                          ? `${r.input_tokens ?? 0} → ${r.output_tokens ?? 0}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(r.created_at).toLocaleString("es-MX", {
                          timeZone: "America/Mexico_City",
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Los agentes solo proponen — nada se ejecuta sin un click humano. La
            tasa de aceptación sale de las recomendaciones decididas
            (aceptadas + ejecutadas sobre el total decidido).
          </p>
        </section>
      ) : null}
    </div>
  );
}

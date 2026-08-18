import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { buttonVariants } from "@/components/ui/button";
import { PipelineBoard, type PipelineOpp } from "@/components/pipeline/board";
import {
  JourneyBoard,
  type JourneyDoctor,
} from "@/components/prospecting/journey-board";
import { monthStartMX } from "@/lib/dates";
import { getForecastMes } from "@/lib/forecast";
import type { Opportunity } from "@/lib/types";
import { cn } from "@/lib/utils";

interface OppRow extends Opportunity {
  doctor: {
    id: string;
    nombre: string;
    phone: string | null;
    whatsapp: string | null;
    is_accredited: boolean;
  } | null;
}

// is_accredited viaja en el select para poder MARCAR la tarjeta. No se filtra: un
// doctor importante puede traer un paciente antes de acreditarse, y esa oportunidad
// es la señal más caliente que hay — esconderla sería peor que mezclarla. Lo que no
// puede pasar es que se lea como una oportunidad más de la base acreditada.
const OPP_SELECT =
  "*, doctor:doctors(id, nombre, phone, whatsapp, is_accredited)";

const JOURNEY_SELECT =
  "id, nombre, city, source, owner_id, acquisition_stage, activation_stage, interest_level, estimated_cases_month, priority_score, last_contact_at, accredited_at, created_at, is_demo";

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const showActivation = view === "activacion";
  const supabase = await createClient();

  const monthStartISO = monthStartMX();

  const [
    { data: openRaw, error: openError },
    { data: closedRaw },
    { data: profilesRaw },
    fc,
    { data: goalRow },
    { data: funnelRaw },
  ] = await Promise.all([
    supabase
      .from("opportunities")
      .select(OPP_SELECT)
      .not("stage", "in", "(ganada,perdida)")
      .order("created_at", { ascending: false }),
    supabase
      .from("opportunities")
      .select("id, stage")
      .eq("is_demo", false)
      .in("stage", ["ganada", "perdida"])
      .gte("closed_at", monthStartISO),
    supabase.from("profiles").select("id, nombre"),
    getForecastMes(supabase),
    supabase
      .from("goals")
      .select("target")
      .eq("period", monthStartISO)
      .eq("metric", "paid_cases")
      .is("user_id", null)
      .maybeSingle(),
    // pipeline de ACTIVACIÓN: acreditados sin primer caso pagado
    // (+ los activados este mes, que se muestran en la columna final)
    showActivation
      ? supabase
          .from("doctors")
          .select(JOURNEY_SELECT)
          // el universo B son las DOS condiciones juntas; sin este filtro el board
          // de activación mostraba a cualquiera que tuviera etapa cargada
          .eq("is_accredited", true)
          .not("activation_stage", "is", null)
          .or(
            `activation_stage.neq.primer_caso_pagado,first_paid_case_at.gte.${monthStartISO}`
          )
          .order("accredited_at", { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: null }),
  ]);

  const openOpps = (openRaw ?? []) as unknown as OppRow[];
  const closedOpps = (closedRaw ?? []) as unknown as {
    id: string;
    stage: string;
  }[];
  const activationDoctors = (funnelRaw ?? []) as unknown as JourneyDoctor[];
  const ownerNames = Object.fromEntries(
    ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [
      p.id,
      p.nombre,
    ])
  );

  const target = goalRow?.target ?? null;
  // Misma fuente que dashboard y /hoy: ai_forecast() (0023). Ver lib/forecast.ts.
  const closed = fc?.casos_nuevos_mes ?? 0;
  const pagados = fc?.casos_pagados_mes_ledger ?? null;

  // El TABLERO sigue mostrando las oportunidades demo —tienen su badge y se ven
  // como lo que son— pero los TILES son los números con los que se decide el mes,
  // y ahí el sintético no entra. Es el mismo criterio que ai_forecast() (0023),
  // que filtra `not is_demo`: sin esto el tile y el asistente AI de la misma
  // pantalla contestan distinto.
  const realOpps = openOpps.filter((o) => !o.is_demo);
  const commit = realOpps.filter((o) => o.forecast_category === "commit").length;
  const bestCase = realOpps.filter(
    (o) => o.forecast_category === "best_case"
  ).length;
  const pipeline = realOpps.filter(
    (o) => o.forecast_category === "pipeline"
  ).length;
  const forecast = fc?.forecast_casos_nuevos ?? closed;
  const gap = fc?.gap_vs_objetivo ?? null;

  const wonMonth = closedOpps.filter((o) => o.stage === "ganada").length;
  const lostMonth = closedOpps.filter((o) => o.stage === "perdida").length;

  const tiles: { label: string; value: string | number; className?: string }[] = [
    { label: "Objetivo", value: target ?? "—" },
    { label: "Pagados", value: pagados ?? "—" },
    { label: "Casos nuevos", value: closed },
    { label: "Commit", value: commit },
    { label: "Best case", value: bestCase },
    { label: "Pipeline", value: pipeline },
    { label: "Forecast", value: forecast },
    {
      label: "Gap",
      value: gap == null ? "—" : gap > 0 ? `−${gap}` : `+${Math.abs(gap)}`,
      className:
        gap == null
          ? undefined
          : gap > 0
            ? "text-orange-600 dark:text-orange-400"
            : "text-emerald-600 dark:text-emerald-400",
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            {showActivation
              ? "Acreditados en camino a su PRIMER caso pagado — arrastrá para avanzar"
              : `${openOpps.length} ${
                  openOpps.length === 1
                    ? "oportunidad abierta"
                    : "oportunidades abiertas"
                } · este mes: ${wonMonth} ganadas, ${lostMonth} perdidas`}
          </p>
        </div>
        <div className="flex gap-1">
          {[
            { key: "kanban", label: "Oportunidades", href: "/pipeline" },
            {
              key: "activacion",
              label: "Activación",
              href: "/pipeline?view=activacion",
            },
          ].map((x) => (
            <Link
              key={x.key}
              href={x.href}
              className={cn(
                buttonVariants({
                  variant:
                    (x.key === "activacion") === showActivation
                      ? "secondary"
                      : "ghost",
                  size: "sm",
                }),
                "h-8 text-[13px]"
              )}
            >
              {x.label}
            </Link>
          ))}
        </div>
      </div>

      {/* ---------- tira de forecast ---------- */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4 lg:grid-cols-7">
        {tiles.map((m) => (
          <div key={m.label} className="bg-background p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {m.label}
            </div>
            <div
              className={cn(
                "mt-0.5 text-xl font-semibold tabular-nums",
                m.className
              )}
            >
              {m.value}
            </div>
          </div>
        ))}
      </div>

      {showActivation ? (
        activationDoctors.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            No hay doctores en activación. Los recién acreditados aparecen acá
            automáticamente hasta pagar su primer caso.
          </div>
        ) : (
          <JourneyBoard
            mode="activacion"
            doctors={activationDoctors}
            ownerNames={ownerNames}
          />
        )
      ) : openError ? (
        <p className="text-sm text-destructive">
          Error cargando el pipeline: {openError.message}
        </p>
      ) : openOpps.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          Todavía no hay oportunidades abiertas. Se crean desde la ficha de cada
          doctor con el botón “Oportunidad”.
        </div>
      ) : (
        <PipelineBoard
          opportunities={openOpps as unknown as PipelineOpp[]}
          ownerNames={ownerNames}
        />
      )}
    </div>
  );
}


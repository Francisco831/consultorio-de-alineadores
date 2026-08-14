import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { resolveAlert, dismissAlert } from "@/lib/actions/alerts";
import { waLink, telLink, periskopeLink } from "@/lib/phone";
import {
  LIFECYCLE_LABELS,
  type Alert,
  type Doctor,
  type DoctorCategoria,
  type PriorityBucket,
  type PriorityReason,
  type Task,
} from "@/lib/types";
import {
  ACREDITACION_STYLES,
  CATEGORIA_LABELS,
  LIFECYCLE_STYLES,
} from "@/lib/format";
import { TaskList } from "@/components/tasks/task-list";
import { AgentBadge } from "@/components/ai/agent-badge";
import { MorningBrief } from "@/components/ai/morning-brief";
import { routeDoctorFromRow } from "@/lib/ai/orchestrator";
import { getForecastMes } from "@/lib/forecast";
import { todayMX, monthStartMX, hourMX } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { MessageCircle, Phone, ArrowRight, Check, X } from "lucide-react";

// /hoy mezcla los DOS universos pero los identifica: cada bloque es un motor
// comercial distinto y el usuario entiende al instante POR QUÉ contacta a cada uno
const MOTORES: {
  key: string;
  title: string;
  desc: string;
  buckets: PriorityBucket[];
}[] = [
  {
    key: "nuevos",
    title: "Nuevos doctores",
    desc: "Todavía NO acreditados — el objetivo es que se acrediten",
    buckets: ["nuevo_negocio"],
  },
  {
    key: "activacion",
    title: "Activación",
    desc: "Acreditados sin casos — conseguir su primer caso",
    buckets: ["activacion", "alto_impacto"],
  },
  {
    key: "crecimiento",
    title: "Crecimiento",
    desc: "Subir la frecuencia de los que ya mandan",
    buckets: ["growth", "oportunidades"],
  },
  {
    key: "riesgo",
    title: "Riesgo",
    desc: "Actividad cayendo contra su propio ritmo",
    buckets: ["critico", "riesgo", "seguimientos"],
  },
];

const SEVERITY_DOT: Record<string, string> = {
  critica: "bg-red-500",
  alta: "bg-orange-500",
  media: "bg-amber-400",
  info: "bg-emerald-500",
};

export default async function HoyPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { v } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, nombre, rol")
    .eq("id", user!.id)
    .single();
  // decisión de Pancho (8/8): todos ven todo — "Míos" queda como filtro opcional
  const scope = v ?? "todos";

  const monthStartISO = monthStartMX();
  const todayISO = todayMX();
  const monthLabel = new Date().toLocaleDateString("es-MX", {
    timeZone: "America/Mexico_City",
    month: "long",
    year: "numeric",
  });

  // CUPO POR MOTOR: una sola query global con limit repartía las 40 filas entre
  // los dos universos, y con 6.208 prospectos scoreados los bloques Activación,
  // Crecimiento y Riesgo quedaban vacíos — el usuario creía que no había nada
  // que hacer con la base acreditada. Cada motor pide (y cuenta) lo suyo.
  const POR_MOTOR = 8;
  const motorQuery = (buckets: PriorityBucket[], head = false) => {
    let q = supabase
      .from("doctors")
      .select(head ? "id" : "*", { count: "exact", head })
      .in("priority_bucket", buckets)
      .gt("priority_score", 0)
      .order("priority_score", { ascending: false });
    if (!head) q = q.limit(POR_MOTOR);
    if (scope === "mios") q = q.eq("owner_id", user!.id);
    return q;
  };
  const motoresData = Promise.all(
    MOTORES.map(async (m) => {
      const [{ data }, { count }] = await Promise.all([
        motorQuery(m.buckets),
        motorQuery(m.buckets, true),
      ]);
      return { motor: m, doctors: (data ?? []) as unknown as Doctor[], total: count ?? 0 };
    })
  );

  const [
    { count: monthCases },
    { data: goalRow },
    fc,
    motores,
    { data: alertsRaw, count: alertsTotal },
    { data: myTasksRaw },
    { data: profilesRaw },
    { data: waWaitingRaw },
  ] = await Promise.all([
    // is_demo=false en todo lo que se cuenta o se pondera: las filas sintéticas del
    // seed cuelgan de doctores REALES y están asignadas a personas reales, así que
    // sin el filtro inflan el forecast, el tile de alertas y la cola de tareas.
    supabase
      .from("cases")
      .select("id", { count: "exact", head: true })
      .eq("is_new_case", true)
      .eq("is_demo", false)
      .gte("fecha_ingreso", monthStartISO),
    supabase
      .from("goals")
      .select("target")
      .eq("period", monthStartISO)
      .eq("metric", "paid_cases")
      .is("user_id", null)
      .maybeSingle(),
    getForecastMes(supabase),
    motoresData,
    // el count es exacto aunque la lista venga recortada a 30: el tile de arriba
    // tiene que decir cuántas alertas hay, no cuántas entran en la columna
    supabase
      .from("alerts")
      .select("*", { count: "exact" })
      .eq("status", "abierta")
      .eq("is_demo", false)
      .order("severity", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("tasks")
      .select("*")
      .eq("assigned_to", user!.id)
      .eq("status", "pendiente")
      .eq("is_demo", false)
      .lte("due_date", todayISO)
      .order("due_date", { ascending: true })
      .limit(20),
    supabase.from("profiles").select("id, nombre"),
    supabase
      .from("wa_conversations")
      .select(
        "id, periskope_chat_id, chat_name, phone, activity_bucket, doctor:doctors!inner(id, nombre, categoria, new_case_count, whatsapp)"
      )
      .eq("unanswered", true)
      .in("activity_bucket", ["7d", "30d"])
      .limit(60),
  ]);

  const doctors = motores.flatMap((m) => m.doctors);
  const alerts = (alertsRaw ?? []) as Alert[];
  const myTasks = (myTasksRaw ?? []) as Task[];
  const target = goalRow?.target ?? null;
  // Misma fuente que el dashboard: ai_forecast() (0023). Ver lib/forecast.ts.
  const closed = fc?.casos_nuevos_mes ?? monthCases ?? 0;
  const pagados = fc?.casos_pagados_mes_ledger ?? null;
  const forecast = fc?.forecast_casos_nuevos ?? closed;
  const gap = fc?.gap_vs_objetivo ?? null;

  // Señales de SERVICIO por doctor para el router determinístico (labels de
  // agente). Solo las reglas que representan un caso trabado o una entrega
  // demorada: las de activación/retención ya las cubre el lifecycle, y contarlas
  // acá pintaría de SERVICIO a doctores que no tienen ningún problema abierto.
  const SERVICE_RULE_KEYS = new Set([
    "caso_atrasado",
    "aprobacion_pendiente",
    "oportunidad_estancada",
  ]);
  const alertCountByDoctor = new Map<string, number>();
  for (const a of alerts) {
    if (!a.doctor_id || !SERVICE_RULE_KEYS.has(a.rule_key)) continue;
    alertCountByDoctor.set(
      a.doctor_id,
      (alertCountByDoctor.get(a.doctor_id) ?? 0) + 1
    );
  }


  const profileName = new Map(
    ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [
      p.id,
      p.nombre,
    ])
  );

  // inbox WhatsApp: doctores esperando respuesta (7d primero, luego por volumen)
  type WaRow = {
    id: string;
    periskope_chat_id: string;
    chat_name: string | null;
    phone: string | null;
    activity_bucket: string | null;
    doctor: {
      id: string;
      nombre: string;
      categoria: string;
      new_case_count: number;
      whatsapp: string | null;
    };
  };
  const waWaiting = ((waWaitingRaw ?? []) as unknown as WaRow[])
    .sort(
      (a, b) =>
        (a.activity_bucket === "7d" ? 0 : 1) - (b.activity_bucket === "7d" ? 0 : 1) ||
        b.doctor.new_case_count - a.doctor.new_case_count
    )
    .slice(0, 12);

  const hour = hourMX();
  const saludo = hour < 12 ? "Buen día" : hour < 19 ? "Buenas tardes" : "Buenas noches";

  return (
    <div className="space-y-6 p-6">
      {/* ---------- header con objetivo del mes ---------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {saludo}, {profile?.nombre?.split(" ")[0]}
          </h1>
          <p className="text-sm capitalize text-muted-foreground">{monthLabel}</p>
        </div>
        <div className="flex gap-1">
          {[
            { key: "todos", label: "Todos" },
            { key: "mios", label: "Míos" },
          ].map((x) => (
            <Link
              key={x.key}
              href={x.key === "todos" ? "/hoy" : "/hoy?v=mios"}
              className={buttonVariants({
                variant: scope === x.key ? "secondary" : "ghost",
                size: "sm",
              })}
            >
              {x.label}
            </Link>
          ))}
        </div>
      </div>

      {/* ---------- AI Morning Brief ---------- */}
      <MorningBrief />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        {[
          {
            // el objetivo es de casos PAGADOS: se mide contra el ledger, no
            // contra los ingresados (ver lib/forecast.ts)
            label: "Pagados / objetivo",
            value:
              target != null
                ? `${pagados ?? "—"} / ${target}`
                : String(pagados ?? "—"),
          },
          { label: "Casos nuevos", value: String(closed) },
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
          { label: "Alertas abiertas", value: alertsTotal ?? alerts.length },
        ].map((m) => (
          <div key={m.label} className="bg-background p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {m.label}
            </div>
            <div className={cn("mt-0.5 text-2xl font-semibold tabular-nums", m.className)}>
              {m.value}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ---------- prioridades ---------- */}
        <div className="space-y-5 lg:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Tus prioridades
          </h2>
          {doctors.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Sin prioridades pendientes. O está todo al día, o todavía no se
              calcularon los scores (Ajustes → Recalcular).
            </p>
          ) : (
            motores.map(({ motor, doctors: list, total }) => {
              if (!list.length) return null;
              return (
                <div key={motor.key} className="space-y-2">
                  <div>
                    <h3 className="text-[13px] font-semibold uppercase tracking-wide">
                      {motor.title}
                      <span className="ml-1.5 font-normal normal-case tracking-normal text-muted-foreground">
                        {/* el total real del motor, no cuántos entran en pantalla */}
                        · {total > list.length ? `${list.length} de ${total}` : total}
                      </span>
                    </h3>
                    <p className="text-xs text-muted-foreground">{motor.desc}</p>
                  </div>
                  <div className="space-y-2">
                    {list.map((d) => {
                      const wa = waLink(d.whatsapp ?? d.phone);
                      const tel = telLink(d.phone ?? d.whatsapp);
                      const reasons = (d.priority_reasons ?? []) as PriorityReason[];
                      // router determinístico (gratis, sin LLM): qué agente atiende a este doctor
                      const routing = routeDoctorFromRow(d, {
                        serviceSignals: alertCountByDoctor.get(d.id) ?? 0,
                      });
                      return (
                        <div
                          key={d.id}
                          className="rounded-lg border p-3.5 transition-colors hover:bg-muted/40"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <Link
                                  href={`/doctores/${d.id}`}
                                  className="font-medium hover:underline"
                                >
                                  {d.nombre}
                                </Link>
                                <span className="text-sm tabular-nums text-muted-foreground">
                                  {d.priority_score}
                                </span>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "h-4.5 px-1.5 text-[10px] font-normal",
                                    d.is_accredited
                                      ? LIFECYCLE_STYLES[d.lifecycle_stage]
                                      : ACREDITACION_STYLES.no
                                  )}
                                >
                                  {d.is_accredited
                                    ? LIFECYCLE_LABELS[d.lifecycle_stage]
                                    : "No acreditado"}
                                </Badge>
                                {routing.primary ? (
                                  <AgentBadge
                                    agent={routing.primary.agent}
                                    title={routing.primary.reason}
                                  />
                                ) : null}
                                {d.is_demo ? (
                                  <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                                    demo
                                  </Badge>
                                ) : null}
                              </div>
                              <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                                {reasons.slice(0, 3).map((r) => (
                                  <li key={r.code}>• {r.text}</li>
                                ))}
                              </ul>
                              {d.recommended_action ? (
                                <p className="mt-1.5 text-sm font-medium">
                                  → {d.recommended_action.label}
                                </p>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 gap-1">
                              {wa ? (
                                <a
                                  href={wa}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={buttonVariants({ variant: "outline", size: "icon-sm" })}
                                  title="WhatsApp"
                                >
                                  <MessageCircle />
                                </a>
                              ) : null}
                              {tel ? (
                                <a
                                  href={tel}
                                  className={buttonVariants({ variant: "outline", size: "icon-sm" })}
                                  title="Llamar"
                                >
                                  <Phone />
                                </a>
                              ) : null}
                              <Link
                                href={`/doctores/${d.id}`}
                                className={buttonVariants({ variant: "outline", size: "icon-sm" })}
                                title="Abrir ficha"
                              >
                                <ArrowRight />
                              </Link>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* ---------- columna derecha: tareas de hoy + alertas ---------- */}
        <div className="space-y-6">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Tus tareas de hoy
            </h2>
            <TaskList
              tasks={myTasks}
              profileName={Object.fromEntries(profileName)}
              emptyMessage="Nada vencido ni para hoy. Excelente."
            />
          </div>

          {waWaiting.length > 0 ? (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                WhatsApp esperando respuesta
              </h2>
              <ul className="divide-y rounded-lg border">
                {waWaiting.map((w) => {
                  // el equipo responde desde Periskope, no desde WhatsApp personal
                  const wa =
                    periskopeLink(w.periskope_chat_id) ??
                    waLink(w.phone ?? w.doctor.whatsapp);
                  return (
                    <li
                      key={w.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/doctores/${w.doctor.id}`}
                          className="block truncate font-medium hover:underline"
                        >
                          {w.doctor.nombre}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {CATEGORIA_LABELS[w.doctor.categoria as DoctorCategoria]}{" "}
                          · {w.doctor.new_case_count} casos ·{" "}
                          {w.activity_bucket === "7d" ? (
                            <span className="font-medium text-orange-600 dark:text-orange-400">
                              activo esta semana
                            </span>
                          ) : (
                            "últimos 30 días"
                          )}
                        </span>
                      </div>
                      {wa ? (
                        <a
                          href={wa}
                          target="_blank"
                          rel="noreferrer"
                          className={cn(
                            buttonVariants({ variant: "outline", size: "sm" })
                          )}
                        >
                          Responder
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-muted-foreground">
                El doctor habló último y nadie respondió (export Periskope 7/8).
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Alertas
            </h2>
            {alerts.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Sin alertas abiertas.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {alerts.map((a) => (
                  <li key={a.id} className="flex items-start gap-2.5 p-3">
                    <span
                      className={cn(
                        "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                        SEVERITY_DOT[a.severity]
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      {a.doctor_id ? (
                        <Link
                          href={`/doctores/${a.doctor_id}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {a.title}
                        </Link>
                      ) : (
                        <p className="text-sm font-medium">{a.title}</p>
                      )}
                      {a.reason ? (
                        <p className="text-xs text-muted-foreground">{a.reason}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-0.5">
                      <form action={resolveAlert}>
                        <input type="hidden" name="alert_id" value={a.id} />
                        <Button size="icon-xs" variant="ghost" title="Resuelta">
                          <Check />
                        </Button>
                      </form>
                      <form action={dismissAlert}>
                        <input type="hidden" name="alert_id" value={a.id} />
                        <Button size="icon-xs" variant="ghost" title="Descartar">
                          <X />
                        </Button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

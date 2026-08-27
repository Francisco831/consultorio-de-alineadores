import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { resolveAlert, dismissAlert } from "@/lib/actions/alerts";
import { waLink, telLink } from "@/lib/phone";
import {
  LIFECYCLE_LABELS,
  type Alert,
  type Doctor,
  type Efemeride,
  type Pendiente,
  type PriorityBucket,
  type PriorityReason,
  type Task,
} from "@/lib/types";
import { ACREDITACION_STYLES, LIFECYCLE_STYLES } from "@/lib/format";
import { TaskList } from "@/components/tasks/task-list";
import { MorningBrief } from "@/components/ai/morning-brief";
import { PendientesCard } from "@/components/pendientes/pendientes-card";
import { EfemeridesCard } from "@/components/hoy/efemerides-card";
import {
  WaEsperandoLista,
  type WaEsperando,
} from "@/components/whatsapp/wa-esperando";
import { AgendaHoy } from "@/components/calendar/agenda-hoy";
import { armarAgendaConBrief, SELECT_DOCTOR_BRIEF, type FilaAgenda } from "@/lib/agenda-brief";
import { CONTACTO_TYPES } from "@/lib/actividad-equipo";
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
    .select("id, nombre, rol, periskope_org_phone")
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
  // 5 por motor: con 8 la pantalla era una pared de ~32 fichas y dejaba de
  // leerse como "mi plan de hoy" (feedback Rocío/Pancho 22/8)
  const POR_MOTOR = 5;
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
    { data: myTasksRaw, count: myTasksTotal },
    { data: profilesRaw },
    { data: waWaitingRaw },
    { count: monthContacts },
    { data: pendientesRaw },
    { data: efemeridesRaw },
    { data: agendaRaw },
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
    // con cientos de alertas abiertas, listar 30 era una pared: se muestran las
    // 8 más severas y el total exacto va en el título del bloque
    supabase
      .from("alerts")
      .select("*", { count: "exact" })
      .eq("status", "abierta")
      .eq("is_demo", false)
      .order("severity", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("tasks")
      .select("*", { count: "exact" })
      .eq("assigned_to", user!.id)
      .eq("status", "pendiente")
      .eq("is_demo", false)
      .lte("due_date", todayISO)
      .order("due_date", { ascending: true })
      .limit(8),
    supabase.from("profiles").select("id, nombre"),
    supabase
      .from("wa_conversations")
      .select(
        "id, periskope_chat_id, chat_name, phone, activity_bucket, lineas, last_message_body, last_message_at, doctor:doctors!inner(id, nombre, categoria, new_case_count, whatsapp)"
      )
      .eq("unanswered", true)
      .in("activity_bucket", ["7d", "30d"])
      .limit(60),
    // contactos reales del equipo en el mes (llamadas, videollamadas, visitas,
    // reuniones, WhatsApp, KeepDays) — lo que Rocío pide "que contabilice"
    supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("is_demo", false)
      .in("type", [...CONTACTO_TYPES])
      .gte("occurred_at", `${monthStartISO}T00:00:00-06:00`),
    // la libreta personal (0039): siempre la del logueado, el filtro Todos/Míos
    // no aplica — es de uno, no del equipo
    supabase
      .from("pendientes")
      .select("*")
      .eq("user_id", user!.id)
      .order("orden", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(50),
    // cumpleaños y aniversarios de acreditación de acá a una semana (0040)
    supabase.rpc("doctores_efemerides", { dias_adelante: 7 }),
    // la agenda del día que bajó el sync de Google Calendar. Si nadie configuró
    // su Apps Script todavía, esto viene vacío y el bloque no se dibuja.
    supabase
      .from("calendar_events")
      .select(
        `id, titulo, inicio, fin, todo_el_dia, doctor:doctors(${SELECT_DOCTOR_BRIEF})`
      )
      .eq("profile_id", user!.id)
      .gte("inicio", `${todayISO}T00:00:00-06:00`)
      .lt("inicio", `${todayISO}T23:59:59-06:00`)
      .order("inicio", { ascending: true })
      .limit(20),
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
    .slice(0, 8);

  const pendientes = (pendientesRaw ?? []) as Pendiente[];
  const efemerides = (efemeridesRaw ?? []) as Efemeride[];

  // el brief de cada llamada se arma determinista y gratis (lib/brief-doctor.ts,
  // no usa IA); lib/agenda-brief.ts es el que va a buscar tipos de caso y eventos
  const agenda = await armarAgendaConBrief(
    supabase,
    (agendaRaw ?? []) as unknown as FilaAgenda[]
  );

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
          <p className="text-sm text-muted-foreground">
            <span className="capitalize">{monthLabel}</span> — tu plan del día:
            a quién contactar, tus tareas y los avisos del sistema
          </p>
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

      {/* la agenda del día, con el brief de cada doctor ya armado. Si nadie
          conectó su Google Calendar todavía, el componente devuelve null */}
      <AgendaHoy eventos={agenda} />

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
          // reemplaza al tile "Alertas abiertas": un stock de cientos no dice
          // nada del día; los contactos del mes sí miden el trabajo del equipo
          { label: "Contactos del mes", value: String(monthContacts ?? 0) },
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
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              ¿A quién contacto hoy?
            </h2>
            <p className="text-xs text-muted-foreground">
              El CRM elige los doctores que más mueven la aguja y te dice por
              qué. Arrancá por acá, de arriba hacia abajo.
            </p>
          </div>
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
                                {d.is_demo ? (
                                  <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                                    demo
                                  </Badge>
                                ) : null}
                              </div>
                              <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                                {reasons.slice(0, 2).map((r) => (
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
          {/* la libreta va PRIMERA: lo que uno anota a mano manda sobre lo que
              propone el sistema (pedido de Pancho, 26/8) */}
          <div className="space-y-2">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Mis pendientes
              </h2>
              <p className="text-xs text-muted-foreground">
                Tu libreta. Es tuya y no toca las tareas del CRM.
              </p>
            </div>
            <PendientesCard pendientes={pendientes} editable />
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Tus tareas de hoy
              </h2>
              {(myTasksTotal ?? 0) > myTasks.length ? (
                <Link
                  href="/tareas"
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  ver las {myTasksTotal} en Tareas
                </Link>
              ) : null}
            </div>
            <TaskList
              tasks={myTasks}
              profileName={Object.fromEntries(profileName)}
              emptyMessage="Nada vencido ni para hoy. Excelente."
            />
          </div>

          <WaEsperandoLista
            chats={waWaiting as unknown as WaEsperando[]}
            miLinea={profile?.periskope_org_phone ?? null}
          />

          {/* cumpleaños y aniversarios de acreditación de acá a una semana */}
          <EfemeridesCard efemerides={efemerides} />

          <div className="space-y-2">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Alertas
                {(alertsTotal ?? 0) > alerts.length ? (
                  <span className="ml-1.5 font-normal normal-case tracking-normal">
                    · {alerts.length} de {alertsTotal}
                  </span>
                ) : null}
              </h2>
              <p className="text-xs text-muted-foreground">
                Avisos automáticos (rechazos, casos trabados, doctores
                frenados), de más a menos grave. ✓ resuelta · ✕ no aplica.
              </p>
            </div>
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

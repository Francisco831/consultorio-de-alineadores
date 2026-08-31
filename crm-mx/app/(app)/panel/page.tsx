import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { QuickLog } from "@/components/panel/quick-log";
import { PendientesCard } from "@/components/pendientes/pendientes-card";
import {
  WaEsperandoLista,
  type WaEsperando,
} from "@/components/whatsapp/wa-esperando";
import { AgendaHoy } from "@/components/calendar/agenda-hoy";
import { armarAgendaConBrief, SELECT_DOCTOR_BRIEF, type FilaAgenda } from "@/lib/agenda-brief";
import { waLink, telLink, periskopeLink } from "@/lib/phone";
import { todayMX, monthStartMX } from "@/lib/dates";
import { MX_TZ, CONTACTO_TYPES } from "@/lib/actividad-equipo";
import { resumenPorPaisDe, v2UserIdDe, PAIS_LABEL } from "@/lib/noloco-pais";
import {
  ACTIVITY_TYPE_LABELS,
  TASK_TYPE_LABELS,
  type ActivityType,
  type DoctorCategoria,
  type Pendiente,
  type TaskType,
} from "@/lib/types";
import { CATEGORIA_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MessageCircle, Phone, ArrowRight } from "lucide-react";

// Panel personal ("la pestaña que diga Rocío", 22/8): registro, agenda y
// números del mes de UNA persona. Por decisión de Pancho (8/8) todos ven el
// panel de todos: ?u= cambia de persona, sin permisos especiales.
//
// Lo que pidió Rocío y dónde quedó: llamadas planificadas con resumen del
// doctor → Agenda (tareas + mini-ficha con casos, tipos y eventos académicos);
// reuniones realizadas + registrar lo conversado → bloque Reuniones + carga
// rápida; contabilizar → tiles del mes; "por país" → tabla de SU mes en Noloco
// (lib/noloco-pais.ts, por persona).
//
// 26/8: se cerraron los dos pendientes que quedaban. Google Calendar entra por
// Apps Script (docs/CALENDAR.md) y trae la agenda del día con un brief de tres
// oraciones por doctor, armado sin IA (lib/brief-doctor.ts). El cumpleaños del
// doctor ahora existe como campo (doctors.birth_date, migración 0040) y se
// carga desde la ficha; la edad sigue sin estar y no la inventamos.

type DocMini = {
  id: string;
  nombre: string;
  categoria: string;
  city: string | null;
  state: string | null;
  zona: string | null;
  case_count: number;
  new_case_count: number;
  last_contact_at: string | null;
  whatsapp: string | null;
  phone: string | null;
};

type TareaAgenda = {
  id: string;
  title: string;
  type: TaskType;
  due_date: string | null;
  doctor: DocMini | null;
};

type ActMes = {
  type: ActivityType;
  occurred_at: string;
  summary: string | null;
  outcome: string | null;
  doctor: { id: string; nombre: string } | null;
};

const fmtDia = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
  });

const fmtTs = new Intl.DateTimeFormat("es-MX", {
  timeZone: MX_TZ,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function PanelPage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // última entrada de cada uno (team_signins = lo más nuevo entre el login de
  // auth y profiles.last_seen_at, que el layout toca en cada carga — 0050): el
  // gate de rol vive en la función — a un rol sin gestión le devuelve error y
  // el bloque "Ingresos al CRM" directamente no aparece
  const [{ data: profilesRaw }, { data: signinsRaw }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, nombre, rol, activo, periskope_org_phone")
      .order("nombre"),
    supabase.rpc("team_signins"),
  ]);
  const profiles = profilesRaw ?? [];
  const equipo = profiles.filter((p) => p.activo && p.rol !== "VIEWER");
  const lastSignIn = signinsRaw
    ? new Map<string, string | null>(
        (
          signinsRaw as { user_id: string; last_sign_in_at: string | null }[]
        ).map((s) => [s.user_id, s.last_sign_in_at])
      )
    : null;

  // persona del panel: ?u= válido, o quien está logueado
  const u =
    params.u && profiles.some((p) => p.id === params.u) ? params.u : user!.id;
  const persona = profiles.find((p) => p.id === u);
  const nombre = persona?.nombre?.split(" ")[0] ?? "—";
  const esPropio = u === user!.id;

  const monthStartISO = monthStartMX();
  const todayISO = todayMX();
  const desde = `${monthStartISO}T00:00:00-06:00`;
  const mesLabel = new Date().toLocaleDateString("es-MX", {
    timeZone: MX_TZ,
    month: "long",
    year: "numeric",
  });

  const [
    { data: actsRaw },
    { data: tareasRaw },
    { count: tareasHechasMes },
    { count: eventosMes },
    { data: goalsRaw },
    { count: casosNuevosMes },
  ] = await Promise.all([
    supabase
      .from("activities")
      .select("type, occurred_at, summary, outcome, doctor:doctors(id, nombre)")
      .eq("created_by", u)
      .eq("is_demo", false)
      .gte("occurred_at", desde)
      .order("occurred_at", { ascending: false })
      .limit(1000),
    supabase
      .from("tasks")
      .select(
        "id, title, type, due_date, doctor:doctors(id, nombre, categoria, city, state, zona, case_count, new_case_count, last_contact_at, whatsapp, phone)"
      )
      .eq("assigned_to", u)
      .eq("status", "pendiente")
      .eq("is_demo", false)
      .order("due_date", { ascending: true, nullsFirst: false })
      // TODOS sus pendientes: el panel es su única pantalla (Pancho 22/8)
      .limit(200),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("assigned_to", u)
      .eq("status", "completada")
      .eq("is_demo", false)
      .gte("completed_at", desde),
    supabase
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("created_by", u)
      .gte("created_at", desde),
    supabase
      .from("goals")
      .select("metric, target")
      .eq("period", monthStartISO)
      .eq("user_id", u),
    supabase
      .from("cases")
      .select("id, doctors!inner(owner_id)", { count: "exact", head: true })
      .eq("is_new_case", true)
      .eq("is_demo", false)
      .eq("doctors.owner_id", u)
      .gte("fecha_ingreso", monthStartISO),
  ]);

  const acts = (actsRaw ?? []) as unknown as ActMes[];
  const agenda = (tareasRaw ?? []) as unknown as TareaAgenda[];
  const metaDe = (m: string) =>
    (goalsRaw ?? []).find((g) => g.metric === m)?.target ?? null;

  // ---- números del mes ----
  const porTipo = new Map<ActivityType, number>();
  for (const a of acts) porTipo.set(a.type, (porTipo.get(a.type) ?? 0) + 1);
  const contactos = [...CONTACTO_TYPES].reduce(
    (n, t) => n + (porTipo.get(t as ActivityType) ?? 0),
    0
  );
  // meta 0 = "sin meta este mes" (pasa con keepdays): mostrar el número pelado
  const conMeta = (n: number, meta: number | null) =>
    meta != null && meta > 0 ? `${n} / ${meta}` : String(n);

  const reuniones = acts.filter(
    (a) => a.type === "reunion" || a.type === "videollamada"
  );

  // ---- mini-ficha de los doctores de la agenda: tipos de caso + eventos ----
  const docIds = [
    ...new Set(agenda.map((t) => t.doctor?.id).filter(Boolean)),
  ].slice(0, 60) as string[];
  const [
    { data: tiposRaw },
    { data: asistenciasRaw },
    { data: chatsAgendaRaw },
    waEsp,
    paises,
    { data: pendientesRaw },
    { data: agendaCalRaw },
  ] = await Promise.all([
      docIds.length
        ? supabase
            .from("cases")
            .select("doctor_id, tipo_tratamiento")
            .in("doctor_id", docIds)
            .eq("is_demo", false)
            .not("tipo_tratamiento", "is", null)
            .limit(2000)
        : Promise.resolve({ data: [] }),
      docIds.length
        ? supabase
            .from("event_attendees")
            .select("doctor_id, events(titulo, fecha)")
            .in("doctor_id", docIds)
        : Promise.resolve({ data: [] }),
      // chat conocido de cada doctor de la agenda: el click de WhatsApp abre
      // Periskope (donde responde el equipo), no un wa.me pelado
      docIds.length
        ? supabase
            .from("wa_conversations")
            .select("doctor_id, periskope_chat_id")
            .in("doctor_id", docIds)
            .not("periskope_chat_id", "is", null)
        : Promise.resolve({ data: [] }),
      // chats de SUS doctores donde el doctor habló último
      supabase
        .from("wa_conversations")
        .select(
          "id, periskope_chat_id, phone, chat_name, activity_bucket, lineas, last_message_body, last_message_at, doctor:doctors!inner(id, nombre, owner_id, whatsapp)",
          { count: "exact" }
        )
        .eq("unanswered", true)
        .eq("doctor.owner_id", u)
        .limit(30),
      // por país pero DE LA PERSONA (Pancho 22/8: "los de ella, no los
      // generales"): sin usuario v2 mapeado el bloque directamente no aparece
      (() => {
        const v2id = v2UserIdDe(persona?.nombre ?? "");
        return v2id != null ? resumenPorPaisDe(v2id) : Promise.resolve(null);
      })(),
      // la libreta de ESTA persona (0039). Se ve siempre; se edita solo si es
      // la propia — lo garantiza la RLS, el `editable` es solo la UI.
      supabase
        .from("pendientes")
        .select("*")
        .eq("user_id", u)
        .order("orden", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(50),
      // su agenda de hoy bajada de Google Calendar (vacía hasta que configure
      // su Apps Script: ver docs/CALENDAR.md)
      supabase
        .from("calendar_events")
        .select(
          `id, titulo, inicio, fin, todo_el_dia, doctor:doctors(${SELECT_DOCTOR_BRIEF})`
        )
        .eq("profile_id", u)
        .gte("inicio", `${todayISO}T00:00:00-06:00`)
        .lt("inicio", `${todayISO}T23:59:59-06:00`)
        .order("inicio", { ascending: true })
        .limit(20),
    ]);

  const chatDe = new Map<string, string>();
  for (const c of (chatsAgendaRaw ?? []) as {
    doctor_id: string | null;
    periskope_chat_id: string;
  }[])
    if (c.doctor_id && !chatDe.has(c.doctor_id))
      chatDe.set(c.doctor_id, c.periskope_chat_id);

  const pendientes = (pendientesRaw ?? []) as Pendiente[];
  const miLinea =
    (profiles.find((p) => p.id === user!.id) as { periskope_org_phone?: string | null } | undefined)
      ?.periskope_org_phone ?? null;

  // el brief de cada llamada se arma determinista y gratis (lib/brief-doctor.ts,
  // no usa IA); lib/agenda-brief.ts es el que va a buscar tipos de caso y eventos
  const agendaCal = await armarAgendaConBrief(
    supabase,
    (agendaCalRaw ?? []) as unknown as FilaAgenda[]
  );

  type WaEspRow = {
    id: string;
    periskope_chat_id: string | null;
    phone: string | null;
    activity_bucket: string | null;
    doctor: { id: string; nombre: string; whatsapp: string | null };
  };
  const waEsperando = ((waEsp.data ?? []) as unknown as WaEspRow[])
    .sort(
      (a, b) =>
        (a.activity_bucket === "7d" ? 0 : 1) -
        (b.activity_bucket === "7d" ? 0 : 1)
    )
    .slice(0, 8);
  const waTotal = waEsp.count ?? waEsperando.length;

  const tiposDe = new Map<string, string>();
  {
    const cnt = new Map<string, Map<string, number>>();
    for (const r of (tiposRaw ?? []) as {
      doctor_id: string;
      tipo_tratamiento: string;
    }[]) {
      if (!cnt.has(r.doctor_id)) cnt.set(r.doctor_id, new Map());
      const m = cnt.get(r.doctor_id)!;
      m.set(r.tipo_tratamiento, (m.get(r.tipo_tratamiento) ?? 0) + 1);
    }
    for (const [docId, m] of cnt) {
      const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
      tiposDe.set(docId, top.map(([t, n]) => `${t} ×${n}`).join(", "));
    }
  }

  const eventosDe = new Map<string, { titulo: string; fecha: string }[]>();
  for (const r of (asistenciasRaw ?? []) as unknown as {
    doctor_id: string | null;
    events: { titulo: string; fecha: string } | null;
  }[]) {
    if (!r.doctor_id || !r.events) continue;
    if (!eventosDe.has(r.doctor_id)) eventosDe.set(r.doctor_id, []);
    eventosDe.get(r.doctor_id)!.push(r.events);
  }
  for (const lista of eventosDe.values())
    lista.sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  // ---- ingresos al CRM ("lo quiero ver en el panel", Pancho 22/8) ----
  // Desde 0050 el dato es la última ENTRADA real (login o sesión abierta, la
  // marca el layout), no el último login de auth. El rojo solo salta en día
  // hábil; la alarma de las 17:30 MX (api/sync/asistencia) mira además si
  // cargaron algo.
  const esDiaHabil = !["Sat", "Sun"].includes(
    new Intl.DateTimeFormat("en-US", {
      timeZone: MX_TZ,
      weekday: "short",
    }).format(new Date())
  );
  const diaMXDe = new Intl.DateTimeFormat("en-CA", { timeZone: MX_TZ });
  const horaMX = new Intl.DateTimeFormat("es-MX", {
    timeZone: MX_TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
  const ingresoDe = (iso: string | null | undefined) => {
    if (!iso) return { label: "nunca entró", hoy: false };
    const hoy = diaMXDe.format(new Date(iso)) === todayISO;
    return {
      label: hoy
        ? `hoy ${horaMX.format(new Date(iso))}`
        : fmtTs.format(new Date(iso)),
      hoy,
    };
  };

  // ---- agenda en tres franjas ----
  const vencidas = agenda.filter((t) => t.due_date && t.due_date < todayISO);
  const deHoy = agenda.filter((t) => t.due_date === todayISO);
  const proximas = agenda.filter((t) => !t.due_date || t.due_date > todayISO);

  const tiles = [
    { label: "Contactos", value: conMeta(contactos, metaDe("contactos")) },
    {
      label: "Videollamadas",
      value: conMeta(
        porTipo.get("videollamada") ?? 0,
        metaDe("videollamadas")
      ),
    },
    {
      label: "KeepDays",
      value: conMeta(porTipo.get("keepday") ?? 0, metaDe("keepdays")),
    },
    { label: "Reuniones", value: String(porTipo.get("reunion") ?? 0) },
    { label: "Tareas completadas", value: String(tareasHechasMes ?? 0) },
    {
      label: "Casos nuevos (tus doctores)",
      value: String(casosNuevosMes ?? 0),
    },
  ];

  const FRANJAS: { titulo: string; items: TareaAgenda[]; alerta?: boolean }[] =
    [
      { titulo: "Hoy", items: deHoy },
      { titulo: "Vencidas", items: vencidas, alerta: true },
      { titulo: "Próximas", items: proximas },
    ];

  const filaTarea = (t: TareaAgenda, alerta?: boolean) => {
    const d = t.doctor;
    // preferir el chat de Periskope (ahí responde el equipo); wa.me de fallback
    const wa = d
      ? (periskopeLink(chatDe.get(d.id) ?? null) ??
        waLink(d.whatsapp ?? d.phone))
      : null;
    const tel = d ? telLink(d.phone ?? d.whatsapp) : null;
    const eventos = d ? (eventosDe.get(d.id) ?? []) : [];
    const ficha = d
      ? [
          CATEGORIA_LABELS[d.categoria as DoctorCategoria],
          [d.city, d.state ?? d.zona].filter(Boolean).join(", "),
          `${d.case_count} casos (${d.new_case_count} nuevos)`,
          tiposDe.get(d.id),
          d.last_contact_at
            ? `últ. contacto ${fmtDia(d.last_contact_at.slice(0, 10))}`
            : null,
          eventos.length
            ? `Asistió: ${eventos
                .slice(0, 2)
                .map((e) => e.titulo)
                .join(", ")}${eventos.length > 2 ? ` +${eventos.length - 2}` : ""}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
    return (
      <div
        key={t.id}
        className="flex items-start justify-between gap-3 px-3.5 py-2.5"
      >
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {d ? (
              <Link
                href={`/doctores/${d.id}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {d.nombre}
              </Link>
            ) : (
              <span className="line-clamp-1 font-medium">{t.title}</span>
            )}
            <Badge
              variant="outline"
              className="h-4.5 px-1.5 text-[10px] font-normal"
            >
              {TASK_TYPE_LABELS[t.type]}
            </Badge>
            <span
              className={cn(
                "text-xs tabular-nums text-muted-foreground",
                alerta && "font-medium text-red-600 dark:text-red-400"
              )}
            >
              {t.due_date ? fmtDia(t.due_date) : "sin fecha"}
            </span>
          </div>
          {d ? (
            <p
              className="mt-0.5 line-clamp-1 text-muted-foreground"
              title={t.title}
            >
              {t.title}
            </p>
          ) : null}
          {ficha ? (
            <p
              className="mt-0.5 line-clamp-1 text-xs text-muted-foreground/80"
              title={ficha}
            >
              {ficha}
            </p>
          ) : null}
        </div>
        {d ? (
          <div className="flex shrink-0 gap-1">
            {wa ? (
              <a
                href={wa}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({
                  variant: "outline",
                  size: "icon-sm",
                })}
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
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-4 p-6">
      {/* ---------- header ---------- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Panel de {nombre}
          </h1>
          <p className="text-sm text-muted-foreground">
            <span className="capitalize">{mesLabel}</span> — registro, agenda y
            números del mes ·{" "}
            <Link
              href={`/equipo/actividad?u=${u}`}
              className="underline underline-offset-2"
            >
              ver registro día por día
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {equipo.map((p) => (
            <Link key={p.id} href={`/panel?u=${p.id}`}>
              <Badge variant={p.id === u ? "default" : "outline"}>
                {p.nombre.split(" ")[0]}
              </Badge>
            </Link>
          ))}
        </div>
      </div>

      {/* ---------- números del mes ---------- */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((m) => (
          <div key={m.label} className="bg-background p-3">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {m.label}
            </div>
            <div className="mt-0.5 text-xl font-semibold tabular-nums">
              {m.value}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* la agenda de Google Calendar, con el brief de cada doctor ya
              armado. Devuelve null mientras esa persona no conectó su
              calendario (docs/CALENDAR.md) */}
          <AgendaHoy eventos={agendaCal} />

          {/* ---------- agenda ---------- */}
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Agenda — llamadas y reuniones planificadas
              </h2>
              <p className="text-xs text-muted-foreground">
                {esPropio ? "Tus tareas" : `Tareas de ${nombre}`} con cada
                doctor y su mini-ficha. Se crean desde la ficha del doctor o en
                Tareas.
              </p>
            </div>
            {agenda.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Sin llamadas ni reuniones planificadas. Creá una tarea desde la
                ficha de un doctor.
              </p>
            ) : (
              // filas compactas (doctor arriba, tarea y mini-ficha truncadas
              // abajo): con las cards grandes el panel era una pared (22/8)
              FRANJAS.map(({ titulo, items, alerta }) =>
                items.length === 0 ? null : (
                  <div key={titulo} className="space-y-1.5">
                    <h3
                      className={cn(
                        "text-[13px] font-semibold uppercase tracking-wide",
                        alerta && "text-red-600 dark:text-red-400"
                      )}
                    >
                      {titulo} · {items.length}
                    </h3>
                    <div className="divide-y rounded-lg border bg-card">
                      {items.slice(0, 6).map((t) => filaTarea(t, alerta))}
                      {items.length > 6 ? (
                        <details>
                          <summary className="cursor-pointer select-none px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                            Ver las {items.length - 6} restantes
                          </summary>
                          <div className="divide-y border-t">
                            {items.slice(6).map((t) => filaTarea(t, alerta))}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </div>
                )
              )
            )}
          </div>

          {/* ---------- reuniones realizadas ---------- */}
          <div className="space-y-2">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Reuniones y videollamadas del mes · {reuniones.length}
              </h2>
              <p className="text-xs text-muted-foreground">
                Con lo conversado y el resultado, como quedó registrado.
              </p>
            </div>
            {reuniones.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Todavía no hay reuniones registradas este mes — usá
                &ldquo;Registrar actividad&rdquo;.
              </p>
            ) : (
              <div className="divide-y rounded-lg border bg-card">
                {reuniones.slice(0, 15).map((a, i) => (
                  <div key={i} className="space-y-0.5 px-4 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tabular-nums text-muted-foreground">
                        {fmtTs.format(new Date(a.occurred_at))}
                      </span>
                      <Badge
                        variant="outline"
                        className="h-4.5 px-1.5 text-[10px] font-normal"
                      >
                        {ACTIVITY_TYPE_LABELS[a.type]}
                      </Badge>
                      {a.doctor ? (
                        <Link
                          href={`/doctores/${a.doctor.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {a.doctor.nombre}
                        </Link>
                      ) : null}
                    </div>
                    {a.summary ? <p>{a.summary}</p> : null}
                    {a.outcome ? (
                      <p className="text-muted-foreground">→ {a.outcome}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ---------- columna derecha ---------- */}
        <div className="space-y-6">
          {lastSignIn ? (
            <div className="space-y-2">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Ingresos al CRM
                </h2>
                <p className="text-xs text-muted-foreground">
                  Última entrada de cada uno. En día hábil, quien no entró
                  aparece en rojo; a las 17:30 de México sale la alarma por
                  Slack si alguien no entró ni cargó nada.
                </p>
              </div>
              <ul className="divide-y rounded-lg border bg-card text-sm">
                {equipo.map((p) => {
                  const ing = ingresoDe(lastSignIn.get(p.id));
                  return (
                    <li
                      key={p.id}
                      className="flex items-center justify-between px-4 py-2"
                    >
                      <span className="font-medium">
                        {p.nombre.split(" ")[0]}
                      </span>
                      <span
                        className={cn(
                          "text-xs tabular-nums",
                          !ing.hoy && esDiaHabil
                            ? "font-medium text-red-600 dark:text-red-400"
                            : "text-muted-foreground"
                        )}
                      >
                        {ing.label}
                        {!ing.hoy && esDiaHabil ? " · sin entrar hoy" : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <div className="space-y-2">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {esPropio ? "Mis pendientes" : `Pendientes de ${nombre}`}
              </h2>
              <p className="text-xs text-muted-foreground">
                {esPropio
                  ? "Tu libreta. Es tuya y no toca las tareas del CRM."
                  : `Lo que ${nombre} se anotó. Solo ${nombre} puede tacharlo.`}
              </p>
            </div>
            <PendientesCard pendientes={pendientes} editable={esPropio} />
          </div>

          <div className="space-y-2">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Registrar actividad
              </h2>
              <p className="text-xs text-muted-foreground">
                Llamada, reunión, WhatsApp o visita — queda en tu registro y en
                la ficha del doctor.
              </p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <QuickLog />
            </div>
          </div>

          <WaEsperandoLista
            chats={waEsperando as unknown as WaEsperando[]}
            miLinea={miLinea}
            total={waTotal}
          />

          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Tu mes por tipo
            </h2>
            {porTipo.size === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Sin actividades registradas este mes.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border bg-card text-sm">
                {[...porTipo.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([tipo, n]) => (
                    <li
                      key={tipo}
                      className="flex items-center justify-between px-4 py-2"
                    >
                      <span>{ACTIVITY_TYPE_LABELS[tipo]}</span>
                      <span className="tabular-nums font-medium">{n}</span>
                    </li>
                  ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Eventos registrados este mes: {eventosMes ?? 0} ·{" "}
              <Link href="/eventos" className="underline underline-offset-2">
                ver Eventos
              </Link>
            </p>
          </div>

          {paises && paises.filas.length > 0 ? (
            <div className="space-y-2">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {esPropio ? "Tu mes" : `El mes de ${nombre}`} en Noloco, por
                  país
                </h2>
                <p className="text-xs text-muted-foreground">
                  Solo lo {esPropio ? "tuyo" : "suyo"}: casos movidos donde
                  figura como asesor, y modificaciones/comunicaciones que
                  atendió. Directo de Noloco, se refresca ~cada hora.
                </p>
              </div>
              <div className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-medium">País</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Movidos
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Modif.
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Comunic.
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {paises.filas.map((f) => (
                      <tr key={f.pais}>
                        <td className="px-3 py-1.5 font-medium">
                          {PAIS_LABEL[f.pais] ?? f.pais}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {f.movidos}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {f.modificaciones}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {f.comunicaciones}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

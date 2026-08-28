import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { QuickActions } from "@/components/doctor/quick-actions";
import { DoctorAIPanel } from "@/components/ai/doctor-ai-panel";
import {
  MilestoneTrack,
  type MilestoneCase,
} from "@/components/ai/milestone-track";
import { periskopeLink } from "@/lib/phone";
import { Timeline, type TimelineEvent } from "@/components/doctor/timeline";
import { ProspectProfileCard } from "@/components/doctor/prospect-profile-card";
import { ObservacionesCard } from "@/components/doctor/observaciones-card";
import { TaskList } from "@/components/tasks/task-list";
import {
  ACREDITACION_STYLES,
  CATEGORIA_LABELS,
  CATEGORIA_STYLES,
  LIFECYCLE_STYLES,
  healthColor,
  relativeDays,
  formatDate,
  formatMXN,
  formatEtapa,
} from "@/lib/format";
import {
  ACTIVITY_TYPE_LABELS,
  LIFECYCLE_LABELS,
  OPP_STAGE_LABELS,
  type Activity,
  type Case,
  type Doctor,
  type Opportunity,
  type Task,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { todayMX } from "@/lib/dates";
import { Cake, PartyPopper } from "lucide-react";

/**
 * Años cumplidos entre dos fechas YYYY-MM-DD, contados por calendario (no por
 * milisegundos: los bisiestos hacen que 365 días no siempre sean un año).
 */
function aniosCumplidos(desde: string, hasta: string): number {
  const [dy, dm, dd] = desde.slice(0, 10).split("-").map(Number);
  const [hy, hm, hd] = hasta.slice(0, 10).split("-").map(Number);
  if (!dy || !hy) return 0;
  const n = hy - dy;
  return hm < dm || (hm === dm && hd < dd) ? n - 1 : n;
}

/**
 * Link de una red. Si quien cargó pegó la URL entera la respetamos; si escribió
 * solo el usuario, le ponemos la base delante. Es a propósito laxo: el valor lo
 * escribe una persona apurada, no un validador.
 */
function linkRed(base: string, valor: string): string {
  return /^https?:\/\//i.test(valor) ? valor : base + valor.replace(/^@/, "");
}

/**
 * El cumpleaños en es-MX. birth_date es un date pelado (YYYY-MM-DD): parsearlo
 * con new Date() lo lee como UTC y en México se corre un día para atrás, así
 * que se arma en UTC y se formatea en UTC. El año 1900 es el convenido para
 * "no sabemos el año" (migración 0040): se muestra solo el día y el mes.
 */
function formatCumple(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    ...(y <= 1900 ? {} : { year: "numeric" }),
  });
}

export default async function DoctorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: doctorRaw } = await supabase
    .from("doctors")
    .select("*")
    .eq("id", id)
    .single();
  if (!doctorRaw) notFound();
  const doctor = doctorRaw as Doctor;

  const [
    { data: casesRaw },
    { data: oppsRaw },
    { data: tasksRaw },
    { data: activitiesRaw },
    { data: auditRaw },
    { data: contactsRaw },
    { data: profilesRaw },
    { data: waChatsRaw },
  ] = await Promise.all([
    supabase
      .from("cases")
      .select("*")
      .eq("doctor_id", id)
      .order("fecha_ingreso", { ascending: false }),
    supabase
      .from("opportunities")
      .select("*")
      .eq("doctor_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("tasks")
      .select("*")
      .eq("doctor_id", id)
      .order("due_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("activities")
      .select("*")
      .eq("doctor_id", id)
      .order("occurred_at", { ascending: false })
      .limit(200),
    supabase
      .from("audit_log")
      .select("*")
      .eq("entity_type", "doctor")
      .eq("entity_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("contacts").select("*").eq("doctor_id", id),
    supabase.from("profiles").select("id, nombre"),
    supabase
      .from("wa_conversations")
      .select(
        "id, periskope_chat_id, chat_name, phone, unanswered, activity_bucket, lineas, asignado"
      )
      .eq("doctor_id", id),
  ]);

  const cases = (casesRaw ?? []) as Case[];
  const opps = (oppsRaw ?? []) as Opportunity[];
  const tasks = (tasksRaw ?? []) as Task[];
  const activities = (activitiesRaw ?? []) as Activity[];
  const profileName = new Map(
    ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [
      p.id,
      p.nombre,
    ])
  );

  const openOpps = opps.filter(
    (o) => o.stage !== "ganada" && o.stage !== "perdida"
  );
  const openTasks = tasks.filter((t) => t.status === "pendiente");
  const cases90 = cases.filter(
    (c) =>
      c.is_new_case &&
      Date.parse(c.fecha_ingreso) > Date.now() - 90 * 86_400_000
  ).length;

  // ---------- timeline unificada: actividades ∪ hitos de casos ∪ cambios auditados ----------
  const events: TimelineEvent[] = [];
  for (const a of activities) {
    events.push({
      id: `a-${a.id}`,
      kind: a.type,
      date: a.occurred_at,
      title: ACTIVITY_TYPE_LABELS[a.type] + (a.summary ? ` — ${a.summary}` : ""),
      detail: a.outcome,
      actor: a.created_by ? profileName.get(a.created_by) : undefined,
      isDemo: a.is_demo,
    });
  }
  for (const c of cases) {
    const label = c.id_externo ?? c.noloco_case_id;
    events.push({
      id: `c-${c.id}-in`,
      kind: "caso",
      date: c.fecha_ingreso,
      title: `Caso ${label} ingresado${c.etapa ? ` (${formatEtapa(c.etapa)})` : ""}`,
      detail: c.paciente ?? undefined,
      isDemo: c.is_demo,
    });
    if (c.fecha_aprobacion)
      events.push({
        id: `c-${c.id}-ap`,
        kind: "caso",
        date: c.fecha_aprobacion,
        title: `Caso ${label} aprobado`,
        isDemo: c.is_demo,
      });
    if (c.fecha_finalizado)
      events.push({
        id: `c-${c.id}-fin`,
        kind: "caso",
        date: c.fecha_finalizado,
        title: `Caso ${label} finalizado`,
        isDemo: c.is_demo,
      });
  }
  const AUDIT_FIELD_LABELS: Record<string, string> = {
    lifecycle_stage: "Estado",
    owner_id: "Owner",
    categoria: "Categoría",
    potential_override: "Potential (ajuste manual)",
  };
  for (const e of (auditRaw ?? []) as {
    id: string;
    field: string;
    old_value: string | null;
    new_value: string | null;
    created_at: string;
    actor_id: string | null;
  }[]) {
    const label = AUDIT_FIELD_LABELS[e.field] ?? e.field;
    const oldV =
      e.field === "owner_id"
        ? profileName.get(e.old_value ?? "") ?? "—"
        : e.old_value ?? "—";
    const newV =
      e.field === "owner_id"
        ? profileName.get(e.new_value ?? "") ?? "—"
        : e.new_value ?? "—";
    events.push({
      id: `au-${e.id}`,
      kind: "cambio",
      date: e.created_at,
      title: `${label}: ${oldV} → ${newV}`,
      actor: e.actor_id ? profileName.get(e.actor_id) : "Sistema",
    });
  }
  events.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const owner = doctor.owner_id ? profileName.get(doctor.owner_id) : null;
  const clinical = doctor.clinical_owner_id
    ? profileName.get(doctor.clinical_owner_id)
    : null;
  const potential = doctor.potential_override ?? doctor.potential_computed;

  const tieneRedes = Boolean(
    doctor.instagram ||
      doctor.facebook ||
      doctor.tiktok ||
      doctor.linkedin ||
      doctor.website
  );
  // años cumplidos como acreditado; solo se muestra a partir del primero, que
  // festejar "hace 0 años" no le sirve a nadie. El "hoy" es el de México, como
  // en todo el CRM (lib/dates.ts).
  const aniosAcreditado = doctor.accredited_at
    ? aniosCumplidos(doctor.accredited_at, todayMX())
    : 0;

  return (
    <div className="space-y-6 p-6">
      {/* ---------- header 360 ---------- */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">
                {doctor.nombre}
              </h1>
              {/* la distinción central del negocio: universo A o B */}
              <Badge
                variant="outline"
                className={cn(
                  "font-medium",
                  doctor.is_accredited
                    ? ACREDITACION_STYLES.si
                    : ACREDITACION_STYLES.no
                )}
              >
                {doctor.is_accredited
                  ? doctor.accredited_at
                    ? `Acreditado · ${formatDate(doctor.accredited_at)}`
                    : "Acreditado"
                  : "NO ACREDITADO"}
              </Badge>
              <Badge
                variant="outline"
                className={cn("font-normal", CATEGORIA_STYLES[doctor.categoria])}
              >
                {CATEGORIA_LABELS[doctor.categoria]}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  "font-normal",
                  LIFECYCLE_STYLES[doctor.lifecycle_stage]
                )}
              >
                {LIFECYCLE_LABELS[doctor.lifecycle_stage]}
              </Badge>
              {doctor.is_demo ? (
                <Badge variant="outline" className="font-normal">
                  Demo
                </Badge>
              ) : null}
            </div>
            <div className="text-sm text-muted-foreground">
              {[
                // ciudad y estado juntos: "Monterrey, Nuevo León". Antes era
                // `city ?? state` —el estado solo se veía si no había ciudad—,
                // que con la celda Estado nueva (Juan, 27/8) dejaba el dato
                // cargado fuera de la vista.
                [doctor.city, doctor.state].filter(Boolean).join(", ") || null,
                doctor.zona,
                doctor.clinic_name,
                owner ? `Owner: ${owner}` : "Sin owner",
                clinical ? `Clínica: ${clinical}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <QuickActions
            doctor={doctor}
            periskopeChatId={(waChatsRaw ?? [])[0]?.periskope_chat_id ?? null}
          />
        </div>

        {/* ---------- métricas ---------- */}
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4 lg:grid-cols-8">
          {[
            {
              label: "Health",
              value: doctor.health_score ?? "—",
              className: healthColor(doctor.health_score),
              hint:
                doctor.health_confidence === "cohort"
                  ? "estimado por categoría"
                  : doctor.health_confidence === "insuficiente"
                    ? "datos insuficientes"
                    : undefined,
            },
            { label: "Potential", value: potential ?? "—" },
            { label: "Prioridad", value: doctor.priority_score ?? "—" },
            { label: "Casos históricos", value: doctor.new_case_count },
            { label: "Últimos 90 días", value: cases90 },
            { label: "Opps abiertas", value: openOpps.length },
            {
              label: "Último caso",
              value: relativeDays(doctor.last_new_case_at),
              small: true,
            },
            {
              label: "Ritmo",
              value: doctor.avg_interval_days
                ? `cada ${Math.round(doctor.avg_interval_days)}d`
                : "—",
              small: true,
            },
          ].map((m) => (
            <div key={m.label} className="bg-background p-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {m.label}
              </div>
              <div
                className={cn(
                  "mt-0.5 tabular-nums",
                  m.small ? "text-sm" : "text-lg font-semibold",
                  m.className
                )}
              >
                {m.value}
              </div>
              {m.hint ? (
                <div className="text-[10px] text-muted-foreground">{m.hint}</div>
              ) : null}
            </div>
          ))}
        </div>

        {/* ---------- hitos del journey (se leen de los casos, no se infieren) ---------- */}
        <MilestoneTrack
          isAccredited={doctor.is_accredited}
          accreditedAt={doctor.accredited_at}
          cases={(casesRaw ?? []) as MilestoneCase[]}
        />

        {/* ---------- canal WhatsApp (export Periskope) ---------- */}
        <div className="rounded-lg border p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            WhatsApp (Periskope)
          </div>
          {(waChatsRaw ?? []).length === 0 ? (
            <p className="mt-1.5 text-sm text-muted-foreground">
              Sin chat identificado en las líneas MX (análisis 7/8).{" "}
              {doctor.whatsapp || doctor.phone
                ? "Se puede escribir igual con el botón WhatsApp de arriba."
                : "Tampoco hay teléfono cargado — conseguirlo vale oro."}
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1.5">
              {(waChatsRaw ?? []).map((w) => (
                <li
                  key={w.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                >
                  <a
                    href={periskopeLink(w.periskope_chat_id) ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    {w.chat_name ?? w.phone}
                  </a>
                  {w.unanswered ? (
                    <Badge className="border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-400">
                      esperando respuesta
                    </Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {w.activity_bucket === "7d"
                      ? "activo esta semana"
                      : w.activity_bucket === "30d"
                        ? "activo este mes"
                        : "sin actividad +30d"}
                    {w.asignado ? ` · atiende ${w.asignado}` : ""}
                    {(w.lineas ?? []).length
                      ? ` · línea …${String(w.lineas[0]).slice(-4)}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ---------- redes y fechas ----------
            Va al lado del bloque de WhatsApp porque para varios doctores las
            redes son el ÚNICO canal que tenemos: los que entraron por el censo
            de seguidores (20/8) no traen teléfono. El tag "sigue-instagram"
            dice que sigue la cuenta; sin el tag, el handle está pero la
            relación todavía no. Las otras cuatro redes y el cumpleaños son de
            la migración 0040 y se cargan desde el botón Redes de arriba. */}
        {tieneRedes || doctor.birth_date || aniosAcreditado ? (
          <div className="rounded-lg border p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Redes y fechas
            </div>
            {tieneRedes ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {doctor.instagram ? (
                  <a
                    href={`https://www.instagram.com/${doctor.instagram}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    @{doctor.instagram}
                  </a>
                ) : null}
                {(doctor.tags ?? []).includes("sigue-instagram") ? (
                  <Badge className="border-pink-200 bg-pink-50 text-pink-700 dark:border-pink-900 dark:bg-pink-950 dark:text-pink-400">
                    te sigue
                  </Badge>
                ) : null}
                {(doctor.tags ?? [])
                  .filter((t) => t.startsWith("ig-alt:"))
                  .map((t) => (
                    <a
                      key={t}
                      href={`https://www.instagram.com/${t.slice(7)}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      @{t.slice(7)}
                    </a>
                  ))}
                {doctor.facebook ? (
                  <a
                    href={linkRed("https://www.facebook.com/", doctor.facebook)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    Facebook
                  </a>
                ) : null}
                {doctor.tiktok ? (
                  <a
                    href={linkRed("https://www.tiktok.com/@", doctor.tiktok)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    TikTok
                  </a>
                ) : null}
                {doctor.linkedin ? (
                  <a
                    href={linkRed("https://www.linkedin.com/in/", doctor.linkedin)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    LinkedIn
                  </a>
                ) : null}
                {doctor.website ? (
                  <a
                    href={linkRed("https://", doctor.website)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    Sitio web
                  </a>
                ) : null}
              </div>
            ) : null}
            {doctor.birth_date || aniosAcreditado ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                {doctor.birth_date ? (
                  <span className="flex items-center gap-1.5">
                    <Cake className="h-3.5 w-3.5" />
                    Cumple el {formatCumple(doctor.birth_date)}
                  </span>
                ) : null}
                {aniosAcreditado ? (
                  <span className="flex items-center gap-1.5">
                    <PartyPopper className="h-3.5 w-3.5" />
                    Acreditado hace {aniosAcreditado}{" "}
                    {aniosAcreditado === 1 ? "año" : "años"}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ---------- perfil de prospecto (solo universo A) ---------- */}
        {/* Ya no desaparece al acreditarse. Lo que el área "Por acreditarse"
            aprendió —especialidad, interés, casos estimados, por qué era
            interesante— se quedaba en la fila y dejaba de verse justo el día
            que el doctor pasaba a importar. Del lado acreditado se muestra
            plegado y de solo lectura. */}
        <ProspectProfileCard doctor={doctor} />

        {/* ---------- notas libres ----------
            Lo único de la ficha que no deduce ningún sistema: lo que el equipo
            sabe de la relación. Es lo PRIMERO que usa el brief previo a la
            llamada (lib/brief-doctor.ts), por encima de cualquier regla. */}
        <div className="space-y-2">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Observaciones
            </h2>
            <p className="text-xs text-muted-foreground">
              Lo que anotes acá es lo primero que vas a leer antes de llamarlo.
            </p>
          </div>
          <ObservacionesCard
            doctorId={doctor.id}
            observaciones={doctor.observaciones}
          />
        </div>

        {/* ---------- inteligencia comercial (AI + motor de reglas) ---------- */}
        <DoctorAIPanel doctorId={doctor.id} />
      </div>

      {/* ---------- tabs ---------- */}
      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="casos">Casos ({cases.length})</TabsTrigger>
          <TabsTrigger value="opps">
            Oportunidades ({openOpps.length})
          </TabsTrigger>
          <TabsTrigger value="tareas">Tareas ({openTasks.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="mt-4">
          <Timeline events={events} />
        </TabsContent>

        <TabsContent value="casos" className="mt-4">
          {cases.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Sin casos todavía.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Caso</TableHead>
                    <TableHead>Paciente</TableHead>
                    <TableHead>Etapa</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Ingreso</TableHead>
                    <TableHead>Aprobado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cases.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">
                        {c.id_externo ?? c.noloco_case_id}
                        {c.is_new_case ? (
                          <Badge
                            variant="outline"
                            className="ml-2 font-normal text-emerald-700 dark:text-emerald-400"
                          >
                            Nuevo
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>{c.paciente ?? "—"}</TableCell>
                      <TableCell>{formatEtapa(c.etapa)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.tipo_tratamiento ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(c.fecha_ingreso)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(c.fecha_aprobacion)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="opps" className="mt-4">
          {opps.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Sin oportunidades. Creá una desde “Oportunidad” en las acciones
              rápidas.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Paciente</TableHead>
                    <TableHead>Etapa</TableHead>
                    <TableHead className="text-right">Prob.</TableHead>
                    <TableHead className="text-right">Monto</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>En etapa desde</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {opps.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">
                        {o.patient_name ?? "—"}
                      </TableCell>
                      <TableCell>{OPP_STAGE_LABELS[o.stage]}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {o.probability != null ? `${o.probability}%` : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMXN(o.amount_mxn)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {o.owner_id ? profileName.get(o.owner_id) : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {relativeDays(o.stage_entered_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="tareas" className="mt-4">
          <TaskList
            tasks={tasks}
            profileName={Object.fromEntries(profileName)}
            emptyMessage="Sin tareas para este doctor. Creá una desde las acciones rápidas."
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

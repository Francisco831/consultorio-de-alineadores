import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { buttonVariants } from "@/components/ui/button";
import { RegistrarViabilidad } from "@/components/seguimiento/registrar-viabilidad";
import { waLink } from "@/lib/phone";
import { todayMX } from "@/lib/dates";
import { formatDate, formatTipoTratamiento } from "@/lib/format";
import { VIABILITY_STATUS_LABELS, type ViabilityStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MessageCircle } from "lucide-react";

// ---------------------------------------------------------------------------
// /seguimiento — las tres colas donde el CRM espera que alguien de AFUERA
// conteste: la doctora que tiene que aprobar un render, el render que la doctora
// ya rechazó y hay que rehacer, y el equipo clínico que debe una viabilidad.
//
// DE DÓNDE SALE LA VERDAD DEL RENDER (26/8/26). Hasta hoy el CRM inferí­a "está
// esperando" de cases.fecha_video sin fecha_aprobacion_video, y eso daba 98 casos
// que no eran. Contra el portal keepsmiling-v2: 62 esperaban de verdad, 34 ya
// habían sido RECHAZADOS y 2 ya habían avanzado de etapa. Un tercio de la lista
// era trabajo que nadie debía.
//
// Ahora manda v2 (lib/render-v2-sync.ts, cron cada 2 h, migración 0045):
//   esperando = video_stage 'ATENCION' + video_sub_stage 'PENDIENTE_APROBACION_RENDER'
//   rechazado = video_stage 'RECHAZADO'
// Hacen falta LAS DOS columnas: 32 de los 72 rechazados conservan el subStage
// PENDIENTE_APROBACION_RENDER, así que filtrar solo por subStage vuelve a mentir.
//
// Y el backlog viejo SÍ es real: de los 63 que esperan, 38 tienen más de 90 días
// (mediana 219). No son fechas sin cerrar — v2 confirma que siguen parados. Van
// abajo y colapsados para que la pantalla se lea, no porque no cuenten.
// ---------------------------------------------------------------------------

/** Antes de 7 días el render está en plazo: no molestamos a la doctora. */
const DIAS_EN_PLAZO = 7;
/** A los 14 pasa a rojo (una semana de recordatorio ya se comió). */
const DIAS_ROJO = 14;
/** Más de 90 días: sigue esperando (v2 lo confirma), pero es backlog, no el día a día. */
const DIAS_BACKLOG = 90;

interface CaseRow {
  id: string;
  id_externo: string | null;
  paciente: string | null;
  tipo_tratamiento: string | null;
  fecha_video: string | null;
  fecha_rechazado: string | null;
  doctor_id: string;
  doctors: {
    id: string;
    nombre: string;
    whatsapp: string | null;
    phone: string | null;
  } | null;
}

interface OppRow {
  id: string;
  patient_name: string | null;
  stage: string;
  stage_entered_at: string;
  viability_status: ViabilityStatus | null;
  viability_requested_at: string | null;
  viability_follow_up_date: string | null;
  doctor_id: string;
  doctors: { id: string; nombre: string } | null;
}

const MX_DIA = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Mexico_City",
});

/** El día mexicano de un valor que puede ser fecha pura (cases.fecha_video) o
 *  instante (opportunities.stage_entered_at, timestamptz). */
function diaMX(valor: string): string {
  return valor.length <= 10 ? valor.slice(0, 10) : MX_DIA.format(new Date(valor));
}

function plural(dias: number): string {
  return dias === 1 ? "1 día" : `${dias} días`;
}

/** ámbar hasta 13, rojo de 14 en adelante; el tramo viejo va en gris aparte */
function semaforo(dias: number): string {
  return dias >= DIAS_ROJO
    ? "text-red-600 dark:text-red-400"
    : "text-amber-600 dark:text-amber-400";
}

export default async function SeguimientoPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;
  const tab =
    t === "viabilidades" ? "viabilidades" : t === "rechazados" ? "rechazados" : "renders";
  const supabase = await createClient();

  const SELECT_CASO =
    "id, id_externo, paciente, tipo_tratamiento, fecha_video, fecha_rechazado, doctor_id, doctors(id, nombre, whatsapp, phone)";

  const [{ data: casesRaw }, { data: rechRaw }, { data: oppsRaw }] = await Promise.all([
    // esperando: lo que dice el portal v2, no lo que se infiere de las fechas.
    // is_demo fuera, como en /hoy: las filas del seed cuelgan de doctoras reales.
    supabase
      .from("cases")
      .select(SELECT_CASO)
      .eq("video_stage", "ATENCION")
      .eq("video_sub_stage", "PENDIENTE_APROBACION_RENDER")
      .eq("is_demo", false)
      .order("fecha_video", { ascending: true, nullsFirst: false }),
    // rechazados: la doctora ya contestó y dijo que no. La pelota es NUESTRA.
    supabase
      .from("cases")
      .select(SELECT_CASO)
      .eq("video_stage", "RECHAZADO")
      .is("fecha_aprobacion_video", null)
      .eq("is_demo", false)
      .order("fecha_rechazado", { ascending: true, nullsFirst: false }),
    supabase
      .from("opportunities")
      .select(
        "id, patient_name, stage, stage_entered_at, viability_status, viability_requested_at, viability_follow_up_date, doctor_id, doctors(id, nombre)"
      )
      .not("stage", "in", "(ganada,perdida)")
      .is("viability_completed_at", null)
      .eq("is_demo", false)
      .order("stage_entered_at", { ascending: true }),
  ]);

  // el reloj se cuenta contra el día de México, no contra la hora UTC del server
  const hoyMS = Date.parse(`${todayMX()}T00:00:00Z`);
  const dias = (valor: string) =>
    Math.floor((hoyMS - Date.parse(`${diaMX(valor)}T00:00:00Z`)) / 86_400_000);

  const casos = (casesRaw ?? []) as unknown as CaseRow[];
  const rechazados = (rechRaw ?? []) as unknown as CaseRow[];
  // sin fecha de video no hay reloj: lo tratamos como recién salido para no
  // inventarle una antigüedad (pasa en 1 de los 63 al 26/8)
  const diasCaso = (c: CaseRow) => (c.fecha_video ? dias(c.fecha_video) : 0);

  const enPlazo = casos.filter((c) => diasCaso(c) < DIAS_EN_PLAZO);
  const esperando = casos.filter((c) => {
    const d = diasCaso(c);
    return d >= DIAS_EN_PLAZO && d <= DIAS_BACKLOG;
  });
  const backlog = casos.filter((c) => diasCaso(c) > DIAS_BACKLOG);
  const rendersRojos = esperando.filter((c) => diasCaso(c) >= DIAS_ROJO).length;

  // 4 doctoras concentran la mitad de la cola: agrupar es lo que convierte la
  // lista en una acción ("hablarle a Lorena por sus 4"), no en un inventario
  const grupos = new Map<string, { doctor: CaseRow["doctors"]; casos: CaseRow[] }>();
  for (const c of esperando) {
    const g = grupos.get(c.doctor_id);
    if (g) g.casos.push(c);
    else grupos.set(c.doctor_id, { doctor: c.doctors, casos: [c] });
  }
  // `esperando` ya viene del más viejo al más nuevo: el primero de cada grupo es
  // su caso más viejo, y con eso se ordenan los grupos entre sí
  const gruposOrdenados = [...grupos.values()].sort(
    (a, b) => diasCaso(b.casos[0]) - diasCaso(a.casos[0])
  );

  const opps = (oppsRaw ?? []) as unknown as OppRow[];
  // esperando = sigue abierta y el ciclo no se cerró: o quedó registrada como
  // solicitada/enviada, o la oportunidad está parada en la etapa Viabilidad
  const viabilidades = opps.filter(
    (o) =>
      o.stage === "viabilidad" ||
      o.viability_status === "solicitada" ||
      o.viability_status === "enviada"
  );
  // el reloj arranca en la solicitud; cuando nadie la cargó, en la entrada a la etapa
  const desdeViab = (o: OppRow) => o.viability_requested_at ?? o.stage_entered_at;
  const viabRojas = viabilidades.filter(
    (o) => dias(desdeViab(o)) >= DIAS_ROJO
  ).length;

  const tiles = [
    { label: "Renders esperando", value: casos.length },
    {
      label: "Renders 14+ días",
      value: rendersRojos,
      className: rendersRojos ? "text-red-600 dark:text-red-400" : undefined,
    },
    {
      label: "Rechazados sin rehacer",
      value: rechazados.length,
      className: rechazados.length ? "text-orange-600 dark:text-orange-400" : undefined,
    },
    { label: "Viabilidades esperando", value: viabilidades.length },
    {
      label: "Viabilidades 14+ días",
      value: viabRojas,
      className: viabRojas ? "text-red-600 dark:text-red-400" : undefined,
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Seguimiento</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Lo que está esperando que alguien conteste: renders que la doctora no
            aprobó, renders que rechazó y hay que rehacer, y viabilidades sin
            respuesta del equipo clínico.
          </p>
          <p className="max-w-2xl text-sm text-muted-foreground">
            El estado del render lo dice el portal de producción, no una fecha
            inferida (se sincroniza cada 2 horas); las viabilidades se cargan a
            mano desde acá.
          </p>
        </div>
        <div className="flex gap-1">
          {[
            { key: "renders", label: `Renders · ${casos.length}` },
            { key: "rechazados", label: `Rechazados · ${rechazados.length}` },
            { key: "viabilidades", label: `Viabilidades · ${viabilidades.length}` },
          ].map((x) => (
            <Link
              key={x.key}
              href={x.key === "renders" ? "/seguimiento" : `/seguimiento?t=${x.key}`}
              className={buttonVariants({
                variant: tab === x.key ? "secondary" : "ghost",
                size: "sm",
              })}
            >
              {x.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-5">
        {tiles.map((m) => (
          <div key={m.label} className="bg-background p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {m.label}
            </div>
            <div
              className={cn(
                "mt-0.5 text-2xl font-semibold tabular-nums",
                m.className
              )}
            >
              {m.value}
            </div>
          </div>
        ))}
      </div>

      {tab === "renders" ? (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Renders esperando aprobación
            </h2>
            <p className="text-xs text-muted-foreground">
              Agrupados por doctora, del que más espera al que menos. Ámbar de 7
              a 13 días, rojo a partir de 14 · {enPlazo.length} todavía en plazo
              (menos de 7 días, no molestamos a nadie)
            </p>
          </div>

          {gruposOrdenados.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Ningún render esperando hace más de una semana. Todo lo que se
              mandó está en plazo.
            </p>
          ) : (
            <div className="space-y-3">
              {gruposOrdenados.map(({ doctor, casos: lista }) => {
                const wa = waLink(doctor?.whatsapp ?? doctor?.phone ?? null);
                return (
                  <div key={doctor?.id ?? lista[0].id} className="rounded-lg border">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                      <div className="min-w-0">
                        {doctor ? (
                          <Link
                            href={`/doctores/${doctor.id}`}
                            className="font-medium hover:underline"
                          >
                            {doctor.nombre}
                          </Link>
                        ) : (
                          <span className="font-medium">Sin doctora asignada</span>
                        )}
                        <span className="ml-1.5 text-sm text-muted-foreground">
                          ·{" "}
                          {lista.length === 1
                            ? "1 render parado"
                            : `${lista.length} renders parados`}
                        </span>
                      </div>
                      {wa ? (
                        <a
                          href={wa}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={buttonVariants({
                            variant: "outline",
                            size: "sm",
                          })}
                        >
                          <MessageCircle className="mr-1.5 h-4 w-4" />
                          Empujar por WhatsApp
                        </a>
                      ) : null}
                    </div>
                    <ul className="divide-y">
                      {lista.map((c) => {
                        const d = diasCaso(c);
                        return (
                          <li
                            key={c.id}
                            className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm"
                          >
                            <div className="min-w-0">
                              <span className="font-medium">
                                {c.paciente ?? "Sin paciente"}
                              </span>
                              <span className="text-muted-foreground">
                                {c.id_externo ? ` · ${c.id_externo}` : ""} ·{" "}
                                {formatTipoTratamiento(c.tipo_tratamiento)}
                              </span>
                            </div>
                            <span
                              className={cn(
                                "shrink-0 tabular-nums",
                                semaforo(d)
                              )}
                              title={
                                c.fecha_video
                                  ? `Video enviado el ${formatDate(c.fecha_video)}`
                                  : "Sin fecha de video cargada en Noloco"
                              }
                            >
                              {c.fecha_video ? `${plural(d)} esperando` : "recién"}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}

          {backlog.length > 0 ? (
            <details className="rounded-lg border">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                Backlog viejo · {backlog.length} renders con más de 90 días
              </summary>
              <p className="border-t px-4 py-3 text-xs text-muted-foreground">
                Siguen esperando de verdad — el portal de producción los tiene en
                Atención, pendientes de aprobación del render. No son fechas sin
                cerrar. Están acá abajo para que la lista de arriba se pueda
                trabajar, no porque no cuenten.
              </p>
              <ul className="divide-y border-t">
                {backlog.map((c) => (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2 text-sm text-muted-foreground"
                  >
                    <div className="min-w-0">
                      {c.doctors ? (
                        <Link
                          href={`/doctores/${c.doctors.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {c.doctors.nombre}
                        </Link>
                      ) : (
                        <span className="font-medium text-foreground">—</span>
                      )}
                      <span>
                        {" "}
                        · {c.paciente ?? "Sin paciente"}
                        {c.id_externo ? ` · ${c.id_externo}` : ""}
                      </span>
                    </div>
                    <span className="shrink-0 tabular-nums">
                      {plural(diasCaso(c))}
                      {c.fecha_video ? ` · video del ${formatDate(c.fecha_video)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : tab === "rechazados" ? (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Renders rechazados, sin rehacer
            </h2>
            <p className="text-xs text-muted-foreground">
              Acá la doctora YA contestó: dijo que no. La pelota es nuestra —
              corregir el setup y volver a publicar. Hasta hoy estos casos se
              mezclaban con los que esperan respuesta y parecían culpa de ella.
            </p>
          </div>

          {rechazados.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Ningún render rechazado pendiente de rehacer.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {rechazados.map((c) => {
                const d = c.fecha_rechazado ? dias(c.fecha_rechazado) : null;
                return (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm"
                  >
                    <div className="min-w-0">
                      {c.doctors ? (
                        <Link
                          href={`/doctores/${c.doctors.id}`}
                          className="font-medium hover:underline"
                        >
                          {c.doctors.nombre}
                        </Link>
                      ) : (
                        <span className="font-medium">Sin doctora</span>
                      )}
                      <span className="text-muted-foreground">
                        {" "}
                        · {c.paciente ?? "Sin paciente"}
                        {c.id_externo ? ` · ${c.id_externo}` : ""} ·{" "}
                        {formatTipoTratamiento(c.tipo_tratamiento)}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 tabular-nums",
                        d != null && d >= DIAS_ROJO
                          ? "text-red-600 dark:text-red-400"
                          : "text-muted-foreground"
                      )}
                    >
                      {d != null
                        ? `rechazado hace ${plural(d)}`
                        : "sin fecha de rechazo"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Viabilidades esperando respuesta
            </h2>
            <p className="text-xs text-muted-foreground">
              De la más vieja a la más nueva. El reloj arranca cuando se pidió la
              viabilidad; si esa fecha no se cargó, cuenta desde que la
              oportunidad entró a la etapa.
            </p>
          </div>

          {viabilidades.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Ninguna viabilidad esperando respuesta.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {viabilidades
                .slice()
                .sort((a, b) => dias(desdeViab(b)) - dias(desdeViab(a)))
                .map((o) => {
                  const d = dias(desdeViab(o));
                  return (
                    <li
                      key={o.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-1.5">
                          {o.doctors ? (
                            <Link
                              href={`/doctores/${o.doctors.id}`}
                              className="font-medium hover:underline"
                            >
                              {o.doctors.nombre}
                            </Link>
                          ) : (
                            <span className="font-medium">Sin doctora</span>
                          )}
                          <span className="text-sm text-muted-foreground">
                            · {o.patient_name ?? "Sin paciente"}
                          </span>
                          <span
                            className={cn(
                              "text-sm tabular-nums",
                              semaforo(d)
                            )}
                          >
                            · {plural(d)} esperando
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {o.viability_status ? (
                            VIABILITY_STATUS_LABELS[o.viability_status]
                          ) : (
                            // dato FALTANTE: nadie cargó el ciclo. No dice que
                            // no se haya pedido ni que no la hayan contestado.
                            <span className="italic">
                              sin registro del ciclo — nadie cargó en qué anda
                            </span>
                          )}
                          {o.viability_follow_up_date
                            ? ` · volver a mirar el ${formatDate(o.viability_follow_up_date)}`
                            : ""}
                        </p>
                      </div>
                      <RegistrarViabilidad
                        opportunityId={o.id}
                        paciente={o.patient_name}
                        estadoActual={o.viability_status}
                      />
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

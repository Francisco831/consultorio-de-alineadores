// Calidad de datos — la página que hace visible qué sabe y qué NO sabe la IA.
//
// Las tres colas de acá son las tres cosas que el sistema NO puede deducir solo
// (migración 0022): de quién es un caso, si una interacción fue conversación
// real, y si una alerta amenaza de verdad la confianza del doctor. Mientras no
// estén revisadas, la capa AI las trata como desconocidas y lo dice — no las
// inventa.

import { createClient } from "@/lib/supabase/server";
import { DataReadiness } from "@/components/ai/data-readiness";
import {
  CaseSubjectReview,
  type CaseReviewRow,
} from "@/components/quality/case-subject-review";
import {
  ActivityReview,
  type ActivityReviewRow,
} from "@/components/quality/activity-review";
import { buttonVariants } from "@/components/ui/button";
import { reviewServiceAlert } from "@/lib/actions/quality";
import { formatDate, relativeDays } from "@/lib/format";
import { cn } from "@/lib/utils";

const MANAGER_ROLES = ["ADMIN", "COUNTRY_MANAGER", "SALES_MANAGER"];

/** Alertas que el motor determinístico marca como problema de servicio
 *  (mismo set que usa el Context Engine para service_issues). */
const SERVICE_RULE_KEYS = [
  "caso_atrasado",
  "aprobacion_pendiente",
  "oportunidad_estancada",
];

const CONFIDENCE_OPTIONS: { value: string; label: string }[] = [
  { value: "CONFIRMED", label: "Confirmado" },
  { value: "LIKELY", label: "Probable" },
  { value: "POSSIBLE", label: "Posible" },
];

const IMPACT_FACTORS: { value: string; label: string }[] = [
  { value: "dias_atraso", label: "Días de atraso" },
  { value: "sla_incumplido", label: "SLA incumplido" },
  { value: "queja_registrada", label: "Queja registrada" },
  { value: "problema_repetido", label: "Problema repetido" },
  { value: "caso_bloqueado", label: "Caso bloqueado" },
  { value: "pedido_sin_responder", label: "Pedido sin responder" },
  { value: "paciente_afectado", label: "Paciente afectado" },
  { value: "problema_administrativo", label: "Problema administrativo" },
  { value: "problema_clinico", label: "Problema clínico" },
];

interface AlertRow {
  id: string;
  doctor_id: string | null;
  rule_key: string;
  severity: string;
  title: string;
  reason: string | null;
  created_at: string;
}

const NUM = new Intl.NumberFormat("es-MX");

export default async function CalidadPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user!.id)
    .single();
  const isManager = MANAGER_ROLES.includes(profile?.rol ?? "");

  if (!isManager) {
    return (
      <div className="max-w-4xl space-y-6 p-6">
        <Header />
        <DataReadiness />
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          Las colas de clasificación las revisa un manager. Los números de arriba
          son los mismos que ve la capa AI.
        </p>
      </div>
    );
  }

  // ---------- pendientes (conteos exactos, nunca un select que se trunca) ----------
  const [
    casesPending,
    actsPending,
    alertsPending,
    caseQueue,
    { data: actsRaw, error: actsError },
    { data: alertsRaw, error: alertsError },
  ] = await Promise.all([
    supabase
      .from("cases")
      .select("id", { count: "exact", head: true })
      .eq("is_demo", false)
      .eq("case_subject_type", "UNKNOWN")
      .is("case_subject_source", null),
    supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("is_demo", false)
      .eq("engagement_quality", "UNKNOWN")
      .is("engagement_source", null),
    supabase
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .eq("is_demo", false)
      .eq("status", "abierta")
      .in("rule_key", SERVICE_RULE_KEYS)
      .is("service_confidence", null),
    // la cola de casos se ordena en la base por case_self_similarity (0024):
    // pedir la función caso por caso serían ~1.000 llamadas
    supabase.rpc("case_subject_review_queue", { p_limit: 40 }),
    supabase
      .from("activities")
      .select("id, doctor_id, type, occurred_at, summary, outcome")
      .eq("is_demo", false)
      .eq("engagement_quality", "UNKNOWN")
      .is("engagement_source", null)
      .order("occurred_at", { ascending: false })
      .limit(25),
    supabase
      .from("alerts")
      .select("id, doctor_id, rule_key, severity, title, reason, created_at")
      .eq("is_demo", false)
      .eq("status", "abierta")
      .in("rule_key", SERVICE_RULE_KEYS)
      .is("service_confidence", null)
      .order("created_at", { ascending: true })
      .limit(15),
  ]);

  const caseRows = (caseQueue.data ?? []) as CaseReviewRow[];
  const acts = (actsRaw ?? []) as Omit<ActivityReviewRow, "doctor_nombre">[];
  const alerts = (alertsRaw ?? []) as AlertRow[];

  // nombres de doctores para las dos colas que no los traen
  const doctorIds = [
    ...new Set(
      [...acts.map((a) => a.doctor_id), ...alerts.map((a) => a.doctor_id)].filter(
        (x): x is string => x != null
      )
    ),
  ];
  const { data: doctorsRaw } = doctorIds.length
    ? await supabase.from("doctors").select("id, nombre").in("id", doctorIds)
    : { data: [] };
  const doctorName = new Map(
    ((doctorsRaw ?? []) as { id: string; nombre: string }[]).map((d) => [
      d.id,
      d.nombre,
    ])
  );

  const activityRows: ActivityReviewRow[] = acts.map((a) => ({
    ...a,
    doctor_nombre: a.doctor_id ? (doctorName.get(a.doctor_id) ?? null) : null,
  }));

  const count = (r: { count: number | null; error: unknown }) =>
    r.error ? null : (r.count ?? 0);

  return (
    <div className="max-w-4xl space-y-8 p-6">
      <Header />

      <DataReadiness />

      {/* ---------- casos: ¿de quién es este tratamiento? ---------- */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Casos sin clasificar
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            El journey de México es acreditación → caso propio → primer caso de
            paciente → repetición. Sin saber de quién es cada caso, el hito de
            activación no se puede afirmar: “tuvo un caso después de acreditarse”
            no significa que haya tratado a un paciente.
          </p>
        </div>
        {caseQueue.error ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No se pudo leer la cola de casos: {caseQueue.error.message}. Falta
            aplicar la migración 0024 (case_subject_review_queue).
          </p>
        ) : (
          <CaseSubjectReview rows={caseRows} pending={count(casesPending)} />
        )}
      </section>

      {/* ---------- interacciones: ¿conversación real o toque? ---------- */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Interacciones sin clasificar
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Un saludo no es una conversación. Hasta que alguien lo diga, el reloj
            de contacto significativo no corre y ningún agente puede concluir
            abandono a partir de esto.
          </p>
        </div>
        {actsError ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No se pudo leer la cola de interacciones: {actsError.message}
          </p>
        ) : (
          <ActivityReview rows={activityRows} pending={count(actsPending)} />
        )}
      </section>

      {/* ---------- alertas: ¿esto daña la confianza de verdad? ---------- */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Alertas de servicio sin calificar
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            La pregunta no es “¿hay una alerta?” sino “¿esto puede dañar la
            confianza del doctor?”. Sin esta revisión, la capa AI deriva el
            impacto de la regla y del atraso, y lo declara como estimación.
          </p>
        </div>
        {alertsError ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No se pudieron leer las alertas: {alertsError.message}
          </p>
        ) : alerts.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No hay alertas de servicio abiertas sin calificar.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {count(alertsPending) != null
                ? `${NUM.format(count(alertsPending)!)} alertas de servicio sin calificar`
                : "Pendientes sin medir"}
              {" · "}
              mostrando {alerts.length}, las más viejas primero.
            </p>
            <ul className="divide-y rounded-lg border">
              {alerts.map((a) => (
                <li key={a.id} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium">{a.title}</span>
                    <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {a.rule_key} · {a.severity}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {a.doctor_id
                        ? (doctorName.get(a.doctor_id) ?? "Doctor sin nombre")
                        : "Sin doctor"}{" "}
                      · abierta {relativeDays(a.created_at)} ({formatDate(a.created_at)})
                    </span>
                  </div>
                  {a.reason ? (
                    <p className="text-xs text-muted-foreground">{a.reason}</p>
                  ) : null}

                  <form
                    action={reviewServiceAlert}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <input type="hidden" name="alert_id" value={a.id} />
                    <select
                      name="service_confidence"
                      required
                      defaultValue=""
                      aria-label="Confianza del problema de servicio"
                      className="h-8 rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="" disabled>
                        ¿Hay problema?
                      </option>
                      {CONFIDENCE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      name="trust_risk_score"
                      min={0}
                      max={100}
                      step={1}
                      placeholder="Riesgo 0-100"
                      aria-label="Riesgo de confianza (0-100)"
                      className="h-8 w-32 rounded-md border bg-background px-2 text-sm tabular-nums"
                    />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {IMPACT_FACTORS.map((f) => (
                        <label
                          key={f.value}
                          htmlFor={`${a.id}-${f.value}`}
                          className="flex items-center gap-1 text-[11px] text-muted-foreground"
                        >
                          <input
                            id={`${a.id}-${f.value}`}
                            type="checkbox"
                            name="impact_factors"
                            value={f.value}
                            className="size-3.5 rounded border-border"
                          />
                          {f.label}
                        </label>
                      ))}
                    </div>
                    <button
                      type="submit"
                      className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
                    >
                      Guardar impacto
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function Header() {
  return (
    <div className="space-y-1">
      <h1 className="text-lg font-semibold tracking-tight">Calidad de datos</h1>
      <p className="text-sm text-muted-foreground">
        Lo que la IA sabe y lo que no. Un dato desconocido vale más que uno
        inventado: mientras algo esté sin clasificar, los agentes lo declaran
        desconocido en vez de deducirlo.
      </p>
    </div>
  );
}

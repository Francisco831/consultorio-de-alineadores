// Data readiness — qué sabe y qué NO sabe la capa AI, con los porcentajes
// reales de la base. El sentido de este panel es que la falta de dato se vea:
// un agente que razona sobre 0% de casos clasificados no puede afirmar en qué
// hito está un doctor, y eso tiene que estar a la vista antes de leerle una
// recomendación.
//
// Server Component asíncrono: lee con el cliente de sesión (RLS). Intenta
// primero el RPC ai_data_quality() (módulo A); si no existe o falla, mide con
// consultas de conteo. Si una medición falla, se dice "sin medir" — nunca 0%.

import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export interface ReadinessMetric {
  key: string;
  label: string;
  covered: number | null;
  total: number | null;
  detail: string | null;
  /** Qué NO puede hacer la capa AI mientras esto esté incompleto. */
  blocks: string;
}

const NUM = new Intl.NumberFormat("es-MX");

function pct(m: ReadinessMetric): number | null {
  if (m.covered == null || m.total == null || m.total === 0) return null;
  return Math.round((m.covered / m.total) * 100);
}

function barColor(p: number | null): string {
  if (p == null) return "bg-muted-foreground/30";
  if (p >= 80) return "bg-emerald-500";
  if (p >= 40) return "bg-amber-500";
  return "bg-red-500";
}

/** Lectura tolerante del RPC del módulo A: solo se usa si trae las 6 métricas
 *  con números; si no, se mide acá. Nunca se mezclan las dos fuentes. */
function parseRpc(
  raw: unknown,
  keys: string[]
): Map<string, { covered: number; total: number }> | null {
  if (!raw || typeof raw !== "object") return null;
  const rows: Record<string, unknown>[] = Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
    : Object.entries(raw as Record<string, unknown>).map(([k, v]) =>
        v && typeof v === "object"
          ? { key: k, ...(v as Record<string, unknown>) }
          : { key: k, value: v }
      );
  const out = new Map<string, { covered: number; total: number }>();
  for (const r of rows) {
    const key = String(r.key ?? r.metric ?? r.name ?? "");
    const covered = Number(r.covered ?? r.con_dato ?? r.ok);
    const total = Number(r.total ?? r.universo);
    if (key && Number.isFinite(covered) && Number.isFinite(total)) {
      out.set(key, { covered, total });
    }
  }
  return keys.every((k) => out.has(k)) ? out : null;
}

export async function DataReadiness() {
  const supabase = await createClient();

  const doctors = () => supabase.from("doctors").select("id", { count: "exact", head: true }).eq("is_demo", false);
  const cases = () => supabase.from("cases").select("id", { count: "exact", head: true }).eq("is_demo", false);
  const activities = () => supabase.from("activities").select("id", { count: "exact", head: true }).eq("is_demo", false);

  const [
    rpc,
    docTotal,
    accredited,
    accreditedWithDate,
    aWithStage,
    bWithStage,
    withOwner,
    accreditedWithOwner,
    withClinical,
    accreditedWithClinical,
    casesTotal,
    casesReviewed,
    actsTotal,
    actsClassified,
    syncRun,
  ] = await Promise.all([
    supabase.rpc("ai_data_quality"),
    doctors(),
    doctors().eq("is_accredited", true),
    doctors().eq("is_accredited", true).not("accredited_at", "is", null),
    doctors().eq("is_accredited", false).not("acquisition_stage", "is", null),
    doctors().eq("is_accredited", true).not("activation_stage", "is", null),
    doctors().not("owner_id", "is", null),
    doctors().eq("is_accredited", true).not("owner_id", "is", null),
    doctors().not("clinical_owner_id", "is", null),
    doctors().eq("is_accredited", true).not("clinical_owner_id", "is", null),
    cases(),
    cases().not("case_subject_source", "is", null),
    activities(),
    activities().not("engagement_source", "is", null),
    supabase
      .from("sync_runs")
      .select("finished_at")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1),
  ]);

  const n = (r: { count: number | null; error: unknown }): number | null =>
    r.error ? null : (r.count ?? 0);

  const dTotal = n(docTotal);
  const acc = n(accredited);
  const nonAcc = dTotal != null && acc != null ? dTotal - acc : null;
  const aStage = n(aWithStage);
  const bStage = n(bWithStage);

  const metrics: ReadinessMetric[] = [
    {
      key: "lifecycle",
      label: "Lifecycle",
      covered: aStage != null && bStage != null ? aStage + bStage : null,
      total: dTotal,
      detail:
        aStage != null && bStage != null && nonAcc != null && acc != null
          ? `Universo A ${NUM.format(aStage)}/${NUM.format(nonAcc)} · Universo B ${NUM.format(bStage)}/${NUM.format(acc)}`
          : null,
      blocks:
        "Sin etapa declarada el ruteo determinístico cae al default y el agente no sabe qué objetivo tiene el doctor.",
    },
    {
      key: "accreditation_dates",
      label: "Fechas de acreditación",
      covered: n(accreditedWithDate),
      total: acc,
      detail: "Sobre los doctores acreditados",
      blocks:
        "Sin fecha no hay reloj de activación (día 75) ni días entre hitos: el agente no puede decir si va tarde.",
    },
    {
      key: "case_subject",
      label: "Clasificación de casos propios",
      covered: n(casesReviewed),
      total: n(casesTotal),
      detail: "Casos con revisión humana del sujeto (paciente / propio / otro)",
      blocks:
        "Sin esto no se distingue el caso propio del primer caso de paciente: el hito de activación no se puede afirmar.",
    },
    {
      key: "engagement",
      label: "Interacciones clasificadas",
      covered: n(actsClassified),
      total: n(actsTotal),
      detail: "Actividades con calidad de contacto cargada (humano o regla)",
      blocks:
        "Sin esto el reloj de contacto significativo no corre y ausencia de registro no equivale a ausencia de contacto.",
    },
    {
      key: "owner",
      label: "Owner",
      covered: n(withOwner),
      total: dTotal,
      detail:
        n(accreditedWithOwner) != null && acc != null
          ? `Acreditados con owner: ${NUM.format(n(accreditedWithOwner)!)}/${NUM.format(acc)}`
          : null,
      blocks:
        "Sin owner no hay a quién asignarle la acción propuesta ni forecast por persona.",
    },
    {
      key: "clinical_owner",
      label: "Owner clínico",
      covered: n(withClinical),
      total: dTotal,
      detail:
        n(accreditedWithClinical) != null && acc != null
          ? `Acreditados con owner clínico: ${NUM.format(n(accreditedWithClinical)!)}/${NUM.format(acc)}`
          : null,
      blocks:
        "Sin owner clínico no hay a quién derivar una viabilidad ni una objeción técnica.",
    },
  ];

  // el RPC del módulo A manda si existe y trae todo; si no, quedan las mediciones de arriba
  const fromRpc =
    rpc.error == null ? parseRpc(rpc.data, metrics.map((m) => m.key)) : null;
  if (fromRpc) {
    for (const m of metrics) {
      const v = fromRpc.get(m.key)!;
      m.covered = v.covered;
      m.total = v.total;
    }
  }

  const dataAsOf =
    ((syncRun.data ?? [])[0] as { finished_at: string } | undefined)?.finished_at ??
    null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Qué sabe la IA
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {fromRpc ? "Medido con ai_data_quality()" : "Medido con conteos sobre la base"}
          {dataAsOf ? ` · datos al ${dataAsOf.slice(0, 10)}` : ""}
        </span>
      </div>

      <ul className="divide-y rounded-lg border">
        {metrics.map((m) => {
          const p = pct(m);
          return (
            <li key={m.key} className="space-y-1.5 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{m.label}</span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {p == null
                    ? "sin medir"
                    : `${p}% · ${NUM.format(m.covered!)} de ${NUM.format(m.total!)}`}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full", barColor(p))}
                  style={{ width: `${p ?? 0}%` }}
                />
              </div>
              {m.detail ? (
                <p className="text-[11px] text-muted-foreground">{m.detail}</p>
              ) : null}
              <p className="text-[11px] text-muted-foreground/80">{m.blocks}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Track de hitos del journey real de México:
//   ACREDITACIÓN → CASO PROPIO → PRIMER CASO DE PACIENTE → SEGUNDO CASO
//
// Los hitos se leen de cases.case_subject_type (migración 0022) y NUNCA se
// infieren: si el caso no está clasificado, el hito queda "Sin identificar" —
// que NO es lo mismo que "no pasó". Asumir que "cualquier caso después de
// acreditarse = primer paciente" inventaría un hito comercial que puede no
// haber ocurrido, y es justo el error que este componente evita mostrar.
//
// Server-safe: sin "use client", sin estado, sin fetch. Recibe los casos ya
// leídos por la página.

import Link from "next/link";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Subconjunto de columnas de `cases` que necesita el track. */
export interface MilestoneCase {
  id: string;
  case_subject_type: string | null;
  fecha_ingreso: string;
  fecha_finalizado: string | null;
  id_externo: string | null;
  noloco_case_id: string;
  /** agrupa las etapas (I_1, I_2, …) de un MISMO tratamiento */
  treatment_key: string | null;
  is_demo: boolean;
}

/** Un tratamiento = todas las etapas de un mismo caso. Contar filas contaría la
 *  2ª etapa del mismo paciente como si fuera un segundo caso. */
interface Treatment {
  first: MilestoneCase;
  stages: number;
  allFinalized: boolean;
}

type MilestoneState = "sin_empezar" | "en_curso" | "completado" | "sin_identificar";

const STATE_LABELS: Record<MilestoneState, string> = {
  sin_empezar: "Sin empezar",
  en_curso: "En curso",
  completado: "Completado",
  sin_identificar: "Sin identificar",
};

// El estilo comunica el estado del DATO, no un juicio: "sin identificar" va en
// borde punteado y gris — falta información, no es un fracaso del doctor.
const STATE_STYLES: Record<MilestoneState, string> = {
  sin_empezar: "border-border bg-background text-muted-foreground",
  en_curso:
    "border-blue-200 bg-blue-50/60 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-400",
  completado:
    "border-emerald-200 bg-emerald-50/60 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400",
  sin_identificar: "border-dashed border-border bg-muted/30 text-muted-foreground",
};

const DAY_MS = 86_400_000;

function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.floor((b - a) / DAY_MS));
}

function caseLabel(c: MilestoneCase): string {
  return c.id_externo ?? c.noloco_case_id;
}

interface Milestone {
  step: number;
  name: string;
  state: MilestoneState;
  /** fecha del hito (ancla para medir los días entre hitos) */
  date: string | null;
  detail: string;
}

export function MilestoneTrack({
  isAccredited,
  accreditedAt,
  cases,
}: {
  isAccredited: boolean;
  accreditedAt: string | null;
  cases: MilestoneCase[];
}) {
  const real = cases.filter((c) => !c.is_demo);
  const byIngreso = (a: MilestoneCase, b: MilestoneCase) =>
    Date.parse(a.fecha_ingreso) - Date.parse(b.fecha_ingreso);

  /** Agrupa etapas del mismo tratamiento (1.017 filas = 765 tratamientos en MX):
   *  la 2ª etapa de un paciente NO es un segundo caso. */
  function treatments(list: MilestoneCase[]): Treatment[] {
    const groups = new Map<string, MilestoneCase[]>();
    for (const c of [...list].sort(byIngreso)) {
      const key = c.treatment_key ?? c.id;
      const rows = groups.get(key);
      if (rows) rows.push(c);
      else groups.set(key, [c]);
    }
    return [...groups.values()].map((rows) => ({
      first: rows[0],
      stages: rows.length,
      allFinalized: rows.every((r) => r.fecha_finalizado != null),
    }));
  }

  const own = treatments(real.filter((c) => c.case_subject_type === "DOCTOR_SELF"));
  const patient = treatments(real.filter((c) => c.case_subject_type === "PATIENT"));
  const unclassified = real.filter(
    (c) => c.case_subject_type == null || c.case_subject_type === "UNKNOWN"
  );

  /** Un hito de caso: existe (completado/en curso), no se sabe, o no pasó. */
  function caseMilestone(
    step: number,
    name: string,
    hit: Treatment | undefined,
    ordinal: string
  ): Milestone {
    if (!isAccredited) {
      return {
        step,
        name,
        state: "sin_empezar",
        date: null,
        detail: "Arranca después de la acreditación",
      };
    }
    if (hit) {
      return {
        step,
        name,
        state: hit.allFinalized ? "completado" : "en_curso",
        date: hit.first.fecha_ingreso,
        detail: `Caso ${caseLabel(hit.first)} · ingresó ${formatDate(hit.first.fecha_ingreso)}${
          hit.stages > 1 ? ` · ${hit.stages} etapas` : ""
        }${hit.allFinalized ? " · finalizado" : " · en producción"}`,
      };
    }
    if (unclassified.length > 0) {
      return {
        step,
        name,
        state: "sin_identificar",
        date: null,
        detail: `${unclassified.length} caso${unclassified.length === 1 ? "" : "s"} sin clasificar: no sabemos si alguno fue ${ordinal}`,
      };
    }
    return {
      step,
      name,
      state: "sin_empezar",
      date: null,
      detail:
        real.length === 0
          ? "Sin casos registrados"
          : "Ningún caso clasificado como este hito",
    };
  }

  const milestones: Milestone[] = [
    {
      step: 1,
      name: "Acreditación",
      state: isAccredited ? "completado" : "sin_empezar",
      date: isAccredited ? accreditedAt : null,
      detail: isAccredited
        ? accreditedAt
          ? formatDate(accreditedAt)
          : "Acreditado, fecha sin registrar"
        : "Todavía no está acreditado",
    },
    caseMilestone(2, "Caso propio", own[0], "el suyo"),
    caseMilestone(3, "Primer caso de paciente", patient[0], "su primer paciente"),
    caseMilestone(4, "Segundo caso", patient[1], "el segundo"),
  ];

  // días entre hitos: solo cuando las dos puntas tienen fecha conocida
  const elapsed = milestones.map((m, i) =>
    i === 0 ? null : daysBetween(milestones[i - 1].date, m.date)
  );

  const missingDate = isAccredited && !accreditedAt;

  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Hitos del journey
        </div>
        <div className="text-[11px] text-muted-foreground">
          Acreditación → caso propio → primer paciente → repetición
        </div>
      </div>

      <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {milestones.map((m, i) => (
          <li
            key={m.step}
            className={cn("rounded-lg border p-3", STATE_STYLES[m.state])}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide">
                {m.step}. {m.name}
              </span>
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide opacity-80">
                {STATE_LABELS[m.state]}
              </span>
            </div>
            <p className="mt-1 text-xs text-foreground/80">{m.detail}</p>
            {/* el tiempo entre hitos solo se muestra si alguna de las dos
                puntas existe: en un prospecto sin acreditar no aporta nada */}
            {i > 0 && (m.date || milestones[i - 1].date) ? (
              <p className="mt-1 text-[11px] tabular-nums opacity-70">
                {elapsed[i] != null
                  ? `${elapsed[i]} días desde el hito anterior`
                  : "Tiempo entre hitos: sin dato"}
              </p>
            ) : null}
          </li>
        ))}
      </ol>

      {isAccredited && unclassified.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {unclassified.length} de {real.length} casos siguen sin clasificar, así
          que el journey no se puede reconstruir sin inventarlo. Se clasifican en{" "}
          <Link href="/calidad" className="font-medium text-primary hover:underline">
            Calidad de datos
          </Link>
          .
        </p>
      ) : null}
      {missingDate ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          El doctor figura acreditado pero sin fecha de acreditación: los días
          entre hitos no se pueden calcular.
        </p>
      ) : null}
    </div>
  );
}

import { createClient } from "@/lib/supabase/server";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  JourneyBoard,
  type JourneyDoctor,
} from "@/components/prospecting/journey-board";
import { NewProspectDialog } from "@/components/prospecting/new-prospect-dialog";
import { monthStartMX } from "@/lib/dates";
import { SOURCE_LABELS, type AcqStage, type AttributionSource } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * PROSPECCIÓN — la sección del universo A. Responde UNA pregunta:
 * "¿Qué doctores nuevos tenemos que conseguir y cuáles están más cerca
 *  de acreditarse?" (los casos son un problema posterior, de /pipeline).
 */

// rank para el funnel acumulado ("llegó al menos hasta acá")
const ACQ_RANK: Record<AcqStage, number> = {
  identificado: 0,
  contacto_intentado: 1,
  contactado: 2,
  calificado: 3,
  reunion_agendada: 4,
  reunion_realizada: 5,
  interes_acreditacion: 6,
  acreditacion_agendada: 7,
  acreditado: 8,
  no_interesado: -1, // cuenta en la base, no avanza
};

const FUNNEL_STEPS: { label: string; minRank: number }[] = [
  { label: "Identificados", minRank: 0 },
  { label: "Contactados", minRank: 2 },
  { label: "Calificados", minRank: 3 },
  { label: "Reunión hecha", minRank: 5 },
  { label: "Interesados", minRank: 6 },
  { label: "Acred. agendada", minRank: 7 },
  { label: "Acreditados", minRank: 8 },
];

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export default async function ProspeccionPage() {
  const supabase = await createClient();
  const monthStartISO = monthStartMX();
  const [mxYear, mxMonth] = monthStartISO.split("-").map(Number);
  const prevMonthISO = `${new Date(Date.UTC(mxYear, mxMonth - 2, 1))
    .toISOString()
    .slice(0, 7)}-01`;
  const yearStartISO = `${mxYear}-01-01`;

  // el universo A puede tener MILES de doctores: el board muestra el top por
  // prioridad de cada etapa y los KPIs/funnel se calculan con counts (no fetch masivo)
  const PROSPECT_COLS =
    "id, nombre, city, source, owner_id, acquisition_stage, activation_stage, interest_level, estimated_cases_month, priority_score, last_contact_at, accredited_at, created_at, is_demo, lifecycle_stage";
  const ACQ_STAGES: AcqStage[] = [
    "identificado", "contacto_intentado", "contactado", "calificado",
    "reunion_agendada", "reunion_realizada", "interes_acreditacion",
    "acreditacion_agendada", "acreditado", "no_interesado",
  ];

  const [
    { data: accreditedYearRaw },
    { count: accreditedPrevMonth },
    { count: totalProspectos },
    { count: perdidosProspectos },
    { data: goalRow },
    { data: profilesRaw },
    stageCounts,
    stageTops,
  ] = await Promise.all([
    supabase
      .from("doctors")
      .select("id, nombre, owner_id, source, city, accredited_at, first_contact_at, acquisition_stage")
      .gte("accredited_at", yearStartISO),
    supabase
      .from("doctors")
      .select("id", { count: "exact", head: true })
      .gte("accredited_at", prevMonthISO)
      .lt("accredited_at", monthStartISO),
    supabase
      .from("doctors")
      .select("id", { count: "exact", head: true })
      .eq("is_accredited", false),
    supabase
      .from("doctors")
      .select("id", { count: "exact", head: true })
      .eq("is_accredited", false)
      .or("lifecycle_stage.eq.perdido,acquisition_stage.eq.no_interesado"),
    supabase
      .from("goals")
      .select("target")
      .eq("period", monthStartISO)
      .eq("metric", "accreditations")
      .is("user_id", null)
      .maybeSingle(),
    supabase.from("profiles").select("id, nombre"),
    Promise.all(
      ACQ_STAGES.map((s) =>
        supabase
          .from("doctors")
          .select("id", { count: "exact", head: true })
          .eq("is_accredited", false)
          .eq("acquisition_stage", s)
          .then((r) => [s, r.count ?? 0] as const)
      )
    ),
    Promise.all(
      ACQ_STAGES.map((s) =>
        supabase
          .from("doctors")
          .select(PROSPECT_COLS)
          .eq("is_accredited", false)
          .eq("acquisition_stage", s)
          .order("priority_score", { ascending: false, nullsFirst: false })
          .limit(30)
          .then((r) => r.data ?? [])
      )
    ),
  ]);

  const countByStage = Object.fromEntries(stageCounts) as Record<AcqStage, number>;
  type ProspectRow = JourneyDoctor & { lifecycle_stage: string };
  const prospects = stageTops.flat() as unknown as ProspectRow[];
  const accreditedYear = (accreditedYearRaw ?? []) as unknown as {
    id: string;
    nombre: string;
    owner_id: string | null;
    source: AttributionSource | null;
    city: string | null;
    accredited_at: string;
    first_contact_at: string | null;
    acquisition_stage: AcqStage | null;
  }[];
  const ownerNames = Object.fromEntries(
    ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [
      p.id,
      p.nombre,
    ])
  );

  // ---------- KPIs ----------
  const accreditedMonth = accreditedYear.filter(
    (d) => d.accredited_at >= monthStartISO
  );
  const target = goalRow?.target ?? null;
  const activosCount = (totalProspectos ?? 0) - (perdidosProspectos ?? 0);
  const enProcesoCount = ACQ_STAGES.filter((s) => ACQ_RANK[s] >= 4)
    .reduce((acc, s) => acc + (countByStage[s] ?? 0), 0);
  // time to accreditation: primer contacto → acreditación (acreditados del año)
  const daysToAccred = accreditedYear
    .filter((d) => d.first_contact_at)
    .map((d) =>
      Math.round(
        (Date.parse(d.accredited_at) - Date.parse(d.first_contact_at!)) /
          86_400_000
      )
    )
    .filter((n) => n >= 0);
  const medianDays = median(daysToAccred);

  // ---------- funnel acumulado ("llegó al menos hasta acá") ----------
  const accreditedFromPipeline = accreditedYear.filter(
    (d) => d.acquisition_stage === "acreditado"
  ).length;
  const cumulative = FUNNEL_STEPS.map((step) => ({
    ...step,
    count:
      ACQ_STAGES.filter((s) => ACQ_RANK[s] >= step.minRank).reduce(
        (acc, s) => acc + (countByStage[s] ?? 0),
        0
      ) + accreditedFromPipeline,
  }));
  const base = cumulative[0]?.count ?? 0;

  const convChips = [
    {
      label: "Prospecto → Contacto",
      num: cumulative[1].count,
      den: cumulative[0].count,
    },
    {
      label: "Contacto → Reunión",
      num: cumulative[3].count,
      den: cumulative[1].count,
    },
    {
      label: "Reunión → Acreditación",
      num: cumulative[6].count,
      den: cumulative[3].count,
    },
    {
      label: "Prospecto → Acreditación",
      num: cumulative[6].count,
      den: cumulative[0].count,
    },
  ];

  // ---------- acreditaciones por asesor / fuente / ciudad (del año) ----------
  const groupBy = (key: (d: (typeof accreditedYear)[number]) => string) => {
    const m = new Map<string, number>();
    for (const d of accreditedYear) {
      const k = key(d);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  };
  const porAsesor = groupBy((d) =>
    d.owner_id ? (ownerNames[d.owner_id] ?? "—") : "Sin owner"
  );
  const porFuente = groupBy((d) =>
    d.source ? SOURCE_LABELS[d.source] : "Sin fuente"
  );
  const porCiudad = groupBy((d) => d.city ?? "Sin ciudad");

  const tiles: { label: string; value: string | number; sub?: string; className?: string }[] = [
    {
      label: "Acreditados este mes",
      value:
        target != null
          ? `${accreditedMonth.length} / ${target}`
          : accreditedMonth.length,
      sub: `mes anterior: ${accreditedPrevMonth ?? 0}`,
      className:
        target != null && accreditedMonth.length >= target
          ? "text-emerald-600 dark:text-emerald-400"
          : undefined,
    },
    { label: "Prospectos activos", value: activosCount },
    {
      label: "Reunión o más avanzados",
      value: enProcesoCount,
      sub: "reunión agendada en adelante",
    },
    {
      label: "Días a acreditación",
      value: medianDays ?? "—",
      sub: medianDays != null ? `mediana · ${daysToAccred.length} doctores` : "sin datos aún",
    },
  ];

  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Prospección</h1>
          <p className="text-sm text-muted-foreground">
            Doctores que todavía NO trabajan con KeepSmiling. El objetivo acá
            no es un caso: es que se acrediten.
          </p>
        </div>
        <NewProspectDialog />
      </div>

      {/* ---------- KPIs de adquisición ---------- */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        {tiles.map((m) => (
          <div key={m.label} className="bg-background p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {m.label}
            </div>
            <div className={cn("mt-0.5 text-2xl font-semibold tabular-nums", m.className)}>
              {m.value}
            </div>
            {m.sub ? (
              <div className="text-xs text-muted-foreground">{m.sub}</div>
            ) : null}
          </div>
        ))}
      </div>

      {/* ---------- funnel de doctores nuevos ---------- */}
      <div className="rounded-lg border">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-medium">Funnel de doctores nuevos</h2>
          <p className="text-xs text-muted-foreground">
            Cuántos llegaron al menos hasta cada etapa (pipeline de adquisición)
          </p>
        </div>
        <div className="space-y-3 p-4">
          {base === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Sin prospectos trackeados todavía. Cargá el primero con “Nuevo
              prospecto”.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                {cumulative.map((s) => (
                  <div key={s.label} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 text-xs text-muted-foreground">
                      {s.label}
                    </span>
                    <div className="h-5 flex-1 overflow-hidden rounded bg-muted/50">
                      <div
                        className="flex h-full items-center rounded bg-[#001d57] px-2 dark:bg-[#cbf2fe]"
                        style={{
                          width: `${Math.max(4, (s.count / base) * 100)}%`,
                        }}
                      >
                        <span className="text-[11px] font-medium tabular-nums text-white dark:text-[#001d57]">
                          {s.count}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {convChips.map((c) => (
                  <span
                    key={c.label}
                    className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground"
                  >
                    {c.label}:{" "}
                    <span className="font-medium tabular-nums text-foreground">
                      {c.den > 0 ? `${Math.round((c.num / c.den) * 100)}%` : "—"}
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---------- pipeline de adquisición (kanban) ---------- */}
      <div className="space-y-2">
        <div>
          <h2 className="text-sm font-medium">Pipeline de adquisición</h2>
          <p className="text-xs text-muted-foreground">
            Arrastrá al doctor entre etapas. Al soltarlo en “Acreditado” se
            registra la fecha y pasa solo al pipeline de activación.
          </p>
        </div>
        <JourneyBoard
          mode="adquisicion"
          doctors={prospects as JourneyDoctor[]}
          ownerNames={ownerNames}
          columnCounts={countByStage}
        />
      </div>

      {/* ---------- acreditaciones del año, cortadas por lo que importa ---------- */}
      <div className="grid gap-6 lg:grid-cols-3">
        {[
          { title: "Acreditaciones por asesor", rows: porAsesor },
          { title: "Por fuente", rows: porFuente },
          { title: "Por ciudad", rows: porCiudad },
        ].map((t) => (
          <div key={t.title} className="rounded-lg border">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-medium">{t.title}</h2>
              <p className="text-xs text-muted-foreground">{mxYear}</p>
            </div>
            {t.rows.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                Sin acreditaciones registradas este año.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t.title.includes("asesor") ? "Asesor" : t.title.includes("fuente") ? "Fuente" : "Ciudad"}</TableHead>
                    <TableHead className="text-right">Acreditados</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {t.rows.map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell className="font-medium">{k}</TableCell>
                      <TableCell className="text-right tabular-nums">{v}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

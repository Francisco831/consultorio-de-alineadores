import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CasesChart, type MonthPoint } from "@/components/dashboard/cases-chart";
import { AskCrm } from "@/components/ai/ask-crm";
import { CATEGORIA_LABELS } from "@/lib/format";
import { monthStartMX } from "@/lib/dates";
import type { AcqStage, DoctorCategoria, LifecycleStage } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Dashboard ejecutivo dividido en los 3 MOTORES comerciales del negocio:
 *   1. ADQUISICIÓN  — conseguir doctores nuevos y acreditarlos
 *   2. ACTIVACIÓN   — que el acreditado pague su primer caso
 *   3. GROWTH & RETENCIÓN — que repita, crezca y no se duerma
 * + el funnel end-to-end (North Star): dónde se cae la gente y dónde está
 * el problema del mes (¿faltan prospectos? ¿mala activación? ¿no repiten?).
 */

interface MonthCaseRow {
  fecha_ingreso: string;
  doctor: {
    id: string;
    nombre: string;
    categoria: DoctorCategoria;
    owner_id: string | null;
  } | null;
}

interface DocRow {
  lifecycle_stage: LifecycleStage;
  is_accredited: boolean;
  acquisition_stage: AcqStage | null;
  new_case_count: number;
  accredited_at: string | null;
  first_case_at: string | null;
  days_to_first_case: number | null;
}

// siempre con fechas ancladas en UTC (Date.UTC) — los getters locales corren el mes
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const ACQ_RANK: Record<AcqStage, number> = {
  identificado: 0, contacto_intentado: 1, contactado: 2, calificado: 3,
  reunion_agendada: 4, reunion_realizada: 5, interes_acreditacion: 6,
  acreditacion_agendada: 7, acreditado: 8, no_interesado: -1,
};

export default async function DashboardPage() {
  const supabase = await createClient();

  const monthStartISO = monthStartMX();
  const [mxYear, mxMonth] = monthStartISO.split("-").map(Number);
  const prevMonthStart = new Date(Date.UTC(mxYear, mxMonth - 2, 1));
  const prevMonthStartISO = `${monthKey(prevMonthStart)}-01`;
  const chartStart = new Date(Date.UTC(mxYear, mxMonth - 12, 1));
  const chartStartISO = `${monthKey(chartStart)}-01`;
  const monthLabel = new Date().toLocaleDateString("es-MX", {
    timeZone: "America/Mexico_City",
    month: "long",
    year: "numeric",
  });

  // el universo puede tener MILES de doctores → todo por counts (PostgREST capea
  // fetches masivos en 1000 filas y mentiría en silencio)
  const dc = () =>
    supabase.from("doctors").select("id", { count: "exact", head: true });
  const CONTACTADO_PLUS = [
    "contactado", "calificado", "reunion_agendada", "reunion_realizada",
    "interes_acreditacion", "acreditacion_agendada",
  ];
  const REUNION_PLUS = [
    "reunion_agendada", "reunion_realizada", "interes_acreditacion",
    "acreditacion_agendada",
  ];

  const [
    { count: monthCases },
    { data: goalRow },
    { data: accGoalRow },
    { data: openOppsRaw },
    { count: accreditedPrevMonth },
    { data: chartRaw },
    { data: recentRaw },
    { data: profilesRaw },
    { count: cNoAcred },
    { count: cNoAcredPerdidos },
    { count: cContactados },
    { count: cReunion },
    { count: cAccMonth },
    { count: cAcreditados },
    { count: cSinActivar },
    { count: cActivadosEver },
    { count: cRepiten },
    { count: cPrimerosMes },
    { count: cActivos },
    { count: cGrowth },
    { count: cRiesgo },
    { count: cDormidos },
    { count: cReactivados },
    { data: daysToFirstRaw },
  ] = await Promise.all([
    supabase
      .from("cases")
      .select("id", { count: "exact", head: true })
      .eq("is_new_case", true)
      .gte("fecha_ingreso", monthStartISO),
    supabase
      .from("goals")
      .select("target")
      .eq("period", monthStartISO)
      .eq("metric", "paid_cases")
      .is("user_id", null)
      .maybeSingle(),
    supabase
      .from("goals")
      .select("target")
      .eq("period", monthStartISO)
      .eq("metric", "accreditations")
      .is("user_id", null)
      .maybeSingle(),
    supabase
      .from("opportunities")
      .select("probability")
      .not("stage", "in", "(ganada,perdida)"),
    supabase
      .from("doctors")
      .select("id", { count: "exact", head: true })
      .gte("accredited_at", prevMonthStartISO)
      .lt("accredited_at", monthStartISO),
    supabase
      .from("cases")
      .select("fecha_ingreso")
      .eq("is_new_case", true)
      .gte("fecha_ingreso", chartStartISO)
      .limit(5000),
    supabase
      .from("cases")
      .select("fecha_ingreso, doctor:doctors(id, nombre, categoria, owner_id)")
      .eq("is_new_case", true)
      .gte("fecha_ingreso", prevMonthStartISO)
      .limit(2000),
    supabase.from("profiles").select("id, nombre"),
    dc().eq("is_accredited", false),
    dc()
      .eq("is_accredited", false)
      .or("lifecycle_stage.eq.perdido,acquisition_stage.eq.no_interesado"),
    dc().eq("is_accredited", false).in("acquisition_stage", CONTACTADO_PLUS),
    dc().eq("is_accredited", false).in("acquisition_stage", REUNION_PLUS),
    dc().gte("accredited_at", monthStartISO),
    dc().eq("is_accredited", true),
    dc().in("lifecycle_stage", ["acreditado", "en_activacion"]),
    dc().eq("is_accredited", true).gte("new_case_count", 1),
    dc().eq("is_accredited", true).gte("new_case_count", 2),
    dc().gte("first_case_at", monthStartISO),
    dc().in("lifecycle_stage", ["activo", "growth", "reactivado"]),
    dc().eq("lifecycle_stage", "growth"),
    dc().eq("lifecycle_stage", "en_riesgo"),
    dc().eq("lifecycle_stage", "dormido"),
    dc().eq("lifecycle_stage", "reactivado"),
    supabase
      .from("doctors")
      .select("days_to_first_case")
      .not("days_to_first_case", "is", null)
      .limit(1000),
  ]);

  const target = goalRow?.target ?? null;
  const accTarget = accGoalRow?.target ?? null;
  const closed = monthCases ?? 0;
  const weightedOpen = (openOppsRaw ?? []).reduce(
    (acc, o) => acc + (o.probability ?? 0) / 100,
    0
  );
  const forecast = Math.round(closed + weightedOpen);
  const gap = target != null ? target - forecast : null;

  const ownerNames = new Map(
    ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [
      p.id,
      p.nombre,
    ])
  );

  // ================= MOTOR 1: ADQUISICIÓN =================
  const prospectosActivos = (cNoAcred ?? 0) - (cNoAcredPerdidos ?? 0);
  const enReunion = cReunion ?? 0;
  const accreditedMonth = cAccMonth ?? 0;

  // ================= MOTOR 2: ACTIVACIÓN =================
  const acreditadosN = cAcreditados ?? 0;
  const sinActivar = cSinActivar ?? 0;
  const activadosEver = cActivadosEver ?? 0;
  const activationRate =
    acreditadosN > 0 ? Math.round((activadosEver / acreditadosN) * 100) : null;
  const primerosCasosMes = cPrimerosMes ?? 0;
  const medianDaysToFirst = median(
    ((daysToFirstRaw ?? []) as { days_to_first_case: number }[]).map(
      (d) => d.days_to_first_case
    )
  );

  // ================= MOTOR 3: GROWTH & RETENCIÓN =================
  const activos = cActivos ?? 0;
  const growth = cGrowth ?? 0;
  const enRiesgo = cRiesgo ?? 0;
  const dormidos = cDormidos ?? 0;
  const reactivados = cReactivados ?? 0;
  // ================= FUNNEL END-TO-END =================
  // Cada escalón es ACUMULADO ("llegó al menos hasta acá") sobre la MISMA
  // población: si no, se compara la foto de hoy del universo A contra el
  // acumulado histórico del B y salen conversiones de más de 100%.
  // Los acreditados también fueron prospectos en su momento, así que suman
  // en todos los escalones anteriores (su etapa de adquisición no quedó
  // registrada: vinieron del import de Noloco, no del pipeline).
  const funnel = [
    { label: "Identificados", n: (cNoAcred ?? 0) + acreditadosN },
    { label: "Contactados", n: (cContactados ?? 0) + acreditadosN },
    { label: "Reuniones", n: enReunion + acreditadosN },
    { label: "Acreditados", n: acreditadosN },
    { label: "Activados", n: activadosEver },
    { label: "Repiten", n: cRepiten ?? 0 },
    { label: "Activos hoy", n: activos },
    { label: "Growth", n: growth },
  ];

  // ---------- casos nuevos por mes (12 meses) ----------
  const months: MonthPoint[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(mxYear, mxMonth - 1 - i, 1));
    const short = d
      .toLocaleDateString("es-MX", { month: "short", timeZone: "UTC" })
      .replace(".", "");
    const label =
      i === 11 || d.getUTCMonth() === 0
        ? `${short} ${String(d.getUTCFullYear()).slice(2)}`
        : short;
    months.push({ key: monthKey(d), label, count: 0 });
  }
  const byMonth = new Map(months.map((m) => [m.key, m]));
  for (const c of (chartRaw ?? []) as { fecha_ingreso: string }[]) {
    const m = byMonth.get(c.fecha_ingreso.slice(0, 7));
    if (m) m.count += 1;
  }
  const hasChartData = months.some((m) => m.count > 0);

  // ---------- casos del mes por doctor / por categoría ----------
  const recentRows = (recentRaw ?? []) as unknown as MonthCaseRow[];
  const monthRows = recentRows.filter((r) => r.fecha_ingreso >= monthStartISO);
  const prevRows = recentRows.filter((r) => r.fecha_ingreso < monthStartISO);

  const byDoctor = new Map<
    string,
    { nombre: string; ownerId: string | null; count: number }
  >();
  for (const r of monthRows) {
    if (!r.doctor) continue;
    const cur = byDoctor.get(r.doctor.id);
    if (cur) cur.count += 1;
    else
      byDoctor.set(r.doctor.id, {
        nombre: r.doctor.nombre,
        ownerId: r.doctor.owner_id,
        count: 1,
      });
  }
  const topDoctors = [...byDoctor.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].nombre.localeCompare(b[1].nombre))
    .slice(0, 10);

  // "casos por doctor" honesto: el denominador son los doctores que REALMENTE
  // mandaron caso este mes, no el total de doctores en estado Activo (dividir
  // los casos de toda la base por una población distinta infla el número)
  const doctoresConCasoDelMes = byDoctor.size;
  const casosPorActivo =
    doctoresConCasoDelMes > 0 ? (closed / doctoresConCasoDelMes).toFixed(1) : "—";

  const byCategoria = new Map<DoctorCategoria, { month: number; prev: number }>();
  for (const r of monthRows) {
    if (!r.doctor) continue;
    const cur = byCategoria.get(r.doctor.categoria) ?? { month: 0, prev: 0 };
    cur.month += 1;
    byCategoria.set(r.doctor.categoria, cur);
  }
  for (const r of prevRows) {
    if (!r.doctor) continue;
    const cur = byCategoria.get(r.doctor.categoria) ?? { month: 0, prev: 0 };
    cur.prev += 1;
    byCategoria.set(r.doctor.categoria, cur);
  }
  const categorias = [...byCategoria.entries()].sort(
    (a, b) => b[1].month - a[1].month || b[1].prev - a[1].prev
  );

  // ---------- North Star tiles ----------
  const tiles: { label: string; value: string | number; sub?: string; className?: string }[] = [
    {
      label: "Casos del mes",
      value: target != null ? `${closed} / ${target}` : closed,
    },
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
    {
      label: "Acreditados nuevos",
      value: accTarget != null ? `${accreditedMonth} / ${accTarget}` : accreditedMonth,
      sub: `mes anterior: ${accreditedPrevMonth ?? 0}`,
    },
    { label: "Primeros casos", value: primerosCasosMes, sub: "activaciones del mes" },
    {
      label: "Dormidos",
      value: dormidos,
      className: dormidos > 0 ? "text-red-600 dark:text-red-400" : undefined,
    },
  ];

  const motores: {
    title: string;
    desc: string;
    href: string;
    metrics: { label: string; value: string | number; className?: string }[];
  }[] = [
    {
      title: "1 · Adquisición",
      desc: "Conseguir doctores nuevos y acreditarlos",
      href: "/prospeccion",
      metrics: [
        { label: "Prospectos activos", value: prospectosActivos },
        { label: "En reunión o más", value: enReunion },
        {
          label: "Acreditados este mes",
          value: accTarget != null ? `${accreditedMonth} / ${accTarget}` : accreditedMonth,
        },
        {
          label: "Contactados (histórico)",
          value: cContactados ?? 0,
        },
      ],
    },
    {
      title: "2 · Activación",
      desc: "Del acreditado a su primer caso pagado",
      href: "/pipeline?view=activacion",
      metrics: [
        {
          label: "Acreditados sin activar",
          value: sinActivar,
          className:
            sinActivar > 0
              ? "text-orange-600 dark:text-orange-400"
              : undefined,
        },
        { label: "Primeros casos del mes", value: primerosCasosMes },
        {
          label: "Tasa de activación histórica",
          value: activationRate != null ? `${activationRate}%` : "—",
        },
        {
          label: "Días a primer caso",
          value: medianDaysToFirst ?? "—",
          className: undefined,
        },
      ],
    },
    {
      title: "3 · Growth & Retención",
      desc: "Que repitan, crezcan y no se duerman",
      href: "/doctores?f=activos",
      metrics: [
        { label: "Doctores activos", value: activos },
        {
          label: "Casos por doctor que mandó",
          value: casosPorActivo,
        },
        {
          label: "En riesgo",
          value: enRiesgo,
          className:
            enRiesgo > 0 ? "text-orange-600 dark:text-orange-400" : undefined,
        },
        {
          label: "Dormidos / Reactivados",
          value: `${dormidos} / ${reactivados}`,
          className:
            dormidos > 0 ? "text-red-600 dark:text-red-400" : undefined,
        },
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm capitalize text-muted-foreground">{monthLabel}</p>
      </div>

      {/* ---------- North Star ---------- */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 lg:grid-cols-6">
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
            {m.sub ? (
              <div className="text-xs text-muted-foreground">{m.sub}</div>
            ) : null}
          </div>
        ))}
      </div>

      {/* ---------- los 3 motores ---------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        {motores.map((motor) => (
          <Link
            key={motor.title}
            href={motor.href}
            className="rounded-lg border transition-colors hover:bg-muted/30"
          >
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">{motor.title}</h2>
              <p className="text-xs text-muted-foreground">{motor.desc}</p>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
              {motor.metrics.map((met) => (
                <div key={met.label}>
                  <div className="text-[11px] text-muted-foreground">
                    {met.label}
                  </div>
                  <div
                    className={cn(
                      "text-lg font-semibold tabular-nums",
                      met.className
                    )}
                  >
                    {met.value}
                  </div>
                </div>
              ))}
            </div>
          </Link>
        ))}
      </div>

      {/* ---------- funnel end-to-end ---------- */}
      <div className="rounded-lg border">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-medium">
            Funnel completo: encontrar → acreditar → activar → retener → crecer
          </h2>
          <p className="text-xs text-muted-foreground">
            Foto de hoy de toda la base, con conversión entre etapas
          </p>
        </div>
        <div className="overflow-x-auto p-4">
          <div className="flex min-w-max items-end gap-1">
            {funnel.map((step, i) => {
              const prev = i > 0 ? funnel[i - 1].n : null;
              const conv =
                prev != null && prev > 0
                  ? Math.round((step.n / prev) * 100)
                  : null;
              return (
                <div key={step.label} className="flex items-end gap-1">
                  {i > 0 ? (
                    <div className="pb-6 text-[10px] tabular-nums text-muted-foreground">
                      {conv != null ? `${conv}%→` : "→"}
                    </div>
                  ) : null}
                  <div className="w-24 text-center">
                    <div className="text-xl font-semibold tabular-nums">
                      {step.n}
                    </div>
                    <div className="mx-auto mt-1 h-1.5 rounded-full bg-[#001d57] dark:bg-[#cbf2fe]"
                      style={{
                        width: `${Math.max(8, Math.min(100, (step.n / Math.max(funnel[0].n, funnel[3].n, 1)) * 100))}%`,
                      }}
                    />
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {step.label}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Acá se ve dónde está el problema: ¿faltan prospectos nuevos, falla
            la activación, o los activados no repiten?
          </p>
        </div>
      </div>

      {/* ---------- casos nuevos por mes ---------- */}
      <div className="rounded-lg border">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-medium">Casos nuevos por mes</h2>
          <p className="text-xs text-muted-foreground">Últimos 12 meses</p>
        </div>
        <div className="p-4">
          {hasChartData ? (
            <>
              <CasesChart data={months} goal={target} />
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">
                  Ver datos
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="text-xs">
                    <tbody>
                      <tr>
                        {months.map((m) => (
                          <td key={m.key} className="px-2 py-0.5 text-center">
                            {m.label}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        {months.map((m) => (
                          <td
                            key={m.key}
                            className="px-2 py-0.5 text-center font-medium tabular-nums text-foreground"
                          >
                            {m.count}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          ) : (
            <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
              Todavía no hay casos registrados en los últimos 12 meses. Corré el
              import de Noloco para traer el histórico.
            </p>
          )}
        </div>
      </div>

      {/* ---------- tablas ---------- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-medium">Casos del mes por doctor</h2>
            <p className="text-xs text-muted-foreground">Top 10</p>
          </div>
          {topDoctors.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Todavía no entraron casos este mes. Los que ingresen aparecen acá
              al toque.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Doctor</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Casos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topDoctors.map(([id, d]) => (
                  <TableRow key={id}>
                    <TableCell>
                      <Link
                        href={`/doctores/${id}`}
                        className="font-medium hover:underline"
                      >
                        {d.nombre}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.ownerId ? (ownerNames.get(d.ownerId) ?? "—") : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {d.count}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="rounded-lg border">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-medium">Casos por categoría</h2>
            <p className="text-xs text-muted-foreground">
              Este mes vs. mes anterior
            </p>
          </div>
          {categorias.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Sin casos en los últimos dos meses. Cuando entren, acá se ve qué
              categoría los trae.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Categoría</TableHead>
                  <TableHead className="text-right">Este mes</TableHead>
                  <TableHead className="text-right">Mes anterior</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categorias.map(([cat, c]) => (
                  <TableRow key={cat}>
                    <TableCell className="font-medium">
                      {CATEGORIA_LABELS[cat] ?? cat}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {c.month}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {c.prev}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* ---------- Ask Your CRM (director comercial AI) ---------- */}
      <AskCrm />
    </div>
  );
}

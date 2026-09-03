import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/button";
import { relativeDays, formatDate } from "@/lib/format";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import {
  TIPOS_CONTACTO,
  VENTANA_ATRIBUCION_DIAS,
  contarCasosPorPersona,
  desdeConVentana,
  indiceDeToques,
} from "@/lib/atribucion";
import { monthStartMX, todayMX } from "@/lib/dates";
import {
  ESTADO_LABEL,
  casosPorDoctor,
  primerToquePorPersona,
  resumenTiers,
  serieCadencia,
  ultimoMesCompleto,
  ventanaEspejo,
  type EstadoCadencia,
} from "@/lib/impacto";
import {
  OPP_STAGE_LABELS,
  type DoctorCategoria,
  type OppStage,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "produccion", label: "Producción" },
  { key: "eventos", label: "Eventos y congresos" },
  { key: "acreditacion", label: "Acreditación y activación" },
  { key: "pipeline", label: "Pipeline" },
  { key: "actividad", label: "Actividad vs resultados" },
  { key: "impacto", label: "Impacto" },
  { key: "calidad", label: "Calidad de datos" },
];

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(dra?|doctora?)\.?\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function ReportesPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t = "produccion" } = await searchParams;
  const supabase = await createClient();

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-lg font-semibold tracking-tight">Reportes</h1>
      <div className="flex flex-wrap gap-1">
        {TABS.map((x) => (
          <Link
            key={x.key}
            href={x.key === "produccion" ? "/reportes" : `/reportes?t=${x.key}`}
            className={cn(
              buttonVariants({
                variant: t === x.key ? "secondary" : "ghost",
                size: "sm",
              })
            )}
          >
            {x.label}
          </Link>
        ))}
      </div>

      {t === "produccion" ? <Produccion supabase={supabase} /> : null}
      {t === "eventos" ? <Eventos supabase={supabase} /> : null}
      {t === "acreditacion" ? <Acreditacion supabase={supabase} /> : null}
      {t === "pipeline" ? <PipelineReport supabase={supabase} /> : null}
      {t === "actividad" ? <Actividad supabase={supabase} /> : null}
      {t === "impacto" ? <Impacto supabase={supabase} /> : null}
      {t === "calidad" ? <Calidad supabase={supabase} /> : null}
    </div>
  );
}

type SB = Awaited<ReturnType<typeof createClient>>;

/* ---------------- Producción ---------------- */
async function Produccion({ supabase }: { supabase: SB }) {
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const d90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const monthStartISO = monthStartMX();

  // paginado en las dos: con 6.4k doctores y >1k casos/año, un select plano
  // devuelve 1.000 filas sin avisar y los cortes por zona/categoría salen mal
  const [cases12m, doctors, { data: goals }] = await Promise.all([
    fetchAllRows<{ fecha_ingreso: string; doctor_id: string }>((from, to) =>
      supabase
        .from("cases")
        .select("fecha_ingreso, doctor_id")
        .eq("is_new_case", true)
        .eq("is_demo", false)
        .gte("fecha_ingreso", yearAgo)
        .range(from, to)
    ),
    fetchAllRows<{
      id: string;
      nombre: string;
      categoria: DoctorCategoria;
      zona: string | null;
      city: string | null;
    }>((from, to) =>
      supabase
        .from("doctors")
        .select("id, nombre, categoria, zona, city")
        .range(from, to)
    ),
    supabase
      .from("goals")
      .select("period, target")
      .eq("metric", "paid_cases")
      .is("user_id", null),
  ]);

  const docById = new Map((doctors ?? []).map((d) => [d.id, d]));
  const byMonth = new Map<string, number>();
  const byZona = new Map<string, number>();
  const byCat = new Map<string, { mes: number; d90: number }>();
  const byDoctor90 = new Map<string, number>();

  for (const c of cases12m ?? []) {
    byMonth.set(monthKey(c.fecha_ingreso), (byMonth.get(monthKey(c.fecha_ingreso)) ?? 0) + 1);
    const d = docById.get(c.doctor_id);
    const isMonth = c.fecha_ingreso >= monthStartISO;
    const is90 = c.fecha_ingreso >= d90;
    if (d) {
      if (isMonth) byZona.set(d.zona ?? "Sin zona", (byZona.get(d.zona ?? "Sin zona") ?? 0) + 1);
      const cat = byCat.get(d.categoria) ?? { mes: 0, d90: 0 };
      if (isMonth) cat.mes++;
      if (is90) cat.d90++;
      byCat.set(d.categoria, cat);
      if (is90) byDoctor90.set(c.doctor_id, (byDoctor90.get(c.doctor_id) ?? 0) + 1);
    }
  }
  const goalByMonth = new Map((goals ?? []).map((g) => [monthKey(g.period), g.target]));
  const months = [...byMonth.keys()].sort();
  const topDoctors = [...byDoctor90.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Casos nuevos por mes
        </h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Mes</TableHead>
                <TableHead className="text-right">Casos</TableHead>
                <TableHead className="text-right">Objetivo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {months.map((m) => (
                <TableRow key={m}>
                  <TableCell>{m}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {byMonth.get(m)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {goalByMonth.get(m) ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Top doctores (90 días)
        </h2>
        <div className="rounded-lg border">
          <Table>
            <TableBody>
              {topDoctors.map(([id, n]) => (
                <TableRow key={id}>
                  <TableCell>
                    <Link href={`/doctores/${id}`} className="hover:underline">
                      {docById.get(id)?.nombre ?? "—"}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{n}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Por categoría
        </h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Categoría</TableHead>
                <TableHead className="text-right">Mes</TableHead>
                <TableHead className="text-right">90 días</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...byCat.entries()]
                .sort((a, b) => b[1].d90 - a[1].d90)
                .map(([cat, s]) => (
                  <TableRow key={cat}>
                    <TableCell>{cat}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.mes}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.d90}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Por zona (mes)
        </h2>
        <div className="rounded-lg border">
          <Table>
            <TableBody>
              {[...byZona.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([z, n]) => (
                  <TableRow key={z}>
                    <TableCell>{z}</TableCell>
                    <TableCell className="text-right tabular-nums">{n}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

/* ---------------- Eventos y congresos ---------------- */
// ¿Qué evento vale la pena repetir? De los contactos que dejó cada curso/congreso:
// cuántos son hoy clientes, cuántos mandan casos y cuántos casos trajeron.
// La agregación va en la DB (función evento_roi) porque son 6.4k doctores.
async function Eventos({ supabase }: { supabase: SB }) {
  const { data, error } = await supabase.rpc("evento_roi");
  interface Row {
    evento: string;
    fecha: string | null;
    tipo: string;
    contactos: number;
    clientes: number;
    acreditados_post: number;
    activados: number;
    casos: number;
  }
  const rows = (data ?? []) as Row[];

  if (error) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-destructive">
        No se pudo calcular el ROI por evento: {error.message}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        Todavía no hay eventos cargados. Cada curso o congreso se carga como
        campaña al importar sus listas de contactos.
      </p>
    );
  }

  const tot = rows.reduce(
    (a, r) => ({
      contactos: a.contactos + Number(r.contactos),
      clientes: a.clientes + Number(r.clientes),
      casos: a.casos + Number(r.casos),
    }),
    { contactos: 0, clientes: 0, casos: 0 }
  );
  // conversión por TIPO de evento: la pregunta de negocio real
  const porTipo = new Map<string, { contactos: number; clientes: number; casos: number }>();
  for (const r of rows) {
    const k = r.tipo ?? "otro";
    const cur = porTipo.get(k) ?? { contactos: 0, clientes: 0, casos: 0 };
    cur.contactos += Number(r.contactos);
    cur.clientes += Number(r.clientes);
    cur.casos += Number(r.casos);
    porTipo.set(k, cur);
  }
  const tipos = [...porTipo.entries()].sort((a, b) => b[1].contactos - a[1].contactos);

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        {[
          { label: "Eventos", value: rows.length },
          { label: "Contactos que dejaron", value: tot.contactos },
          {
            label: "Hoy son clientes",
            value: `${tot.clientes} · ${pct(tot.clientes, tot.contactos)}%`,
          },
          { label: "Casos que trajeron", value: tot.casos },
        ].map((m) => (
          <div key={m.label} className="bg-background p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {m.label}
            </div>
            <div className="mt-0.5 text-2xl font-semibold tabular-nums">{m.value}</div>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Conversión por tipo de evento
        </h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Contactos</TableHead>
                <TableHead className="text-right">Clientes</TableHead>
                <TableHead className="text-right">Conversión</TableHead>
                <TableHead className="text-right">Casos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tipos.map(([tipo, v]) => (
                <TableRow key={tipo}>
                  <TableCell className="font-medium capitalize">{tipo}</TableCell>
                  <TableCell className="text-right tabular-nums">{v.contactos}</TableCell>
                  <TableCell className="text-right tabular-nums">{v.clientes}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums font-medium",
                      pct(v.clientes, v.contactos) >= 25
                        ? "text-emerald-600 dark:text-emerald-400"
                        : pct(v.clientes, v.contactos) < 10
                          ? "text-orange-600 dark:text-orange-400"
                          : undefined
                    )}
                  >
                    {pct(v.clientes, v.contactos)}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{v.casos}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            En un <strong>curso</strong> el doctor se acredita ahí mismo, por eso
            convierte alto. En un <strong>congreso</strong> el contacto es apenas un
            lead: hay que trabajarlo después. Compará el costo de cada uno contra
            los casos que trajo.
          </p>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Evento por evento
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Evento</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead className="text-right">Contactos</TableHead>
                <TableHead className="text-right">Clientes</TableHead>
                <TableHead className="text-right">Conv.</TableHead>
                <TableHead className="text-right">Acred. después</TableHead>
                <TableHead className="text-right">Mandan casos</TableHead>
                <TableHead className="text-right">Casos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const conv = pct(Number(r.clientes), Number(r.contactos));
                return (
                  <TableRow key={r.evento}>
                    <TableCell className="font-medium">{r.evento}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.fecha ? formatDate(r.fecha) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.contactos}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.clientes}</TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums font-medium",
                        conv >= 25
                          ? "text-emerald-600 dark:text-emerald-400"
                          : conv < 10
                            ? "text-orange-600 dark:text-orange-400"
                            : undefined
                      )}
                    >
                      {conv}%
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {r.acreditados_post}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.activados}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {r.casos}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            “Acred. después” = se acreditó con fecha posterior al evento, o sea que
            el evento lo empujó. Los contactos que todavía no son clientes están en
            Prospección, listos para trabajar.
          </p>
        </div>
      </section>
    </div>
  );
}

/* ---------------- Acreditación y activación ---------------- */
// Las TRES conversiones se miden por separado: prospecto→acreditado,
// acreditado→activado, activado→repite. Acá viven las dos últimas:
// cohortes de acreditación y velocidad de activación.
async function Acreditacion({ supabase }: { supabase: SB }) {
  const { data: docsRaw } = await supabase
    .from("doctors")
    .select(
      "id, nombre, owner_id, source, accredited_at, first_paid_case_at, first_case_at, days_to_first_case, new_case_count, is_accredited"
    )
    .eq("is_accredited", true)
    .eq("is_demo", false);
  const { data: profilesRaw } = await supabase
    .from("profiles")
    .select("id, nombre");

  interface Row {
    id: string;
    nombre: string;
    owner_id: string | null;
    source: string | null;
    accredited_at: string | null;
    first_paid_case_at: string | null;
    first_case_at: string | null;
    days_to_first_case: number | null;
    new_case_count: number;
  }
  const docs = (docsRaw ?? []) as unknown as Row[];
  const ownerNames = new Map(
    ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [
      p.id,
      p.nombre,
    ])
  );
  const dated = docs.filter((d) => d.accredited_at);
  const activated = (d: Row) => d.new_case_count >= 1 || d.first_paid_case_at;

  // ---------- cohortes por mes de acreditación (últimos 12 con datos) ----------
  const cohorts = new Map<string, Row[]>();
  for (const d of dated) {
    const k = monthKey(d.accredited_at!);
    cohorts.set(k, [...(cohorts.get(k) ?? []), d]);
  }
  const cohortRows = [...cohorts.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 12)
    .map(([mes, list]) => {
      const within = (days: number) =>
        list.filter(
          (d) => d.days_to_first_case != null && d.days_to_first_case <= days
        ).length;
      const act = list.filter(activated).length;
      return {
        mes,
        total: list.length,
        d7: within(7),
        d30: within(30),
        d60: within(60),
        d90: within(90),
        nunca: list.length - act,
        conv: list.length > 0 ? Math.round((act / list.length) * 100) : 0,
      };
    });

  // ---------- distribución days to first case ----------
  const BUCKETS = [
    { label: "0-7 días", min: 0, max: 7 },
    { label: "8-30 días", min: 8, max: 30 },
    { label: "31-60 días", min: 31, max: 60 },
    { label: "61-90 días", min: 61, max: 90 },
    { label: "90+ días", min: 91, max: Infinity },
  ];
  const withDays = dated.filter((d) => d.days_to_first_case != null);
  const neverActivated = dated.filter((d) => !activated(d));
  const dist = [
    ...BUCKETS.map((b) => ({
      label: b.label,
      n: withDays.filter(
        (d) => d.days_to_first_case! >= b.min && d.days_to_first_case! <= b.max
      ).length,
    })),
    { label: "Nunca activó", n: neverActivated.length },
  ];
  const distMax = Math.max(1, ...dist.map((d) => d.n));

  // ---------- calidad de acreditación por owner (no solo cantidad) ----------
  const byOwner = new Map<string, Row[]>();
  for (const d of dated) {
    const k = d.owner_id ?? "—";
    byOwner.set(k, [...(byOwner.get(k) ?? []), d]);
  }
  const ownerRows = [...byOwner.entries()]
    .map(([ownerId, list]) => ({
      owner: ownerId === "—" ? "Sin owner" : (ownerNames.get(ownerId) ?? "—"),
      total: list.length,
      pct30:
        list.length > 0
          ? Math.round(
              (list.filter(
                (d) => d.days_to_first_case != null && d.days_to_first_case <= 30
              ).length /
                list.length) *
                100
            )
          : 0,
      pct60:
        list.length > 0
          ? Math.round(
              (list.filter(
                (d) => d.days_to_first_case != null && d.days_to_first_case <= 60
              ).length /
                list.length) *
                100
            )
          : 0,
      nunca: list.filter((d) => !activated(d)).length,
    }))
    .sort((a, b) => b.total - a.total);

  // acreditados enfriándose: sin primer caso y acreditados hace 30+ días
  const cooling = docs
    .filter(
      (d) =>
        !activated(d) &&
        d.accredited_at &&
        Date.now() - Date.parse(d.accredited_at) > 30 * 86_400_000
    )
    .sort(
      (a, b) => Date.parse(a.accredited_at!) - Date.parse(b.accredited_at!)
    )
    .slice(0, 12);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        {dated.length} acreditados con fecha conocida ·{" "}
        {docs.length - dated.length} sin fecha (no entran a las cohortes) ·
        activación = primer caso pagado (o primer caso ingresado para
        históricos sin ledger de pagos)
      </p>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Cohortes de acreditación — ¿los que acreditamos, activan?
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Cohorte</TableHead>
                <TableHead className="text-right">Acreditados</TableHead>
                <TableHead className="text-right">≤7d</TableHead>
                <TableHead className="text-right">≤30d</TableHead>
                <TableHead className="text-right">≤60d</TableHead>
                <TableHead className="text-right">≤90d</TableHead>
                <TableHead className="text-right">Nunca</TableHead>
                <TableHead className="text-right">Conversión</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohortRows.map((c) => (
                <TableRow key={c.mes}>
                  <TableCell className="font-medium">{c.mes}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.total}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.d7}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.d30}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.d60}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.d90}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      c.nunca > 0 && "text-orange-600 dark:text-orange-400"
                    )}
                  >
                    {c.nunca}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {c.conv}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Días hasta el primer caso
          </h2>
          <div className="space-y-1.5 rounded-lg border p-4">
            {dist.map((b) => (
              <div key={b.label} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-xs text-muted-foreground">
                  {b.label}
                </span>
                <div className="h-5 flex-1 overflow-hidden rounded bg-muted/50">
                  <div
                    className={cn(
                      "flex h-full items-center rounded px-2",
                      b.label === "Nunca activó"
                        ? "bg-orange-500/80"
                        : "bg-[#001d57] dark:bg-[#cbf2fe]"
                    )}
                    style={{ width: `${Math.max(4, (b.n / distMax) * 100)}%` }}
                  >
                    <span
                      className={cn(
                        "text-[11px] font-medium tabular-nums",
                        b.label === "Nunca activó"
                          ? "text-white"
                          : "text-white dark:text-[#001d57]"
                      )}
                    >
                      {b.n}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              Un acreditado que no activa en 30 días se está enfriando — está
              en /pipeline?view=activacion.
            </p>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Calidad de acreditación por asesor
          </h2>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Asesor</TableHead>
                  <TableHead className="text-right">Acred.</TableHead>
                  <TableHead className="text-right">act. ≤30d</TableHead>
                  <TableHead className="text-right">act. ≤60d</TableHead>
                  <TableHead className="text-right">Nunca</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ownerRows.map((r) => (
                  <TableRow key={r.owner}>
                    <TableCell className="font-medium">{r.owner}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.pct30}%</TableCell>
                    <TableCell className="text-right tabular-nums">{r.pct60}%</TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        r.nunca > 0 && "text-orange-600 dark:text-orange-400"
                      )}
                    >
                      {r.nunca}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              Acreditar mucho no alcanza: lo que vale es cuántos mandan caso.
            </p>
          </div>
        </section>
      </div>

      {cooling.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Acreditados enfriándose (30+ días sin primer caso)
          </h2>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Doctor</TableHead>
                  <TableHead>Acreditado</TableHead>
                  <TableHead>Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cooling.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link
                        href={`/doctores/${d.id}`}
                        className="font-medium hover:underline"
                      >
                        {d.nombre}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {relativeDays(d.accredited_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.owner_id ? (ownerNames.get(d.owner_id) ?? "—") : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ---------------- Pipeline ---------------- */
async function PipelineReport({ supabase }: { supabase: SB }) {
  const [{ data: opps }, { data: audit }] = await Promise.all([
    supabase
      .from("opportunities")
      .select("id, stage, lost_reason, created_at, closed_at")
      .eq("is_demo", false),
    supabase
      .from("audit_log")
      .select("entity_id, old_value, new_value, created_at")
      .eq("entity_type", "opportunity")
      .eq("field", "stage")
      .order("created_at", { ascending: true })
      .limit(5000),
  ]);

  const total = (opps ?? []).length;
  const won = (opps ?? []).filter((o) => o.stage === "ganada").length;
  const lost = (opps ?? []).filter((o) => o.stage === "perdida");
  const open = total - won - lost.length;

  const lostReasons = new Map<string, number>();
  for (const o of lost) {
    const r = (o.lost_reason ?? "Sin motivo").split(" — ")[0];
    lostReasons.set(r, (lostReasons.get(r) ?? 0) + 1);
  }

  // duración promedio por etapa desde el audit trail
  const byOpp = new Map<string, { stage: string; at: number }[]>();
  for (const e of audit ?? []) {
    byOpp.set(e.entity_id, [
      ...(byOpp.get(e.entity_id) ?? []),
      { stage: e.old_value ?? "", at: Date.parse(e.created_at) },
    ]);
  }
  const durations = new Map<string, { total: number; n: number }>();
  for (const events of byOpp.values()) {
    for (let i = 1; i < events.length; i++) {
      const stage = events[i].stage;
      const days = (events[i].at - events[i - 1].at) / 86_400_000;
      const d = durations.get(stage) ?? { total: 0, n: 0 };
      d.total += days;
      d.n++;
      durations.set(stage, d);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Conversión global
        </h2>
        <div className="rounded-lg border">
          <Table>
            <TableBody>
              <TableRow>
                <TableCell>Abiertas</TableCell>
                <TableCell className="text-right tabular-nums">{open}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Ganadas</TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {won}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Perdidas</TableCell>
                <TableCell className="text-right tabular-nums text-red-600 dark:text-red-400">
                  {lost.length}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Win rate (cerradas)</TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {won + lost.length > 0
                    ? `${Math.round((won / (won + lost.length)) * 100)}%`
                    : "—"}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Motivos de pérdida
        </h2>
        {lost.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            Sin oportunidades perdidas registradas.
          </p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableBody>
                {[...lostReasons.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([r, n]) => (
                    <TableRow key={r}>
                      <TableCell>{r}</TableCell>
                      <TableCell className="text-right tabular-nums">{n}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2 lg:col-span-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Días promedio por etapa (velocidad real)
        </h2>
        {durations.size === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            Todavía no hay suficientes movimientos de etapa registrados. Cada
            cambio en el kanban alimenta este reporte automáticamente.
          </p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Etapa</TableHead>
                  <TableHead className="text-right">Días promedio</TableHead>
                  <TableHead className="text-right">Movimientos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...durations.entries()].map(([stage, d]) => (
                  <TableRow key={stage}>
                    <TableCell>
                      {OPP_STAGE_LABELS[stage as OppStage] ?? stage}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(d.total / d.n).toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {d.n}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------------- Actividad vs resultados ---------------- */
async function Actividad({ supabase }: { supabase: SB }) {
  const d90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
  // las tres primeras paginadas: actividades (4.4k+), casos y el mapa de owners
  // (6.4k doctores) se cuentan en JS, así que truncarlas falsea la tabla entera
  const [acts, cases90, toques, { data: profiles }] = await Promise.all([
    // sin is_demo=false esta tabla compara el esfuerzo REAL de cada persona contra
    // ~200 actividades sintéticas repartidas en los mismos 90 días
    fetchAllRows<{ created_by: string | null; type: string }>((from, to) =>
      supabase
        .from("activities")
        .select("created_by, type")
        .eq("is_demo", false)
        .gte("occurred_at", d90)
        .range(from, to)
    ),
    fetchAllRows<{ doctor_id: string; fecha_ingreso: string }>((from, to) =>
      supabase
        .from("cases")
        .select("doctor_id, fecha_ingreso")
        .eq("is_new_case", true)
        .eq("is_demo", false)
        .gte("fecha_ingreso", d90)
        .range(from, to)
    ),
    // contactos desde 90 días antes de la ventana: un caso del día 1 puede venir
    // de una visita anterior a la ventana
    fetchAllRows<{ doctor_id: string; created_by: string | null; occurred_at: string }>(
      (from, to) =>
        supabase
          .from("activities")
          .select("doctor_id, created_by, occurred_at")
          .eq("is_demo", false)
          .not("created_by", "is", null)
          .in("type", TIPOS_CONTACTO as unknown as string[])
          .gte("occurred_at", desdeConVentana(d90))
          .range(from, to)
    ),
    supabase.from("profiles").select("id, nombre"),
  ]);

  const perUser = new Map<
    string,
    { visitas: number; llamadas: number; whatsapp: number; otras: number; casos: number }
  >();
  const ensure = (id: string | null) => {
    if (!id) return null;
    if (!perUser.has(id))
      perUser.set(id, { visitas: 0, llamadas: 0, whatsapp: 0, otras: 0, casos: 0 });
    return perUser.get(id)!;
  };
  for (const a of acts ?? []) {
    const s = ensure(a.created_by);
    if (!s) continue;
    if (a.type === "visita") s.visitas++;
    else if (a.type === "llamada") s.llamadas++;
    else if (a.type === "whatsapp") s.whatsapp++;
    else s.otras++;
  }
  // el caso se le cuenta a quien tocó al doctor antes de que entrara, no al
  // owner de hoy (ver lib/atribucion.ts)
  const { porPersona: casosDe, sinAtribuir } = contarCasosPorPersona(
    cases90 ?? [],
    indiceDeToques(toques ?? [])
  );
  for (const [persona, n] of casosDe) {
    const s = ensure(persona);
    if (s) s.casos = n;
  }
  const nameOf = new Map((profiles ?? []).map((p) => [p.id, p.nombre]));

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Últimos 90 días — qué actividad genera casos
      </h2>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Persona</TableHead>
              <TableHead className="text-right">Visitas</TableHead>
              <TableHead className="text-right">Llamadas</TableHead>
              <TableHead className="text-right">WhatsApp</TableHead>
              <TableHead className="text-right">Otras</TableHead>
              <TableHead className="text-right">Casos atribuidos</TableHead>
              <TableHead className="text-right">Casos / actividad</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...perUser.entries()].map(([id, s]) => {
              const totalActs = s.visitas + s.llamadas + s.whatsapp + s.otras;
              return (
                <TableRow key={id}>
                  <TableCell className="font-medium">{nameOf.get(id) ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.visitas}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.llamadas}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.whatsapp}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.otras}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{s.casos}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {totalActs > 0 ? (s.casos / totalActs).toFixed(2) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        No es un dashboard de vanidad: la columna que importa es la última. 200
        llamadas sin casos valen menos que 10 visitas con 3. Un caso se le cuenta
        a quien tocó a ese doctor por última vez dentro de los{" "}
        {VENTANA_ATRIBUCION_DIAS} días previos al caso.
        {sinAtribuir > 0
          ? ` ${sinAtribuir} de los ${cases90.length} casos de la ventana entraron sin contacto cargado y no se le cuentan a nadie.`
          : ""}
      </p>
    </section>
  );
}

/* ---------------- Calidad de datos ---------------- */
async function Calidad({ supabase }: { supabase: SB }) {
  // TODA esta pantalla son conteos sobre la base completa (sin teléfono, sin
  // ciudad, duplicados…): con 6.4k doctores y 5k tareas, truncar en 1.000 haría
  // que "calidad de datos" mienta justo sobre la calidad de los datos
  const [doctors, openOpps, openTasks] = await Promise.all([
    fetchAllRows<{
      id: string;
      nombre: string;
      phone: string | null;
      whatsapp: string | null;
      city: string | null;
      owner_id: string | null;
      categoria: DoctorCategoria;
      priority_score: number | null;
      is_demo: boolean;
    }>((from, to) =>
      supabase
        .from("doctors")
        .select("id, nombre, phone, whatsapp, city, owner_id, categoria, priority_score, is_demo")
        .order("priority_score", { ascending: false, nullsFirst: false })
        .range(from, to)
    ),
    fetchAllRows<{
      id: string;
      doctor_id: string;
      patient_name: string | null;
      stage_entered_at: string;
      created_at: string;
    }>((from, to) =>
      supabase
        .from("opportunities")
        .select("id, doctor_id, patient_name, stage_entered_at, created_at")
        .not("stage", "in", "(ganada,perdida)")
        .range(from, to)
    ),
    fetchAllRows<{ doctor_id: string | null }>((from, to) =>
      supabase.from("tasks").select("doctor_id").eq("status", "pendiente").range(from, to)
    ),
  ]);

  const all = (doctors ?? []).filter((d) => !d.is_demo);
  const sinTelefono = all.filter((d) => !d.phone && !d.whatsapp);
  const sinCiudad = all.filter((d) => !d.city);
  const sinOwner = all.filter((d) => !d.owner_id);

  const byNorm = new Map<string, typeof all>();
  for (const d of all) {
    const k = normName(d.nombre);
    byNorm.set(k, [...(byNorm.get(k) ?? []), d]);
  }
  const dupes = [...byNorm.values()].filter((g) => g.length > 1);

  const doctorsWithTask = new Set((openTasks ?? []).map((t) => t.doctor_id));
  const oppsSinAccion = (openOpps ?? []).filter(
    (o) => !doctorsWithTask.has(o.doctor_id)
  );
  const d45 = Date.now() - 45 * 86_400_000;
  const oppsViejas = (openOpps ?? []).filter((o) => Date.parse(o.created_at) < d45);
  const nameOf = new Map(all.map((d) => [d.id, d.nombre]));

  const counters = [
    { label: "Doctores sin teléfono", value: sinTelefono.length },
    { label: "Sin ciudad", value: sinCiudad.length },
    { label: "Sin owner", value: sinOwner.length },
    { label: "Posibles duplicados", value: dupes.length },
    { label: "Opps sin próxima acción", value: oppsSinAccion.length },
    { label: "Opps abiertas +45 días", value: oppsViejas.length },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {counters.map((c) => (
          <div key={c.label} className="bg-background p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {c.label}
            </div>
            <div
              className={cn(
                "mt-0.5 text-xl font-semibold tabular-nums",
                c.value > 0 ? "text-orange-600 dark:text-orange-400" : "text-emerald-600 dark:text-emerald-400"
              )}
            >
              {c.value}
            </div>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Sin teléfono, ordenados por prioridad (conseguir estos primero)
        </h2>
        {sinTelefono.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            Todos los doctores tienen teléfono. Excelente.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {sinTelefono.slice(0, 20).map((d) => (
              <li key={d.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <Link href={`/doctores/${d.id}`} className="hover:underline">
                  {d.nombre}
                </Link>
                <span className="tabular-nums text-muted-foreground">
                  prioridad {d.priority_score ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dupes.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Posibles duplicados
          </h2>
          <ul className="divide-y rounded-lg border">
            {dupes.slice(0, 10).map((g) => (
              <li key={g[0].id} className="px-4 py-2 text-sm">
                {g.map((d, i) => (
                  <span key={d.id}>
                    {i > 0 ? " · " : ""}
                    <Link href={`/doctores/${d.id}`} className="hover:underline">
                      {d.nombre}
                    </Link>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {oppsSinAccion.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Oportunidades sin próxima acción
          </h2>
          <ul className="divide-y rounded-lg border">
            {oppsSinAccion.slice(0, 15).map((o) => (
              <li key={o.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <Link href={`/doctores/${o.doctor_id}`} className="hover:underline">
                  {o.patient_name ?? "Oportunidad"} — {nameOf.get(o.doctor_id) ?? ""}
                </Link>
                <span className="text-muted-foreground">
                  en etapa {relativeDays(o.stage_entered_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/* ---------------- Impacto ---------------- */
/**
 * La pantalla que contesta "¿el equipo mueve la aguja?" sin mentir.
 *
 * No hay score por persona: con 13-35 casos nuevos por mes y ~100 doctores vivos
 * no hay N para probar causalidad, y el antes/después crudo de Juan sube tanto
 * en su ventana real como un año antes de haber tocado a nadie. Lo que sí se
 * puede: el estado de la cartera contra el ritmo propio de cada doctor, y el
 * antes/después SIEMPRE al lado de su placebo.
 */
async function Impacto({ supabase }: { supabase: SB }) {
  const hoyISO = todayMX();
  const ahora = Date.parse(`${hoyISO}T23:59:59-06:00`);

  const [casos, toques] = await Promise.all([
    fetchAllRows<{ doctor_id: string; fecha_ingreso: string }>((from, to) =>
      supabase
        .from("cases")
        .select("doctor_id, fecha_ingreso")
        .eq("is_new_case", true)
        .eq("is_demo", false)
        .range(from, to)
    ),
    fetchAllRows<{
      doctor_id: string;
      created_by: string | null;
      occurred_at: string;
      type: string;
    }>((from, to) =>
      supabase
        .from("activities")
        .select("doctor_id, created_by, occurred_at, type")
        .eq("is_demo", false)
        .not("created_by", "is", null)
        .in("type", TIPOS_CONTACTO as unknown as string[])
        .range(from, to)
    ),
  ]);
  const { data: profiles } = await supabase.from("profiles").select("id, nombre");
  const nombreDe = new Map((profiles ?? []).map((p) => [p.id, p.nombre]));

  const cd = casosPorDoctor(casos);
  const serie = serieCadencia(cd, "2025-06", ultimoMesCompleto(hoyISO));
  const ultimo = serie[serie.length - 1];

  const ultimoToque = new Map<string, number>();
  for (const t of toques) {
    const ts = Date.parse(t.occurred_at);
    const prev = ultimoToque.get(t.doctor_id);
    if (prev === undefined || ts > prev) ultimoToque.set(t.doctor_id, ts);
  }
  const tiers = resumenTiers(cd, ultimoToque, ahora);

  const primeros = primerToquePorPersona(toques);
  const espejos = [...primeros.entries()]
    .map(([id, m]) => ventanaEspejo(m, id, cd, ahora))
    .filter((e) => e.doctores > 0)
    .sort((a, b) => b.doctores - a.doctores);

  // solapamiento: dos personas que trabajan al mismo doctor no se pueden separar
  const carteras = [...primeros.entries()].map(([id, m]) => ({ id, set: new Set(m.keys()) }));
  const solapes: { a: string; b: string; n: number; total: number }[] = [];
  for (let i = 0; i < carteras.length; i++)
    for (let j = i + 1; j < carteras.length; j++) {
      const n = [...carteras[i].set].filter((x) => carteras[j].set.has(x)).length;
      if (n > 0)
        solapes.push({
          a: carteras[i].id,
          b: carteras[j].id,
          n,
          total: Math.min(carteras[i].set.size, carteras[j].set.size),
        });
    }

  const conCaso = [...cd.keys()];
  const sinToqueNunca = conCaso.filter((d) => !ultimoToque.has(d));
  const casosSinToque = sinToqueNunca.reduce((a, d) => a + (cd.get(d)?.length ?? 0), 0);
  const casos180SinToque = sinToqueNunca.reduce(
    (a, d) => a + (cd.get(d)?.filter((t) => t >= ahora - 180 * 86_400_000).length ?? 0),
    0
  );

  const ESTADOS: EstadoCadencia[] = ["al_dia", "atrasado", "dormido", "perdido"];
  const COLOR: Record<EstadoCadencia, string> = {
    al_dia: "text-emerald-600 dark:text-emerald-400",
    atrasado: "text-amber-600 dark:text-amber-400",
    dormido: "text-orange-600 dark:text-orange-400",
    perdido: "text-red-600 dark:text-red-400",
  };

  return (
    <div className="space-y-8">
      {/* ---- 1. El reloj de la cartera ---- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          El reloj de la cartera
        </h2>
        <p className="text-sm text-muted-foreground">
          Cada doctor se mide contra su propio ritmo: la mediana de días entre sus
          casos. Al día = dentro de 1,2× su ritmo · atrasado = hasta 3× · dormido
          = más de 3× · perdido = más de un año sin caso. Entran solo los doctores
          con al menos 3 casos (dos intervalos cerrados): sin ritmo propio no hay
          reloj que mirar. Nadie puede mover estos números cargando actividad.
        </p>
        {ultimo ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {ESTADOS.map((e) => (
              <div key={e} className="rounded-lg border bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {ESTADO_LABEL[e]}
                </p>
                <p className={cn("text-2xl font-semibold tabular-nums", COLOR[e])}>
                  {ultimo[e]}
                </p>
                <p className="text-xs text-muted-foreground">
                  de {ultimo.elegibles} · cierre {ultimo.mes}
                </p>
              </div>
            ))}
          </div>
        ) : null}
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Cierre de mes</TableHead>
                <TableHead className="text-right">Con reloj</TableHead>
                {ESTADOS.map((e) => (
                  <TableHead key={e} className="text-right">
                    {ESTADO_LABEL[e]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {serie.map((p) => (
                <TableRow key={p.mes}>
                  <TableCell className="font-medium tabular-nums">{p.mes}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {p.elegibles}
                  </TableCell>
                  {ESTADOS.map((e) => (
                    <TableCell key={e} className={cn("text-right tabular-nums", COLOR[e])}>
                      {p[e]}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {serie.length > 1 ? (
          <p className="text-xs text-muted-foreground">
            Lo que hay que mirar es la primera columna contra la segunda: los
            doctores con reloj pasaron de {serie[0].elegibles} a {ultimo.elegibles}{" "}
            y los “al día” de {serie[0].al_dia} a {ultimo.al_dia}. La cartera
            creció; el stock de doctores en ritmo, no.
          </p>
        ) : null}
      </section>

      {/* ---- 2. Semáforo de la cartera ---- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Dónde está la producción
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Doctores</TableHead>
                <TableHead className="text-right">Casos 12m</TableHead>
                <TableHead className="text-right">Deuda</TableHead>
                <TableHead className="text-right">Tocados 30d</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tiers.map((f) => (
                <TableRow key={f.tier}>
                  <TableCell className="font-medium">
                    {f.tier}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {f.tier === "A"
                        ? "4+ casos en 12m"
                        : f.tier === "B"
                          ? "1 a 3 casos"
                          : "ninguno en 12m"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{f.doctores}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {f.casos12m}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-amber-600 dark:text-amber-400">
                    {f.deuda}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {f.tocados30d}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          “Deuda” son los doctores vencidos de su propio reloj y sin caso nuevo en
          30 días. El criterio a propósito NO mira si alguien los contactó: si lo
          mirara, diez WhatsApp borrarían la deuda sin que entre un solo caso.
          “Tocados 30d” va al lado, nunca adentro.
        </p>
      </section>

      {/* ---- 3. La ventana espejo, con placebo ---- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          ¿El contacto mueve al doctor?
        </h2>
        <p className="text-sm text-muted-foreground">
          Casos nuevos de cada doctor en la ventana anterior a su primer contacto
          con esa persona, contra la misma ventana posterior. Al lado, la columna
          que hace honesto al número: <strong>el mismo cálculo un año antes</strong>,
          cuando esa persona todavía no había tocado a nadie. Si el placebo sube
          igual que la ventana real, lo que se está midiendo es el ciclo del
          doctor, no el trabajo de la persona.
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Persona</TableHead>
                <TableHead className="text-right">Doctores</TableHead>
                <TableHead className="text-right">Antes</TableHead>
                <TableHead className="text-right">Después</TableHead>
                <TableHead className="text-right">Suben</TableHead>
                <TableHead className="text-right text-muted-foreground">
                  Placebo antes
                </TableHead>
                <TableHead className="text-right text-muted-foreground">
                  Placebo después
                </TableHead>
                <TableHead className="text-right text-muted-foreground">
                  Placebo suben
                </TableHead>
                <TableHead className="text-right">Lectura</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {espejos.map((e) => {
                const real = e.despues - e.antes;
                const placebo = e.despuesPlacebo - e.antesPlacebo;
                const sobrevive = real > 0 && real > placebo;
                return (
                  <TableRow key={e.personaId}>
                    <TableCell className="font-medium">
                      {nombreDe.get(e.personaId) ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{e.doctores}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.antes}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {e.despues}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{e.suben}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {e.antesPlacebo}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {e.despuesPlacebo}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {e.subenPlacebo}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {sobrevive ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          supera al placebo
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          no supera al placebo
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {solapes.length ? (
          <p className="text-sm">
            {solapes.map((s) => (
              <span key={`${s.a}-${s.b}`} className="block text-amber-700 dark:text-amber-400">
                {s.n} de los {s.total} doctores que toca{" "}
                {nombreDe.get(s.b) ?? "—"} también los toca{" "}
                {nombreDe.get(s.a) ?? "—"}. Las filas no se suman y no se pueden
                separar.
              </span>
            ))}
          </p>
        ) : null}
      </section>

      {/* ---- 4. Lo que nadie explica ---- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Producción que nadie explica
        </h2>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-2xl font-semibold tabular-nums">
            {sinToqueNunca.length}{" "}
            <span className="text-base font-normal text-muted-foreground">
              de {conCaso.length} doctores con casos
            </span>
          </p>
          <p className="text-sm text-muted-foreground">
            mandaron {casosSinToque} casos históricos ({casos180SinToque} en los
            últimos 180 días) sin un solo contacto registrado de nadie. Mientras
            este número siga así de grande, cualquier medición de impacto del
            equipo se está haciendo sobre menos de dos tercios del negocio.
          </p>
        </div>
      </section>

      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        Cómo leer esta pantalla. No hay score por persona a propósito: México
        produce entre 13 y 35 casos nuevos por mes, y con ese volumen no se puede
        probar que un llamado causa un caso — haría falta un orden de magnitud más
        de doctores. La autoría de las actividades tampoco es un hecho: el 95% de
        las de Juan y el 82% de las de Rocío las repartió un backfill el 23/8/26
        según el TIPO de actividad (llamadas a Rocío, el resto a Juan). Además el
        sync del intranet trae hoy una sola cuenta, así que parte de lo que hace
        Rocío figura cargado por Juan. Este tablero sirve para decidir a quién
        llamar y para discutir con datos. No sirve para pagar un bono.
      </p>
    </div>
  );
}

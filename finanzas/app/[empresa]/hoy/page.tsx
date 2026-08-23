import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort } from "@/lib/dates";
import { currentPeriodIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { calcularAlertas } from "@/lib/alertas";
import { cargarTratamientosNuevos } from "@/lib/liquidaciones/comision-claudia-query";

type Balance = {
  account_id: string; name: string; type: string; currency: string;
  include_in_totals: boolean; is_active: boolean; balance: number;
  pending_count: number; last_movement_on: string | null;
};
type Resumen = { month: string; currency: string; income: number | null; expense: number | null; result: number | null };

export default async function HoyPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ vs?: string; mes?: string }>;
}) {
  const { empresa } = await params;
  const { vs = "prev", mes } = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;
  // el mes en curso por defecto; ?mes=YYYY-MM para mirar cualquier otro
  const periodo = /^\d{4}-\d{2}$/.test(mes ?? "")
    ? (mes as string)
    : currentPeriodIn(ctx.config.timezone);

  // TODO junto y en paralelo: cada await secuencial es un viaje más a la base
  const [
    alertas,
    { data: cuentasInfo },
    { data: balances },
    { data: resumen },
    { data: ultimosRaw },
    { data: porPagar },
    { data: porCobrar },
    { data: recientesRaw },
    { data: mensualCuenta },
    { data: consultasRaw },
    tratamientosNuevos,
  ] = await Promise.all([
    calcularAlertas(supabase, { companyId: ctx.companyId, config: ctx.config }),
    supabase.from("accounts").select("id, name, currency, ks_custody, separate_books")
      .eq("company_id", ctx.companyId),
    supabase.from("v_account_balances").select("*").eq("company_id", ctx.companyId),
    supabase.from("v_monthly_summary").select("month, currency, income, expense, result")
      .eq("company_id", ctx.companyId).order("month"),
    supabase.from("movements")
      .select("id, occurred_on, kind, amount, currency, description, status, account_id, counterparty:counterparties(display_name), category:categories(name)")
      .eq("company_id", ctx.companyId).neq("status", "void")
      .order("occurred_on", { ascending: false }).order("created_at", { ascending: false }).limit(24),
    supabase.from("v_payables_buckets").select("id, concept, counterparty_name, currency, balance, due_on, bucket")
      .eq("company_id", ctx.companyId).in("bucket", ["vencido", "hoy", "semana"])
      .order("due_on").limit(6),
    supabase.from("v_receivables_aging").select("id, counterparty_name, concept, currency, balance, bucket, days_overdue")
      .eq("company_id", ctx.companyId).order("days_overdue", { ascending: false }).limit(6),
    supabase.from("movements")
      .select("id, occurred_on, kind, amount, currency, description, account_id, transfer_group_id, counterparty:counterparties(display_name)")
      .eq("company_id", ctx.companyId).neq("status", "void")
      .order("occurred_on", { ascending: false }).order("created_at", { ascending: false }).limit(600),
    supabase.from("v_monthly_income_by_account").select("account_id, account_name, ks_custody, separate_books, month, currency, income")
      .eq("company_id", ctx.companyId).gte("month", "2026-01-01"),
    // primeras consultas: el cobro de categoría "Consulta" es la puerta de
    // entrada de cada paciente nuevo
    supabase.from("movements")
      .select("occurred_on, counterparty_id, category_id, description, counterparty:counterparties(display_name), category:categories!inner(name)")
      .eq("company_id", ctx.companyId).eq("kind", "income").neq("status", "void")
      .eq("categories.name", "Consulta").gte("occurred_on", "2026-01-01"),
    // tratamientos nuevos = PRIMERA seña/cuota de Alineadores de cada paciente
    // (misma cuenta que dispara la comisión de Claudia: un solo criterio)
    cargarTratamientosNuevos(supabase, ctx.companyId),
  ]);
  const idsSep = (cuentasInfo ?? []).filter((a) => a.separate_books).map((a) => a.id);
  const ultimos = (ultimosRaw ?? []).filter((m) => !idsSep.includes(m.account_id)).slice(0, 10);

  // ---- Últimos movimientos POR CUENTA (desplegable de Disponibilidad)
  type Reciente = NonNullable<typeof recientesRaw>[number];
  const porCuentaReciente = new Map<string, Reciente[]>();
  for (const m of recientesRaw ?? []) {
    const arr = porCuentaReciente.get(m.account_id) ?? [];
    if (arr.length < 8) { arr.push(m); porCuentaReciente.set(m.account_id, arr); }
  }
  // pareja de cada transferencia: grupo → cuentas involucradas
  const gruposTransfer = [...new Set((recientesRaw ?? [])
    .filter((m) => m.transfer_group_id).map((m) => m.transfer_group_id as string))];
  const parPorGrupo = new Map<string, { account_id: string; kind: string }[]>();
  if (gruposTransfer.length) {
    const { data: patas } = await supabase
      .from("movements").select("transfer_group_id, account_id, kind")
      .eq("company_id", ctx.companyId).in("transfer_group_id", gruposTransfer.slice(0, 200));
    for (const pt of patas ?? []) {
      const arr = parPorGrupo.get(pt.transfer_group_id as string) ?? [];
      arr.push({ account_id: pt.account_id, kind: pt.kind });
      parPorGrupo.set(pt.transfer_group_id as string, arr);
    }
  }

  // ---- Ingresos por cuenta, mes a mes (vista agregada en la base)
  type CuentaMes = { nombre: string; currency: string; ksCustody: boolean; accountId: string; meses: Map<string, number>; total: number };
  const porCuenta = new Map<string, CuentaMes>();
  const nombreCuenta = new Map<string, string>();
  for (const a of cuentasInfo ?? []) nombreCuenta.set(a.id, a.name);
  for (const r of mensualCuenta ?? []) {
    if (r.separate_books) continue;              // Coni tiene su propio cuadro
    const k = r.account_id + "|" + r.currency;
    const c = porCuenta.get(k) ?? {
      nombre: r.account_name, currency: r.currency, ksCustody: Boolean(r.ks_custody),
      accountId: r.account_id, meses: new Map<string, number>(), total: 0,
    };
    const mes = String(r.month).slice(0, 7);
    c.meses.set(mes, (c.meses.get(mes) ?? 0) + Number(r.income));
    c.total += Number(r.income);
    porCuenta.set(k, c);
  }
  const cuadros = [...porCuenta.values()].sort((a, b) => b.total - a.total);
  const mesesDelAnio = ["2026-01","2026-02","2026-03","2026-04","2026-05","2026-06","2026-07","2026-08","2026-09","2026-10","2026-11","2026-12"]
    .filter((m) => m <= periodo || cuadros.some((c) => c.meses.has(m)));

  // ---- Primeras consultas: PACIENTES únicos por mes (uno puede pagar la
  // consulta en dos partes el mismo día — eso es un paciente, no dos)
  const consultasPorMes = new Map<string, Set<string>>();
  const detalleConsultas = new Map<string, { fecha: string; nombre: string }[]>();
  let catConsultaId: string | null = null;
  for (const c of [...(consultasRaw ?? [])].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on))) {
    catConsultaId ??= c.category_id ?? null;
    const mes = c.occurred_on.slice(0, 7);
    const quien = c.counterparty_id ?? (c.description ?? "").toLowerCase().trim();
    if (!quien) continue;
    if (!consultasPorMes.has(mes)) { consultasPorMes.set(mes, new Set()); detalleConsultas.set(mes, []); }
    const set = consultasPorMes.get(mes)!;
    if (set.has(quien)) continue;                       // ya contado: no repetir
    set.add(quien);
    detalleConsultas.get(mes)!.push({
      fecha: c.occurred_on,
      nombre: (c.counterparty as { display_name?: string } | null)?.display_name || c.description || "(sin nombre)",
    });
  }
  const mesesConsulta = [...consultasPorMes.keys()].sort();
  const serieConsultas = mesesConsulta.map((m) => ({ mes: m, n: consultasPorMes.get(m)!.size }));
  const consultasMes = consultasPorMes.get(periodo)?.size ?? 0;
  const idxActual = serieConsultas.findIndex((s) => s.mes === periodo);
  const consultasPrev = idxActual > 0 ? serieConsultas[idxActual - 1].n : null;
  const maxConsultas = Math.max(1, ...serieConsultas.map((s) => s.n));

  // ---- Tratamientos nuevos (primer pago): misma serie de meses que arriba
  const tratPorMes = new Map<string, { fecha: string; nombre: string }[]>();
  for (const t of [...tratamientosNuevos].sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    const arr = tratPorMes.get(t.mes) ?? [];
    arr.push({ fecha: t.fecha, nombre: t.paciente });
    tratPorMes.set(t.mes, arr);
  }
  const mesesUnion = [...new Set([...mesesConsulta, ...tratPorMes.keys()])].sort();
  const serieTrat = mesesUnion.map((m) => ({ mes: m, n: tratPorMes.get(m)?.length ?? 0 }));
  const tratMes = tratPorMes.get(periodo)?.length ?? 0;
  const idxTrat = serieTrat.findIndex((s) => s.mes === periodo);
  const tratPrev = idxTrat > 0 ? serieTrat[idxTrat - 1].n : null;
  const maxTrat = Math.max(1, ...serieTrat.map((s) => s.n));

  // ---- Disponibilidad: un bucket por moneda, JAMÁS sumados entre sí
  const porMoneda = new Map<string, Balance[]>();
  const sepBalances = ((balances ?? []) as Balance[]).filter((b) => idsSep.includes(b.account_id));
  for (const b of (balances ?? []) as Balance[]) {
    if (!b.is_active) continue;
    if (idsSep.includes(b.account_id)) continue;
    if (!porMoneda.has(b.currency)) porMoneda.set(b.currency, []);
    porMoneda.get(b.currency)!.push(b);
  }
  const monedasOrdenadas = ctx.config.monedas.filter((m) => porMoneda.has(m))
    .concat([...porMoneda.keys()].filter((m) => !ctx.config.monedas.includes(m)));

  // ---- Este mes vs comparador
  const filas = (resumen ?? []) as Resumen[];
  const mesActual = filas.filter((r) => r.month.slice(0, 7) === periodo);
  const [y, m] = periodo.split("-").map(Number);
  const prevPeriodo = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const nextPeriodo = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const ultimoConDatos = filas.length ? filas[filas.length - 1].month.slice(0, 7) : null;
  const vacio = mesActual.length === 0;
  const nombreMes = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
  const urlMes = (p: string) => `/${empresa}/hoy?mes=${p}&vs=${vs}`;

  function comparador(currency: string): { label: string; income: number; expense: number } | null {
    const del = (p: string) => filas.find((r) => r.month.slice(0, 7) === p && r.currency === currency);
    if (vs === "prev") {
      const r = del(prevPeriodo);
      return r ? { label: "mes anterior", income: r.income ?? 0, expense: r.expense ?? 0 } : null;
    }
    if (vs === "avg3") {
      const tres = [1, 2, 3].map((i) => {
        const mm = m - i;
        const p = mm >= 1 ? `${y}-${String(mm).padStart(2, "0")}` : `${y - 1}-${String(12 + mm).padStart(2, "0")}`;
        return del(p);
      }).filter(Boolean) as Resumen[];
      if (!tres.length) return null;
      return {
        label: "prom. 3 meses",
        income: tres.reduce((a, r) => a + (r.income ?? 0), 0) / tres.length,
        expense: tres.reduce((a, r) => a + (r.expense ?? 0), 0) / tres.length,
      };
    }
    const anio = filas.filter((r) => r.month.startsWith(String(y)) && r.currency === currency);
    if (!anio.length) return null;
    return {
      label: `acumulado ${y}`,
      income: anio.reduce((a, r) => a + (r.income ?? 0), 0),
      expense: anio.reduce((a, r) => a + (r.expense ?? 0), 0),
    };
  }

  const finDeMes = (p: string) => {
    const [y, m] = p.split("-").map(Number);
    return `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  };
  const deltaConsultas = consultasPrev === null ? null : consultasMes - consultasPrev;
  const deltaTrat = tratPrev === null ? null : tratMes - tratPrev;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      {/* ---- encabezado: el mes + el pulso de pacientes nuevos ---- */}
      {serieConsultas.length > 0 ? (
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{ctx.config.nombre}</h1>
            <p className="text-sm capitalize text-muted-foreground">{nombreMes}</p>
          </div>

          <div className="flex flex-wrap items-stretch gap-3">
            <PulsoCard
              titulo="Pacientes nuevos"
              pie="primeras consultas"
              n={consultasMes}
              delta={deltaConsultas}
              prev={consultasPrev}
              serie={serieConsultas}
              max={maxConsultas}
              periodo={periodo}
              tono="emerald"
              detalle={detalleConsultas.get(periodo) ?? []}
              locale={locale}
              href={`/${empresa}/movimientos?f=ingresos&cat=${catConsultaId ?? ""}&desde=${periodo}-01&hasta=${finDeMes(periodo)}`}
              hrefLabel="Ver los cobros de estas consultas →"
            />
            <PulsoCard
              titulo="Tratamientos nuevos"
              pie={consultasMes > 0 ? `arrancaron · ${Math.round((tratMes / consultasMes) * 100)}% de las consultas` : "arrancaron tratamiento"}
              n={tratMes}
              delta={deltaTrat}
              prev={tratPrev}
              serie={serieTrat}
              max={maxTrat}
              periodo={periodo}
              tono="sky"
              detalle={tratPorMes.get(periodo) ?? []}
              locale={locale}
              href={`/${empresa}/liquidaciones`}
              hrefLabel="Ver liquidaciones y comisión →"
            />
          </div>
        </header>
      ) : null}

      {/* ---- alertas: lo que el sistema encontró solo ---- */}
      {alertas.length > 0 ? (
        <section className="space-y-1.5">
          {alertas.map((a) => (
            <Link
              key={a.id}
              href={a.href ?? "#"}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm transition-colors hover:bg-accent/50",
                a.severidad === "critica"
                  ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
                  : a.severidad === "atencion"
                  ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
                  : "bg-card"
              )}
            >
              <span
                className={cn(
                  "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                  a.severidad === "critica" ? "bg-red-500"
                    : a.severidad === "atencion" ? "bg-amber-500"
                    : "bg-muted-foreground/40"
                )}
              />
              <span className="min-w-0">
                <span className={cn("font-medium",
                  a.severidad === "critica" && "text-red-800 dark:text-red-200",
                  a.severidad === "atencion" && "text-amber-900 dark:text-amber-200")}>
                  {a.titulo}
                </span>
                {a.detalle ? (
                  <span className="ml-2 text-muted-foreground">{a.detalle}</span>
                ) : null}
              </span>
            </Link>
          ))}
        </section>
      ) : null}

      {/* ---- fila 1: disponibilidad ---- */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Disponibilidad
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {monedasOrdenadas.map((moneda) => {
            const cuentas = porMoneda.get(moneda) ?? [];
            const total = cuentas
              .filter((c) => c.include_in_totals)
              .reduce((a, c) => a + Number(c.balance), 0);
            return (
              <div key={moneda} className="rounded-xl border bg-card p-5 shadow-sm">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {moneda}
                  </span>
                  <span className="fig text-3xl font-semibold">
                    {formatMoney(total, moneda, locale)}
                  </span>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {cuentas.map((c) => {
                    const recientes = (porCuentaReciente.get(c.account_id) ?? [])
                      .filter((m) => m.currency === moneda);
                    return (
                      <details key={c.account_id} className="group rounded-lg border text-sm transition-colors open:bg-accent/30">
                        <summary className="flex cursor-pointer select-none items-center justify-between px-3 py-2 hover:bg-accent">
                          <span className="flex items-center gap-2 truncate">
                            <span className="text-[10px] text-muted-foreground transition-transform group-open:rotate-90">›</span>
                            {c.pending_count > 0 ? (
                              <span title={`${c.pending_count} pendientes`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                            ) : null}
                            <span className={cn("truncate", !c.include_in_totals && "text-muted-foreground")}>
                              {c.name}
                            </span>
                          </span>
                          <span className="fig font-medium">
                            {formatMoney(Number(c.balance), moneda, locale)}
                          </span>
                        </summary>
                        <div className="border-t px-3 py-2">
                          {recientes.length === 0 ? (
                            <p className="py-1 text-xs text-muted-foreground">Sin movimientos recientes.</p>
                          ) : (
                            <div className="space-y-1">
                              {recientes.map((m) => {
                                const esTransfer = m.kind === "transfer_in" || m.kind === "transfer_out";
                                const negativo = m.kind === "expense" || m.kind === "transfer_out";
                                let etiqueta = m.description
                                  || (m.counterparty as { display_name?: string } | null)?.display_name
                                  || "—";
                                if (esTransfer && m.transfer_group_id) {
                                  const otra = (parPorGrupo.get(m.transfer_group_id) ?? [])
                                    .find((pt) => pt.account_id !== m.account_id);
                                  const otroNombre = otra ? nombreCuenta.get(otra.account_id) : null;
                                  if (otroNombre) {
                                    etiqueta = m.kind === "transfer_in"
                                      ? `Transferencia desde ${otroNombre}`
                                      : `Transferencia hacia ${otroNombre}`;
                                  }
                                }
                                return (
                                  <div key={m.id} className="flex items-center gap-2 text-[11px]">
                                    <span className="fig w-10 shrink-0 text-muted-foreground">
                                      {m.occurred_on.slice(8, 10)}/{m.occurred_on.slice(5, 7)}
                                    </span>
                                    <span className={cn("min-w-0 flex-1 truncate", esTransfer && "italic text-muted-foreground")}>
                                      {etiqueta}
                                    </span>
                                    <span className={cn("fig shrink-0 text-right",
                                      !esTransfer && m.kind === "income" && "text-emerald-600 dark:text-emerald-400",
                                      !esTransfer && m.kind === "expense" && "text-red-600 dark:text-red-400",
                                      esTransfer && "text-muted-foreground")}>
                                      {negativo ? "−" : "+"}{formatMoney(Number(m.amount), moneda, locale)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <Link
                            href={`/${empresa}/movimientos?cuenta=${c.account_id}`}
                            className="mt-2 inline-block text-[11px] font-medium text-primary hover:underline"
                          >
                            Ver todos y filtrar →
                          </Link>
                        </div>
                      </details>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {monedasOrdenadas.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              Sin cuentas todavía. Corré el seed o creá cuentas en Configuración.
            </div>
          ) : null}
        </div>
        {sepBalances.length ? (
          <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/50 p-4 dark:border-violet-900 dark:bg-violet-950/30">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                Caja Coni — contabilidad separada
              </span>
              <Link href={`/${empresa}/movimientos?f=coni`} className="text-xs font-medium text-violet-700 hover:underline dark:text-violet-300">
                Ver movimientos →
              </Link>
            </div>
            <div className="flex flex-wrap gap-6">
              {sepBalances.map((b) => (
                <div key={b.account_id} className="text-sm">
                  <span className="text-muted-foreground">{b.name}: </span>
                  <span className="fig font-semibold">{formatMoney(Number(b.balance), b.currency, locale)}</span>
                </div>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">No suma en la disponibilidad ni en los ingresos del consultorio.</p>
          </div>
        ) : null}
      </section>

      {/* ---- fila 2: este mes ---- */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Link
              href={urlMes(prevPeriodo)}
              className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
              title="Mes anterior"
            >
              ←
            </Link>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {nombreMes}
            </h2>
            <Link
              href={urlMes(nextPeriodo)}
              className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
              title="Mes siguiente"
            >
              →
            </Link>
          </div>
          <div className="flex gap-1 rounded-lg border bg-card p-0.5 text-xs">
            {[
              ["prev", "vs mes anterior"],
              ["avg3", "vs prom. 3m"],
              ["acum", "acumulado"],
            ].map(([k, label]) => (
              <Link
                key={k}
                href={`/${empresa}/hoy?mes=${periodo}&vs=${k}`}
                className={cn(
                  "rounded-md px-2.5 py-1 font-medium transition-colors",
                  vs === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                )}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
        {vacio ? (
          <div className="mb-3 rounded-lg border border-dashed bg-card px-4 py-3 text-sm text-muted-foreground">
            {nombreMes} todavía no tiene movimientos cargados.
            {ultimoConDatos && ultimoConDatos !== periodo ? (
              <>
                {" "}El último mes con datos es{" "}
                <Link href={urlMes(ultimoConDatos)} className="font-medium text-primary hover:underline">
                  {new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(
                    new Date(Date.UTC(Number(ultimoConDatos.slice(0, 4)), Number(ultimoConDatos.slice(5, 7)) - 1, 1))
                  )}
                </Link>
                .
              </>
            ) : null}
          </div>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          {ctx.config.monedas.map((moneda) => {
            const actual = mesActual.find((r) => r.currency === moneda);
            const comp = comparador(moneda);
            const income = actual?.income ?? 0;
            const expense = actual?.expense ?? 0;
            return (
              <div key={moneda} className="rounded-xl border bg-card p-5 shadow-sm">
                <div className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {moneda}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <Kpi label="Ingresos" valor={formatMoney(income, moneda, locale)} delta={vacio ? null : delta(income, comp?.income)} deltaLabel={comp?.label} />
                  <Kpi label="Egresos" valor={formatMoney(expense, moneda, locale)} delta={vacio ? null : delta(expense, comp?.expense)} deltaLabel={comp?.label} invert />
                  <Kpi label="Resultado" valor={formatMoney(income - expense, moneda, locale)} strong />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---- ingresos por cuenta ---- */}
      {cuadros.length ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Qué entra por cuenta, mes a mes
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {cuadros.map((c) => {
              const max = Math.max(...mesesDelAnio.map((m) => c.meses.get(m) ?? 0), 1);
              return (
                <div key={c.nombre + c.currency} className="rounded-xl border bg-card p-4 shadow-sm">
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-sm font-semibold">
                      {c.nombre}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">{c.currency}</span>
                      {c.ksCustody ? (
                        <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          en KS
                        </span>
                      ) : null}
                    </span>
                    <span className="fig text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                      {formatMoney(c.total, c.currency, locale)}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {mesesDelAnio.map((m) => {
                      const v = c.meses.get(m) ?? 0;
                      const nombreMesCorto = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short" })
                        .format(new Date(`${m}-15T12:00:00Z`));
                      const fin = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
                      return (
                        <Link
                          key={m}
                          href={`/${empresa}/movimientos?f=ingresos&cuenta=${c.accountId}&desde=${m}-01&hasta=${m}-${String(fin).padStart(2, "0")}`}
                          className="flex items-center gap-2 rounded-sm text-[11px] transition-colors hover:bg-accent"
                          title={`Ver los ingresos de ${c.nombre} en ${nombreMesCorto}`}
                        >
                          <span className="w-8 shrink-0 text-muted-foreground">{nombreMesCorto}</span>
                          <div className="h-3 flex-1 overflow-hidden rounded-sm bg-secondary/60">
                            <div className="h-full rounded-sm bg-emerald-500/80" style={{ width: `${Math.round((v / max) * 100)}%` }} />
                          </div>
                          <span className="fig w-24 shrink-0 text-right">{v ? formatMoney(v, c.currency, locale) : "—"}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ---- fila 3: qué vence y quién debe ---- */}
      {(porPagar ?? []).length > 0 || (porCobrar ?? []).length > 0 ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Vence pronto
              </h2>
              <Link href={`/${empresa}/pagar`} className="text-xs font-medium text-primary hover:underline">
                Ver todo →
              </Link>
            </div>
            {(porPagar ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Nada vence esta semana.</p>
            ) : (
              <ul className="space-y-1.5">
                {(porPagar ?? []).map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full",
                        p.bucket === "vencido" ? "bg-red-500" : p.bucket === "hoy" ? "bg-amber-500" : "bg-muted-foreground/40")} />
                      <span className="truncate">{p.concept}</span>
                      {p.counterparty_name ? (
                        <span className="truncate text-muted-foreground">{p.counterparty_name}</span>
                      ) : null}
                    </span>
                    <span className="fig shrink-0 font-medium">
                      {formatMoney(Number(p.balance), p.currency, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Te deben
              </h2>
              <Link href={`/${empresa}/cobrar`} className="text-xs font-medium text-primary hover:underline">
                Ver todo →
              </Link>
            </div>
            {(porCobrar ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin deudas registradas.</p>
            ) : (
              <ul className="space-y-1.5">
                {(porCobrar ?? []).map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{d.counterparty_name}</span>
                      <span className="truncate text-muted-foreground">{d.concept}</span>
                      {Number(d.days_overdue) > 0 ? (
                        <span className="shrink-0 text-[11px] text-red-600 dark:text-red-400">
                          {d.days_overdue}d
                        </span>
                      ) : null}
                    </span>
                    <span className="fig shrink-0 font-medium">
                      {formatMoney(Number(d.balance), d.currency, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}

      {/* ---- últimos movimientos ---- */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Últimos movimientos
          </h2>
          <Link href={`/${empresa}/movimientos`} className="text-xs font-medium text-primary hover:underline">
            Ver todos →
          </Link>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          {(ultimos ?? []).length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Sin movimientos todavía. Cargá el primero con “+ Nuevo”.
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {(ultimos ?? []).map((mv) => {
                  const esTransfer = mv.kind === "transfer_in" || mv.kind === "transfer_out";
                  const signo = mv.kind === "income" || mv.kind === "transfer_in" ? 1 : -1;
                  const cp = (mv.counterparty as { display_name?: string } | null)?.display_name;
                  const cat = (mv.category as { name?: string } | null)?.name;
                  return (
                    <tr key={mv.id} className="border-b last:border-0">
                      <td className="w-20 px-4 py-2 text-muted-foreground">
                        {formatDateShort(mv.occurred_on, locale)}
                      </td>
                      <td className="max-w-[280px] truncate px-2 py-2 font-medium">
                        {mv.description || cp || (esTransfer ? "Transferencia interna" : "—")}
                      </td>
                      <td className="hidden px-2 py-2 text-muted-foreground sm:table-cell">
                        {cat ?? (esTransfer ? "Transferencia" : "—")}
                      </td>
                      <td
                        className={cn(
                          "fig w-36 px-4 py-2 text-right font-medium",
                          !esTransfer && mv.kind === "expense" && "text-red-600 dark:text-red-400",
                          !esTransfer && mv.kind === "income" && "text-emerald-600 dark:text-emerald-400",
                          esTransfer && "text-muted-foreground"
                        )}
                      >
                        {signo < 0 ? "−" : "+"}{formatMoney(Number(mv.amount), mv.currency, locale)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function delta(actual: number, base?: number): number | null {
  if (base == null || base === 0) return null;
  return ((actual - base) / base) * 100;
}

function Kpi({
  label, valor, delta, deltaLabel, invert, strong,
}: {
  label: string; valor: string; delta?: number | null; deltaLabel?: string;
  invert?: boolean; strong?: boolean;
}) {
  const bueno = delta != null && (invert ? delta < 0 : delta > 0);
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("fig mt-0.5 text-xl font-semibold", strong && "text-2xl")}>{valor}</div>
      {delta != null ? (
        <div
          className={cn(
            "mt-0.5 text-[11px] font-medium",
            bueno ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"
          )}
          title={deltaLabel}
        >
          {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(0)}%
        </div>
      ) : null}
    </div>
  );
}

/** Tarjeta de pulso: el número grande y, al desplegarla, quiénes son. */
function PulsoCard({
  titulo, pie, n, delta, prev, serie, max, periodo, tono, detalle, locale, href, hrefLabel,
}: {
  titulo: string;
  pie: string;
  n: number;
  delta: number | null;
  prev: number | null;
  serie: { mes: string; n: number }[];
  max: number;
  periodo: string;
  tono: "emerald" | "sky";
  detalle: { fecha: string; nombre: string }[];
  locale: string;
  href: string;
  hrefLabel: string;
}) {
  const color = tono === "emerald"
    ? { texto: "text-emerald-600 dark:text-emerald-400", barra: "bg-emerald-500", barraOff: "bg-emerald-500/25 group-open:bg-emerald-500/40" }
    : { texto: "text-sky-600 dark:text-sky-400", barra: "bg-sky-500", barraOff: "bg-sky-500/25 group-open:bg-sky-500/40" };
  return (
    <details className="group rounded-xl border bg-card transition-colors open:bg-accent/20 hover:bg-accent/40">
      <summary className="flex cursor-pointer list-none items-stretch gap-4 px-4 py-3" title={`Ver quiénes son (${n})`}>
        <div className="flex flex-col justify-center">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {titulo}
          </span>
          <div className="flex items-baseline gap-2">
            <span className={cn("fig text-3xl font-semibold leading-none", color.texto)}>{n}</span>
            {delta !== null ? (
              <span className={cn("text-xs font-medium",
                delta > 0 ? "text-emerald-600 dark:text-emerald-400"
                  : delta < 0 ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground")}>
                {delta > 0 ? "↑" : delta < 0 ? "↓" : "="}{delta !== 0 ? Math.abs(delta) : ""}
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground transition-transform group-open:rotate-180">▾</span>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {pie}{prev !== null ? ` · ${prev} el mes pasado` : ""}
          </span>
        </div>
        <div className="flex items-end gap-1 border-l pl-4" aria-hidden>
          {serie.slice(-8).map((s) => {
            const alto = Math.max(4, Math.round((s.n / max) * 40));
            const esActual = s.mes === periodo;
            return (
              <span key={s.mes} className="flex flex-col items-center gap-1" title={`${s.mes}: ${s.n}`}>
                <span
                  style={{ height: `${alto}px` }}
                  className={cn("w-3 rounded-sm transition-colors", esActual ? color.barra : color.barraOff)}
                />
                <span className={cn("text-[9px] tabular-nums", esActual ? "font-semibold text-foreground" : "text-muted-foreground")}>
                  {s.mes.slice(5, 7)}
                </span>
              </span>
            );
          })}
        </div>
      </summary>
      <div className="border-t px-4 py-2">
        {detalle.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">Todavía ninguno este mes.</p>
        ) : (
          <ol className="space-y-0.5">
            {detalle.map((d, i) => (
              <li key={`${d.fecha}-${d.nombre}-${i}`} className="flex items-baseline gap-2 text-xs">
                <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="fig w-11 shrink-0 text-[11px] text-muted-foreground">
                  {formatDateShort(d.fecha, locale)}
                </span>
                <span className="min-w-0 flex-1 truncate">{d.nombre}</span>
              </li>
            ))}
          </ol>
        )}
        <Link href={href} className="mt-2 inline-block text-[11px] font-medium text-primary hover:underline">
          {hrefLabel}
        </Link>
      </div>
    </details>
  );
}

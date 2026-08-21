import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort } from "@/lib/dates";
import { currentPeriodIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { calcularAlertas } from "@/lib/alertas";

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

  const alertas = await calcularAlertas(supabase, { companyId: ctx.companyId, config: ctx.config });

  // contabilidades separadas (caja Coni): fuera de los números del negocio,
  // se muestran en su propio cuadro al pie
  const { data: cuentasSep } = await supabase
    .from("accounts").select("id, name, currency")
    .eq("company_id", ctx.companyId).eq("separate_books", true);
  const idsSep = (cuentasSep ?? []).map((a) => a.id);

  const [{ data: balances }, { data: resumen }, { data: ultimos }, { data: porPagar }, { data: porCobrar }] = await Promise.all([
    supabase.from("v_account_balances").select("*").eq("company_id", ctx.companyId),
    supabase.from("v_monthly_summary").select("month, currency, income, expense, result")
      .eq("company_id", ctx.companyId).order("month"),
    (() => {
      let q = supabase.from("movements")
        .select("id, occurred_on, kind, amount, currency, description, status, counterparty:counterparties(display_name), category:categories(name)")
        .eq("company_id", ctx.companyId).neq("status", "void");
      if (idsSep.length) q = q.not("account_id", "in", `(${idsSep.join(",")})`);
      return q.order("occurred_on", { ascending: false }).order("created_at", { ascending: false }).limit(10);
    })(),
    supabase.from("v_payables_buckets").select("id, concept, counterparty_name, currency, balance, due_on, bucket")
      .eq("company_id", ctx.companyId).in("bucket", ["vencido", "hoy", "semana"])
      .order("due_on").limit(6),
    supabase.from("v_receivables_aging").select("id, counterparty_name, concept, currency, balance, bucket, days_overdue")
      .eq("company_id", ctx.companyId).order("days_overdue", { ascending: false }).limit(6),
  ]);

  // ---- Últimos movimientos POR CUENTA (desplegable de Disponibilidad)
  const { data: recientesRaw } = await supabase
    .from("movements")
    .select("id, occurred_on, kind, amount, currency, description, account_id, transfer_group_id, counterparty:counterparties(display_name)")
    .eq("company_id", ctx.companyId).neq("status", "void")
    .order("occurred_on", { ascending: false }).order("created_at", { ascending: false })
    .limit(600);
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
  const nombreCuenta = new Map<string, string>();

  // ---- Ingresos por cuenta, mes a mes (pedido de Pancho 21/8)
  const { data: ingresosRaw } = await supabase
    .from("movements")
    .select("occurred_on, amount, currency, account_id")
    .eq("company_id", ctx.companyId).eq("kind", "income").neq("status", "void")
    .gte("occurred_on", "2026-01-01")
    .limit(5000);
  type CuentaMes = { nombre: string; currency: string; ksCustody: boolean; meses: Map<string, number>; total: number };
  const porCuenta = new Map<string, CuentaMes>();
  {
    const info = new Map((await supabase
      .from("accounts").select("id, name, currency, ks_custody, separate_books")
      .eq("company_id", ctx.companyId)).data?.map((a) => [a.id, a]) ?? []);
    for (const [id, a] of info) nombreCuenta.set(id, a.name);
    for (const m of ingresosRaw ?? []) {
      const acc = info.get(m.account_id);
      if (!acc || acc.separate_books) continue;          // Coni tiene su propio cuadro
      const k = m.account_id + "|" + m.currency;
      const c = porCuenta.get(k) ?? {
        nombre: acc.name, currency: m.currency, ksCustody: Boolean(acc.ks_custody),
        meses: new Map<string, number>(), total: 0,
      };
      const mes = m.occurred_on.slice(0, 7);
      c.meses.set(mes, (c.meses.get(mes) ?? 0) + Number(m.amount));
      c.total += Number(m.amount);
      porCuenta.set(k, c);
    }
  }
  const cuadros = [...porCuenta.values()].sort((a, b) => b.total - a.total);
  const mesesDelAnio = ["2026-01","2026-02","2026-03","2026-04","2026-05","2026-06","2026-07","2026-08","2026-09","2026-10","2026-11","2026-12"]
    .filter((m) => m <= periodo || cuadros.some((c) => c.meses.has(m)));

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

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
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
                      return (
                        <div key={m} className="flex items-center gap-2 text-[11px]">
                          <span className="w-8 shrink-0 text-muted-foreground">{nombreMesCorto}</span>
                          <div className="h-3 flex-1 overflow-hidden rounded-sm bg-secondary/60">
                            <div className="h-full rounded-sm bg-emerald-500/80" style={{ width: `${Math.round((v / max) * 100)}%` }} />
                          </div>
                          <span className="fig w-24 shrink-0 text-right">{v ? formatMoney(v, c.currency, locale) : "—"}</span>
                        </div>
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

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
                  {cuentas.map((c) => (
                    <Link
                      key={c.account_id}
                      href={`/${empresa}/movimientos?cuenta=${c.account_id}`}
                      className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-accent"
                    >
                      <span className="flex items-center gap-2 truncate">
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
                    </Link>
                  ))}
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

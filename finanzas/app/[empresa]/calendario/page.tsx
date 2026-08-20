import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { currentPeriodIn, todayIn } from "@/lib/dates";
import { cn } from "@/lib/utils";

// Calendario financiero: cada día muestra lo que ENTRA y lo que SALE.
// Mezcla hechos (movimientos ya registrados) con compromisos (vencimientos que
// todavía no pasaron) — que es justo lo que uno quiere ver en un calendario.

export default async function CalendarioPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ m?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale, monedaPrincipal, timezone } = ctx.config;

  const periodo = /^\d{4}-\d{2}$/.test(sp.m ?? "") ? sp.m! : currentPeriodIn(timezone);
  const [y, m] = periodo.split("-").map(Number);
  const desde = `${periodo}-01`;
  const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const hasta = `${periodo}-${String(ultimoDia).padStart(2, "0")}`;
  const hoy = todayIn(timezone);

  const [{ data: movs }, { data: pagar }, { data: cobrar }] = await Promise.all([
    supabase.from("movements")
      .select("occurred_on, kind, amount, currency")
      .eq("company_id", ctx.companyId).neq("status", "void")
      .in("kind", ["income", "expense"])
      .gte("occurred_on", desde).lte("occurred_on", hasta),
    supabase.from("v_payables_buckets").select("due_on, balance, currency, concept")
      .eq("company_id", ctx.companyId).gte("due_on", desde).lte("due_on", hasta),
    supabase.from("v_receivables_aging").select("due_on, balance, currency, counterparty_name")
      .eq("company_id", ctx.companyId).gte("due_on", desde).lte("due_on", hasta),
  ]);

  type Dia = { entra: number; sale: number; compromisos: number; aCobrar: number };
  const dias = new Map<string, Dia>();
  const tocar = (f: string) => {
    if (!dias.has(f)) dias.set(f, { entra: 0, sale: 0, compromisos: 0, aCobrar: 0 });
    return dias.get(f)!;
  };
  for (const mv of movs ?? []) {
    if (mv.currency !== monedaPrincipal) continue;
    const d = tocar(mv.occurred_on);
    if (mv.kind === "income") d.entra += Number(mv.amount);
    else d.sale += Number(mv.amount);
  }
  for (const p of pagar ?? []) {
    if (p.currency !== monedaPrincipal || !p.due_on) continue;
    tocar(p.due_on).compromisos += Number(p.balance);
  }
  for (const c of cobrar ?? []) {
    if (c.currency !== monedaPrincipal || !c.due_on) continue;
    tocar(c.due_on).aCobrar += Number(c.balance);
  }

  const totalEntra = [...dias.values()].reduce((a, d) => a + d.entra, 0);
  const totalSale = [...dias.values()].reduce((a, d) => a + d.sale, 0);

  // la grilla arranca el lunes de la semana del día 1
  const primero = new Date(Date.UTC(y, m - 1, 1));
  const offset = (primero.getUTCDay() + 6) % 7;
  const celdas: Array<string | null> = [
    ...Array(offset).fill(null),
    ...Array.from({ length: ultimoDia }, (_, i) => `${periodo}-${String(i + 1).padStart(2, "0")}`),
  ];

  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const nombreMes = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" })
    .format(new Date(Date.UTC(y, m - 1, 1)));

  return (
    <div className="mx-auto max-w-[1100px] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Calendario financiero</h1>
          <p className="text-sm text-muted-foreground">
            Entra <span className="fig font-medium text-emerald-600 dark:text-emerald-400">{formatMoney(totalEntra, monedaPrincipal, locale)}</span>
            {" · "}sale <span className="fig font-medium text-red-600 dark:text-red-400">{formatMoney(totalSale, monedaPrincipal, locale)}</span>
            {" · "}resultado <span className="fig font-medium">{formatMoney(totalEntra - totalSale, monedaPrincipal, locale)}</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Link href={`/${empresa}/calendario?m=${prev}`}
            className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent">←</Link>
          <span className="text-sm font-medium capitalize">{nombreMes}</span>
          <Link href={`/${empresa}/calendario?m=${next}`}
            className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent">→</Link>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="grid grid-cols-7 border-b bg-muted/40 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((d) => (
            <div key={d} className="py-1.5">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {celdas.map((fecha, i) => {
            if (!fecha) return <div key={`v${i}`} className="min-h-[86px] border-b border-r bg-muted/20" />;
            const d = dias.get(fecha);
            const esHoy = fecha === hoy;
            const num = Number(fecha.slice(8));
            return (
              <div key={fecha}
                className={cn("min-h-[86px] border-b border-r p-1.5 last:border-r-0",
                  esHoy && "bg-accent/40")}>
                <div className={cn("fig mb-1 text-[11px]",
                  esHoy ? "font-semibold text-primary" : "text-muted-foreground")}>
                  {num}
                </div>
                {d ? (
                  <div className="space-y-0.5 text-[11px] leading-tight">
                    {d.entra > 0 ? (
                      <div className="fig font-medium text-emerald-600 dark:text-emerald-400">
                        +{formatMoney(d.entra, monedaPrincipal, locale)}
                      </div>
                    ) : null}
                    {d.sale > 0 ? (
                      <div className="fig font-medium text-red-600 dark:text-red-400">
                        −{formatMoney(d.sale, monedaPrincipal, locale)}
                      </div>
                    ) : null}
                    {d.compromisos > 0 ? (
                      <div className="fig text-amber-600 dark:text-amber-400" title="vence este día">
                        ⏳{formatMoney(d.compromisos, monedaPrincipal, locale)}
                      </div>
                    ) : null}
                    {d.aCobrar > 0 ? (
                      <div className="fig text-muted-foreground" title="a cobrar">
                        ↘{formatMoney(d.aCobrar, monedaPrincipal, locale)}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Verde y rojo son movimientos que ya pasaron. El reloj marca lo que vence
        ese día y todavía no se pagó; la flecha, lo que habría que cobrar.
      </p>
    </div>
  );
}

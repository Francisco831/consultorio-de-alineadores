import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

type Item = {
  id: string; currency: string; gross: number; deductions: number; net: number;
  employer_contributions: number; total_cost: number;
  employee: { display_name: string } | null;
};

export default async function SueldosPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ p?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  const { data: runs } = await supabase
    .from("payroll_runs")
    .select("id, period, status")
    .eq("company_id", ctx.companyId)
    .order("period", { ascending: false });

  const periodos = (runs ?? []).map((r) => r.period);
  const periodo = sp.p && periodos.includes(sp.p) ? sp.p : periodos[0];
  const run = (runs ?? []).find((r) => r.period === periodo);

  const { data: items } = run
    ? await supabase
        .from("payroll_items")
        .select("id, currency, gross, deductions, net, employer_contributions, total_cost, employee:counterparties(display_name)")
        .eq("run_id", run.id)
    : { data: [] };

  const filas = (items ?? []) as unknown as Item[];
  const tot = filas.reduce(
    (a, i) => ({
      gross: a.gross + Number(i.gross),
      net: a.net + Number(i.net),
      contrib: a.contrib + Number(i.employer_contributions),
      costo: a.costo + Number(i.total_cost),
    }),
    { gross: 0, net: 0, contrib: 0, costo: 0 }
  );
  const moneda = filas[0]?.currency ?? ctx.config.monedaPrincipal;

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sueldos</h1>
        <p className="text-sm text-muted-foreground">
          Lo que cobra cada empleada y lo que le cuesta a la empresa no son el
          mismo número: la diferencia son los aportes y las contribuciones.
        </p>
      </div>

      {periodos.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          No hay liquidaciones de sueldos cargadas.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {periodos.map((p) => (
              <a key={p} href={`/${empresa}/sueldos?p=${p}`}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  p === periodo ? "border-primary bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:bg-accent"
                )}>
                {p}
              </a>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Tarjeta titulo="Neto a pagar" valor={formatMoney(tot.net, moneda, locale)}
              nota="lo que cobran las empleadas" />
            <Tarjeta titulo="Cargas sociales" valor={formatMoney(tot.contrib, moneda, locale)}
              nota="contribuciones patronales" />
            <Tarjeta titulo="Costo total" valor={formatMoney(tot.costo, moneda, locale)}
              nota="lo que sale de la empresa" destacado />
          </div>

          <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Empleada</th>
                  <th className="px-2 py-2 text-right font-medium">Bruto</th>
                  <th className="px-2 py-2 text-right font-medium">Aportes</th>
                  <th className="px-2 py-2 text-right font-medium">Neto</th>
                  <th className="px-2 py-2 text-right font-medium">Contribuciones</th>
                  <th className="px-4 py-2 text-right font-medium">Costo empresa</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((i) => (
                  <tr key={i.id} className="border-b last:border-0">
                    <td className="px-4 py-2.5 font-medium">{i.employee?.display_name ?? "—"}</td>
                    <td className="fig px-2 py-2.5 text-right">{formatMoney(Number(i.gross), i.currency, locale)}</td>
                    <td className="fig px-2 py-2.5 text-right text-muted-foreground">
                      −{formatMoney(Number(i.deductions), i.currency, locale)}
                    </td>
                    <td className="fig px-2 py-2.5 text-right font-semibold">
                      {formatMoney(Number(i.net), i.currency, locale)}
                    </td>
                    <td className="fig px-2 py-2.5 text-right text-muted-foreground">
                      +{formatMoney(Number(i.employer_contributions), i.currency, locale)}
                    </td>
                    <td className="fig px-4 py-2.5 text-right font-medium">
                      {formatMoney(Number(i.total_cost), i.currency, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Tarjeta({ titulo, valor, nota, destacado }: {
  titulo: string; valor: string; nota: string; destacado?: boolean;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 shadow-sm", destacado && "border-primary/40")}>
      <div className="text-xs text-muted-foreground">{titulo}</div>
      <div className="fig mt-1 text-2xl font-semibold">{valor}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{nota}</div>
    </div>
  );
}

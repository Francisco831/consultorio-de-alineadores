import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { currentPeriodIn } from "@/lib/dates";
import { cn } from "@/lib/utils";

type Gasto = {
  supplier_id: string; supplier_name: string; currency: string;
  month: string; total: number; movimientos: number;
};

export default async function ProveedoresPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ m?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale, monedaPrincipal } = ctx.config;

  const { data } = await supabase.from("v_supplier_spend").select("*")
    .eq("company_id", ctx.companyId).eq("currency", monedaPrincipal);
  const filas = (data ?? []) as Gasto[];

  const periodoActual = currentPeriodIn(ctx.config.timezone);
  const meses = [...new Set(filas.map((f) => f.month.slice(0, 7)))].sort().reverse();
  const mes = sp.m && meses.includes(sp.m) ? sp.m : (meses.includes(periodoActual) ? periodoActual : meses[0]);

  // acumulado del año y del mes elegido, por proveedor
  const anio = mes?.slice(0, 4) ?? String(new Date().getUTCFullYear());
  const acc = new Map<string, { nombre: string; anual: number; mes: number; movs: number; meses: Set<string> }>();
  for (const f of filas) {
    if (!f.month.startsWith(anio)) continue;
    if (!acc.has(f.supplier_id)) {
      acc.set(f.supplier_id, { nombre: f.supplier_name, anual: 0, mes: 0, movs: 0, meses: new Set() });
    }
    const a = acc.get(f.supplier_id)!;
    a.anual += Number(f.total);
    a.movs += f.movimientos;
    a.meses.add(f.month.slice(0, 7));
    if (f.month.slice(0, 7) === mes) a.mes += Number(f.total);
  }

  const ranking = [...acc.entries()]
    .map(([id, v]) => ({ id, ...v, promedio: v.anual / Math.max(v.meses.size, 1) }))
    .sort((a, b) => b.anual - a.anual);
  const totalAnual = ranking.reduce((a, r) => a + r.anual, 0);
  const top5 = ranking.slice(0, 5).reduce((a, r) => a + r.anual, 0);

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Proveedores</h1>
        <p className="text-sm text-muted-foreground">Dónde se va la plata, ordenado por cuánto.</p>
      </div>

      {ranking.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          Todavía no hay gastos con proveedor asignado.
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Tarjeta titulo={`Gasto ${anio}`} valor={formatMoney(totalAnual, monedaPrincipal, locale)}
              nota={`${ranking.length} proveedores`} />
            <Tarjeta titulo="Top 5" valor={formatMoney(top5, monedaPrincipal, locale)}
              nota={totalAnual > 0 ? `${((top5 / totalAnual) * 100).toFixed(0)}% de todo el gasto` : ""} />
            <Tarjeta titulo="El más grande" valor={ranking[0] ? formatMoney(ranking[0].anual, monedaPrincipal, locale) : "—"}
              nota={ranking[0] ? `${ranking[0].nombre} · ${((ranking[0].anual / totalAnual) * 100).toFixed(0)}% del total` : ""} />
          </div>

          {meses.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {meses.slice(0, 8).map((m) => (
                <Link key={m} href={`/${empresa}/proveedores?m=${m}`}
                  className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    m === mes ? "border-primary bg-primary text-primary-foreground"
                      : "bg-card text-muted-foreground hover:bg-accent")}>
                  {m}
                </Link>
              ))}
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Proveedor</th>
                  <th className="px-2 py-2 text-right font-medium">Gasto {mes}</th>
                  <th className="px-2 py-2 text-right font-medium">Acumulado {anio}</th>
                  <th className="px-2 py-2 text-right font-medium">% del total</th>
                  <th className="px-2 py-2 text-right font-medium">Promedio mensual</th>
                  <th className="px-4 py-2 text-right font-medium">Movimientos</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((r) => {
                  const pct = totalAnual > 0 ? (r.anual / totalAnual) * 100 : 0;
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-4 py-2.5 font-medium">
                        <Link href={`/${empresa}/proveedores/${r.id}`} className="hover:underline">
                          {r.nombre}
                        </Link>
                      </td>
                      <td className="fig px-2 py-2.5 text-right">
                        {r.mes > 0 ? formatMoney(r.mes, monedaPrincipal, locale) : "—"}
                      </td>
                      <td className="fig px-2 py-2.5 text-right font-medium">
                        {formatMoney(r.anual, monedaPrincipal, locale)}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                            <div className="h-full bg-primary" style={{ width: `${Math.min(pct, 100)}%` }} />
                          </div>
                          <span className="fig w-10 text-right text-muted-foreground">{pct.toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="fig px-2 py-2.5 text-right text-muted-foreground">
                        {formatMoney(r.promedio, monedaPrincipal, locale)}
                      </td>
                      <td className="fig px-4 py-2.5 text-right text-muted-foreground">{r.movs}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {ranking[0] && totalAnual > 0 ? (
            <p className="text-xs text-muted-foreground">
              {ranking[0].nombre} representa el {((ranking[0].anual / totalAnual) * 100).toFixed(0)}% de todo lo
              que gastás; los cinco más grandes, el {((top5 / totalAnual) * 100).toFixed(0)}%.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Tarjeta({ titulo, valor, nota }: { titulo: string; valor: string; nota: string }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="text-xs text-muted-foreground">{titulo}</div>
      <div className="fig mt-1 text-2xl font-semibold">{valor}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{nota}</div>
    </div>
  );
}

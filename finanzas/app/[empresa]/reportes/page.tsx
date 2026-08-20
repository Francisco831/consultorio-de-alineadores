import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { Download } from "lucide-react";

const REPORTES = [
  { key: "movimientos", titulo: "Movimientos", detalle: "Todo el libro: fecha, concepto, contraparte, categoría, cuenta y monto." },
  { key: "proveedores", titulo: "Gasto por proveedor", detalle: "Cuánto le pagaste a cada uno, mes por mes." },
  { key: "liquidaciones", titulo: "Liquidaciones", detalle: "Cobrado, costo KS, base, porcentaje, retiros y saldo por doctora." },
  { key: "precios", titulo: "Historial de precios", detalle: "Último, promedio, mínimo, máximo y variación por producto." },
];

export default async function ReportesPage({
  params,
}: {
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale, monedaPrincipal } = ctx.config;

  const { data: resumen } = await supabase.from("v_monthly_summary")
    .select("month, currency, income, expense, result")
    .eq("company_id", ctx.companyId).eq("currency", monedaPrincipal).order("month");

  const filas = resumen ?? [];
  const totIngresos = filas.reduce((a, r) => a + Number(r.income ?? 0), 0);
  const totEgresos = filas.reduce((a, r) => a + Number(r.expense ?? 0), 0);

  return (
    <div className="mx-auto max-w-[1000px] space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Reportes</h1>
        <p className="text-sm text-muted-foreground">
          Resultado mensual del año y descarga de los datos en CSV (abre en Excel y en Sheets).
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <h2 className="border-b px-4 py-2 text-sm font-semibold">Resultado mensual · {monedaPrincipal}</h2>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Mes</th>
              <th className="px-2 py-2 text-right font-medium">Ingresos</th>
              <th className="px-2 py-2 text-right font-medium">Egresos</th>
              <th className="px-4 py-2 text-right font-medium">Resultado</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((r) => (
              <tr key={r.month} className="border-b last:border-0">
                <td className="px-4 py-2 font-medium">{String(r.month).slice(0, 7)}</td>
                <td className="fig px-2 py-2 text-right text-emerald-600 dark:text-emerald-400">
                  {formatMoney(Number(r.income ?? 0), monedaPrincipal, locale)}
                </td>
                <td className="fig px-2 py-2 text-right text-red-600 dark:text-red-400">
                  {formatMoney(Number(r.expense ?? 0), monedaPrincipal, locale)}
                </td>
                <td className="fig px-4 py-2 text-right font-semibold">
                  {formatMoney(Number(r.result ?? 0), monedaPrincipal, locale)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t bg-muted/40 font-semibold">
              <td className="px-4 py-2">Total</td>
              <td className="fig px-2 py-2 text-right">{formatMoney(totIngresos, monedaPrincipal, locale)}</td>
              <td className="fig px-2 py-2 text-right">{formatMoney(totEgresos, monedaPrincipal, locale)}</td>
              <td className="fig px-4 py-2 text-right">{formatMoney(totIngresos - totEgresos, monedaPrincipal, locale)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {REPORTES.map((r) => (
          <a key={r.key} href={`/api/export?empresa=${empresa}&r=${r.key}`}
            className="flex items-start gap-3 rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-accent/50">
            <Download className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="block text-sm font-medium">{r.titulo}</span>
              <span className="block text-xs text-muted-foreground">{r.detalle}</span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

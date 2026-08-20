import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort } from "@/lib/dates";
import { cn } from "@/lib/utils";

export default async function ComprasPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;
  const tab = sp.t === "precios" ? "precios" : "compras";

  const [{ data: compras }, { data: precios }] = await Promise.all([
    supabase.from("purchases")
      .select("id, purchased_on, currency, total, invoice_no, settlement, supplier:counterparties(display_name), items:purchase_items(id)")
      .eq("company_id", ctx.companyId).order("purchased_on", { ascending: false }).limit(50),
    supabase.from("v_product_prices").select("*")
      .eq("company_id", ctx.companyId).order("gasto_total", { ascending: false }),
  ]);

  return (
    <div className="mx-auto max-w-[1100px] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Compras</h1>
          <p className="text-sm text-muted-foreground">Qué comprás, a quién y a qué precio.</p>
        </div>
        <Link href={`/${empresa}/compras/nueva`}
          className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
          + Nueva compra
        </Link>
      </div>

      <div className="flex gap-1.5">
        {[["compras", "Compras"], ["precios", "Historial de precios"]].map(([k, label]) => (
          <Link key={k} href={`/${empresa}/compras?t=${k}`}
            className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              tab === k ? "border-primary bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:bg-accent")}>
            {label}
          </Link>
        ))}
      </div>

      {tab === "compras" ? (
        (compras ?? []).length === 0 ? (
          <div className="space-y-2 rounded-xl border border-dashed bg-card p-8 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Todavía no cargaste compras con detalle.</p>
            <p>
              Cargar “Proveedor Dental X — $800.000” no sirve para negociar. Cargar
              “20 cajas de guantes a $12.000” sí: el sistema arma solo el historial
              de precios y te avisa cuando algo aumenta.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Fecha</th>
                  <th className="px-2 py-2 font-medium">Proveedor</th>
                  <th className="px-2 py-2 font-medium">Factura</th>
                  <th className="px-2 py-2 text-right font-medium">Ítems</th>
                  <th className="px-2 py-2 font-medium">Condición</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {(compras ?? []).map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="fig px-4 py-2.5 text-muted-foreground">{formatDateShort(c.purchased_on, locale)}</td>
                    <td className="px-2 py-2.5 font-medium">
                      {(c.supplier as { display_name?: string } | null)?.display_name ?? "—"}
                    </td>
                    <td className="px-2 py-2.5 text-muted-foreground">{c.invoice_no ?? "—"}</td>
                    <td className="fig px-2 py-2.5 text-right text-muted-foreground">
                      {(c.items as { id: string }[] | null)?.length ?? 0}
                    </td>
                    <td className="px-2 py-2.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium",
                        c.settlement === "paid"
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300")}>
                        {c.settlement === "paid" ? "Pagada" : "Cuenta corriente"}
                      </span>
                    </td>
                    <td className="fig px-4 py-2.5 text-right font-medium">
                      {formatMoney(Number(c.total), c.currency, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (precios ?? []).length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          El historial de precios se arma solo a medida que cargás compras con detalle.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Producto</th>
                <th className="px-2 py-2 text-right font-medium">Último</th>
                <th className="px-2 py-2 text-right font-medium">Promedio</th>
                <th className="px-2 py-2 text-right font-medium">Mín</th>
                <th className="px-2 py-2 text-right font-medium">Máx</th>
                <th className="px-2 py-2 text-right font-medium">Variación</th>
                <th className="px-2 py-2 text-right font-medium">Compras</th>
                <th className="px-4 py-2 text-right font-medium">Gasto total</th>
              </tr>
            </thead>
            <tbody>
              {(precios ?? []).map((p, i) => {
                const v = p.variacion_pct == null ? null : Number(p.variacion_pct);
                return (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-4 py-2.5 font-medium">{p.product_name}</td>
                    <td className="fig px-2 py-2.5 text-right">{formatMoney(Number(p.precio_ultimo), p.currency, locale, { decimals: true })}</td>
                    <td className="fig px-2 py-2.5 text-right text-muted-foreground">{formatMoney(Number(p.precio_promedio), p.currency, locale, { decimals: true })}</td>
                    <td className="fig px-2 py-2.5 text-right text-muted-foreground">{formatMoney(Number(p.precio_min), p.currency, locale, { decimals: true })}</td>
                    <td className="fig px-2 py-2.5 text-right text-muted-foreground">{formatMoney(Number(p.precio_max), p.currency, locale, { decimals: true })}</td>
                    <td className={cn("fig px-2 py-2.5 text-right font-medium",
                      v != null && v > 0 && "text-red-600 dark:text-red-400",
                      v != null && v < 0 && "text-emerald-600 dark:text-emerald-400")}>
                      {v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(0)}%`}
                    </td>
                    <td className="fig px-2 py-2.5 text-right text-muted-foreground">{p.compras}</td>
                    <td className="fig px-4 py-2.5 text-right font-medium">{formatMoney(Number(p.gasto_total), p.currency, locale)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort } from "@/lib/dates";

export default async function ProveedorPage({
  params,
}: {
  params: Promise<{ empresa: string; id: string }>;
}) {
  const { empresa, id } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale, monedaPrincipal } = ctx.config;

  const { data: prov } = await supabase.from("counterparties")
    .select("id, display_name, kind, tax_id, notes")
    .eq("id", id).eq("company_id", ctx.companyId).maybeSingle();
  if (!prov) notFound();

  const [{ data: gastos }, { data: movs }, { data: precios }] = await Promise.all([
    supabase.from("v_supplier_spend").select("month, currency, total, movimientos")
      .eq("company_id", ctx.companyId).eq("supplier_id", id).order("month"),
    supabase.from("movements")
      .select("id, occurred_on, amount, currency, description, category:categories(name)")
      .eq("company_id", ctx.companyId).eq("counterparty_id", id).eq("kind", "expense")
      .neq("status", "void").order("occurred_on", { ascending: false }).limit(15),
    supabase.from("v_product_supplier_prices")
      .select("product_name, currency, compras, precio_ultimo, precio_promedio, ultima_compra, gasto_total")
      .eq("company_id", ctx.companyId).eq("supplier_id", id).order("gasto_total", { ascending: false }),
  ]);

  const porMes = (gastos ?? []).filter((g) => g.currency === monedaPrincipal);
  const total = porMes.reduce((a, g) => a + Number(g.total), 0);
  const max = Math.max(...porMes.map((g) => Number(g.total)), 1);
  const ultimo = (movs ?? [])[0];

  return (
    <div className="mx-auto max-w-[1000px] space-y-5">
      <div>
        <Link href={`/${empresa}/proveedores`} className="text-xs text-primary hover:underline">
          ← Proveedores
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{prov.display_name}</h1>
        <p className="text-sm text-muted-foreground">
          {formatMoney(total, monedaPrincipal, locale)} en {porMes.length} mes(es)
          {ultimo ? ` · último pago ${formatDateShort(ultimo.occurred_on, locale)}` : ""}
        </p>
      </div>

      {porMes.length > 0 ? (
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Evolución mensual
          </h2>
          <div className="flex items-end gap-2" style={{ height: 120 }}>
            {porMes.map((g) => (
              <div key={g.month} className="flex flex-1 flex-col items-center gap-1">
                <div className="fig text-[10px] text-muted-foreground">
                  {(Number(g.total) / 1000).toFixed(0)}k
                </div>
                <div className="w-full rounded-t bg-primary/80"
                  style={{ height: `${(Number(g.total) / max) * 90}px`, minHeight: 2 }} />
                <div className="text-[10px] text-muted-foreground">{g.month.slice(5, 7)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {(precios ?? []).length > 0 ? (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <h2 className="border-b px-4 py-2 text-sm font-semibold">Productos que le compramos</h2>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Producto</th>
                <th className="px-2 py-2 text-right font-medium">Último precio</th>
                <th className="px-2 py-2 text-right font-medium">Promedio</th>
                <th className="px-2 py-2 text-right font-medium">Compras</th>
                <th className="px-4 py-2 text-right font-medium">Gasto total</th>
              </tr>
            </thead>
            <tbody>
              {(precios ?? []).map((p, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{p.product_name}</td>
                  <td className="fig px-2 py-2 text-right">{formatMoney(Number(p.precio_ultimo), p.currency, locale, { decimals: true })}</td>
                  <td className="fig px-2 py-2 text-right text-muted-foreground">{formatMoney(Number(p.precio_promedio), p.currency, locale, { decimals: true })}</td>
                  <td className="fig px-2 py-2 text-right text-muted-foreground">{p.compras}</td>
                  <td className="fig px-4 py-2 text-right font-medium">{formatMoney(Number(p.gasto_total), p.currency, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <h2 className="border-b px-4 py-2 text-sm font-semibold">Últimos pagos</h2>
        <table className="w-full text-[13px]">
          <tbody>
            {(movs ?? []).length === 0 ? (
              <tr><td className="px-4 py-6 text-center text-muted-foreground">Sin pagos registrados.</td></tr>
            ) : (movs ?? []).map((m) => (
              <tr key={m.id} className="border-b last:border-0">
                <td className="fig w-20 px-4 py-2 text-muted-foreground">{formatDateShort(m.occurred_on, locale)}</td>
                <td className="px-2 py-2">{m.description ?? "—"}</td>
                <td className="px-2 py-2 text-muted-foreground">
                  {(m.category as { name?: string } | null)?.name ?? "—"}
                </td>
                <td className="fig px-4 py-2 text-right font-medium">
                  {formatMoney(Number(m.amount), m.currency, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

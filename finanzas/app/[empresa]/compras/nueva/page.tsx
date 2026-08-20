import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { todayIn } from "@/lib/dates";
import { NuevaCompra } from "@/components/compras/nueva-compra";

export default async function NuevaCompraPage({
  params,
}: {
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const [{ data: cuentas }, { data: categorias }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency")
      .eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    supabase.from("categories").select("id, name")
      .eq("company_id", ctx.companyId).eq("flow", "expense").eq("is_active", true).order("name"),
  ]);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Nueva compra</h1>
        <p className="text-sm text-muted-foreground">
          Cargá qué compraste, no solo cuánto gastaste: es lo que después deja ver
          qué producto aumentó y qué proveedor conviene.
        </p>
      </div>
      <NuevaCompra empresa={ctx.config.slug} cuentas={cuentas ?? []}
        categorias={categorias ?? []} monedas={ctx.config.monedas}
        hoy={todayIn(ctx.config.timezone)} />
    </div>
  );
}

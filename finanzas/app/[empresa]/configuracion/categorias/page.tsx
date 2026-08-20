import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { CategoriaNueva, CategoriaToggle } from "@/components/config/categoria-controles";

export default async function CategoriasPage({
  params,
}: {
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { data: categorias } = await supabase
    .from("categories")
    .select("id, name, flow, cost_behavior, cost_center, is_system, is_active")
    .eq("company_id", ctx.companyId)
    .order("flow")
    .order("name");

  const grupos: Array<{ flow: string; titulo: string }> = [
    { flow: "income", titulo: "Ingresos" },
    { flow: "expense", titulo: "Egresos" },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Categorías</h1>
          <p className="text-sm text-muted-foreground">
            <Link href={`/${empresa}/configuracion`} className="text-primary hover:underline">
              ← volver a cuentas
            </Link>
          </p>
        </div>
        <CategoriaNueva empresa={ctx.config.slug} />
      </div>

      {grupos.map((g) => (
        <section key={g.flow}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {g.titulo}
          </h2>
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <tbody>
                {(categorias ?? [])
                  .filter((c) => c.flow === g.flow)
                  .map((c) => (
                    <tr key={c.id} className={`border-b last:border-0 ${!c.is_active ? "opacity-50" : ""}`}>
                      <td className="px-4 py-2 font-medium">
                        {c.name}
                        {c.is_system ? (
                          <span className="ml-2 text-[10px] uppercase text-muted-foreground">sistema</span>
                        ) : null}
                        {c.cost_center === "produccion_mx" ? (
                          <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                            producción
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {c.cost_behavior === "fixed" ? "Fijo" : c.cost_behavior === "variable" ? "Variable" : "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <CategoriaToggle
                          empresa={ctx.config.slug}
                          id={c.id}
                          activa={c.is_active}
                          esSistema={c.is_system}
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

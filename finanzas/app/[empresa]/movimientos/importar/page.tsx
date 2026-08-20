import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { ImportWizard } from "@/components/movimientos/import-wizard";

export default async function ImportarPage({
  params,
}: {
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { data: cuentas } = await supabase
    .from("accounts")
    .select("id, name, currency")
    .eq("company_id", ctx.companyId)
    .eq("is_active", true)
    .order("name");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Importar extracto</h1>
      <p className="text-sm text-muted-foreground">
        Las líneas del extracto no crean movimientos solas: primero se importan,
        después el matcher propone con qué movimiento cierra cada una. Re-subir el
        mismo archivo no duplica nada.
      </p>
      <ImportWizard empresa={ctx.config.slug} cuentas={cuentas ?? []} />
    </div>
  );
}

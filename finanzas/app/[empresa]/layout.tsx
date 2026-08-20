import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { todayIn } from "@/lib/dates";

export default async function EmpresaLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  const [{ data: cuentas }, { data: categorias }] = await Promise.all([
    supabase
      .from("accounts")
      .select("id, name, currency")
      .eq("company_id", ctx.companyId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("categories")
      .select("id, name, flow")
      .eq("company_id", ctx.companyId)
      .eq("is_active", true)
      .order("name"),
  ]);

  return (
    <div data-empresa={ctx.config.slug} className="flex h-screen overflow-hidden">
      <AppSidebar empresa={ctx.config.slug} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader
          empresa={ctx.config.slug}
          cuentas={cuentas ?? []}
          categorias={categorias ?? []}
          hoy={todayIn(ctx.config.timezone)}
        />
        <main className="flex-1 overflow-y-auto bg-muted/30 p-6">{children}</main>
      </div>
    </div>
  );
}

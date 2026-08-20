// Resolución del contexto de empresa en el server, una vez por request.
// La empresa activa ES el segmento de URL: visible, compartible y auditable.
// Nada de "empresa activa" en estado global.

import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EMPRESAS, esEmpresaSlug, type EmpresaConfig } from "@/lib/empresas";

export type EmpresaContext = {
  config: EmpresaConfig;
  companyId: string;
  role: string;
  userId: string;
};

export const requireEmpresa = cache(async (slug: string): Promise<EmpresaContext> => {
  if (!esEmpresaSlug(slug)) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: company } = await supabase
    .from("companies")
    .select("id, slug")
    .eq("slug", slug)
    .maybeSingle();
  if (!company) notFound(); // la base no tiene la empresa (¿seed-base sin correr?)

  const { data: membership } = await supabase
    .from("memberships")
    .select("role")
    .eq("company_id", company.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) notFound(); // sin membresía no existe: ni un 403 que confirme que hay algo

  return {
    config: EMPRESAS[slug],
    companyId: company.id,
    role: membership.role,
    userId: user.id,
  };
});

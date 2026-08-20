import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { EMPRESAS } from "@/lib/empresas";

export default async function ElegirEmpresa() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-2xl space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">¿Qué empresa?</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cada empresa es un mundo separado. Nada se mezcla, nada se consolida.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/mx/hoy"
            className="group rounded-2xl border bg-card p-8 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <div className="h-2 w-10 rounded-full bg-[#001d57]" />
            <div className="mt-4 text-lg font-semibold">{EMPRESAS.mx.nombre}</div>
            <div className="mt-1 text-xs uppercase tracking-widest text-muted-foreground">
              MXN · México
            </div>
          </Link>
          <Link
            href="/ar/hoy"
            className="group rounded-2xl border bg-card p-8 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <div className="h-2 w-10 rounded-full bg-[#0e3b2e]" />
            <div className="mt-4 text-lg font-semibold">{EMPRESAS.ar.nombre}</div>
            <div className="mt-1 text-xs uppercase tracking-widest text-muted-foreground">
              ARS + USD · Argentina
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}

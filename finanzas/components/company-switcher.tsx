"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EMPRESAS, COOKIE_EMPRESA, type EmpresaSlug } from "@/lib/empresas";

export function CompanySwitcher({ actual }: { actual: EmpresaSlug }) {
  const pathname = usePathname();
  const router = useRouter();
  const config = EMPRESAS[actual];

  // recordar la última empresa para el redirect de "/"
  useEffect(() => {
    document.cookie = `${COOKIE_EMPRESA}=${actual}; path=/; max-age=31536000; samesite=lax`;
  }, [actual]);

  function cambiar(destino: EmpresaSlug) {
    if (destino === actual) return;
    // mismo path en la otra empresa; el layout de destino valida que exista
    const rest = pathname.replace(/^\/(mx|ar)/, "");
    router.push(`/${destino}${rest || "/hoy"}`);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center justify-between gap-2 border-b border-sidebar-border px-4 py-3 text-left transition-colors hover:bg-sidebar-accent/50">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-white">
            {config.nombre}
          </div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-sidebar-primary">
            {config.monedas.join(" + ")} · {config.pais}
          </div>
        </div>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-sidebar-foreground/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {(Object.keys(EMPRESAS) as EmpresaSlug[]).map((slug) => (
          <DropdownMenuItem
            key={slug}
            onClick={() => cambiar(slug)}
            className="flex items-center gap-2"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: slug === "mx" ? "#001d57" : "#0e3b2e" }}
            />
            <span className={slug === actual ? "font-semibold" : ""}>
              {EMPRESAS[slug].nombre}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

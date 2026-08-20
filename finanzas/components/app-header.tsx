import { signOut } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { NuevoMenu, type CuentaOpt, type CategoriaOpt } from "@/components/movimientos/nuevo-menu";
import type { EmpresaSlug } from "@/lib/empresas";
import { LogOut } from "lucide-react";
import { CommandPalette } from "@/components/command-palette";
import { BotonBuscar } from "@/components/boton-buscar";

export function AppHeader({
  empresa, cuentas, categorias, hoy,
}: {
  empresa: EmpresaSlug;
  cuentas: CuentaOpt[];
  categorias: CategoriaOpt[];
  hoy: string;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-end gap-2 border-b bg-background px-4">
      <CommandPalette empresa={empresa} />
      <BotonBuscar />
      <NuevoMenu empresa={empresa} cuentas={cuentas} categorias={categorias} hoy={hoy} />
      <ThemeToggle />
      <form action={signOut}>
        <Button variant="ghost" size="icon" className="h-8 w-8" title="Salir" type="submit">
          <LogOut className="h-4 w-4" />
        </Button>
      </form>
    </header>
  );
}

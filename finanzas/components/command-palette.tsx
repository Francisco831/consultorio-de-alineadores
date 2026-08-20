"use client";

// ⌘K: ir a cualquier pantalla, crear algo o buscar en toda la empresa.
// La búsqueda corre en el server (server action), así la RLS decide qué se ve.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList,
} from "@/components/ui/command";
import { buscarGlobal, type Resultado } from "@/lib/actions/buscar";
import { EMPRESAS, type EmpresaSlug } from "@/lib/empresas";

const PAGINAS: Array<{ href: string; label: string }> = [
  { href: "/hoy", label: "Hoy" },
  { href: "/movimientos", label: "Movimientos" },
  { href: "/movimientos/importar", label: "Importar extracto" },
  { href: "/movimientos/conciliar", label: "Conciliación" },
  { href: "/pagar", label: "Por pagar" },
  { href: "/cobrar", label: "Por cobrar" },
  { href: "/impuestos", label: "Impuestos" },
  { href: "/sueldos", label: "Sueldos" },
  { href: "/liquidaciones", label: "Liquidaciones" },
  { href: "/cashflow", label: "Cash Flow" },
  { href: "/costos", label: "Costos" },
  { href: "/presupuesto", label: "Presupuesto" },
  { href: "/calendario", label: "Calendario" },
  { href: "/reportes", label: "Reportes" },
  { href: "/compras", label: "Compras" },
  { href: "/compras/nueva", label: "Nueva compra" },
  { href: "/proveedores", label: "Proveedores" },
  { href: "/configuracion", label: "Configuración" },
];

const TIPO_LABEL: Record<Resultado["tipo"], string> = {
  contraparte: "Contacto", movimiento: "Movimiento",
  producto: "Producto", deuda: "Por pagar",
};

export function CommandPalette({ empresa }: { empresa: EmpresaSlug }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // el botón del header dispara este mismo evento: una sola fuente de apertura
  useEffect(() => {
    const abrir = () => setOpen(true);
    document.addEventListener("abrir-buscador", abrir);
    return () => document.removeEventListener("abrir-buscador", abrir);
  }, []);
  const [q, setQ] = useState("");
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => {
      startTransition(async () => setResultados(await buscarGlobal(empresa, q)));
    }, 180);
    return () => clearTimeout(t);
  }, [q, empresa]);

  // con menos de 2 letras no se muestra nada: se DERIVA del query en vez de
  // limpiar el estado dentro del efecto (eso dispara renders en cascada)
  const visibles = q.trim().length >= 2 ? resultados : [];

  function ir(href: string) {
    setOpen(false);
    setQ("");
    router.push(href);
  }

  const otra: EmpresaSlug = empresa === "mx" ? "ar" : "mx";

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Buscar un proveedor, un concepto, un monto…"
        value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>Sin resultados.</CommandEmpty>
        {visibles.length > 0 ? (
          <CommandGroup heading="Resultados">
            {visibles.map((r, i) => (
              <CommandItem key={`${r.href}-${i}`} value={`${r.titulo}-${i}`} onSelect={() => ir(r.href)}>
                <span className="font-medium">{r.titulo}</span>
                <span className="ml-2 text-xs text-muted-foreground">{r.detalle}</span>
                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                  {TIPO_LABEL[r.tipo]}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Ir a">
          {PAGINAS.map((p) => (
            <CommandItem key={p.href} value={p.label} onSelect={() => ir(`/${empresa}${p.href}`)}>
              {p.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Empresa">
          <CommandItem value={`cambiar a ${EMPRESAS[otra].nombre}`} onSelect={() => ir(`/${otra}/hoy`)}>
            Cambiar a {EMPRESAS[otra].nombre}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

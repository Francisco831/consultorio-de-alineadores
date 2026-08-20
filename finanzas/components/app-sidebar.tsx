"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sun,
  ArrowLeftRight,
  Landmark,
  Settings,
  CreditCard,
  HandCoins,
  Receipt,
  Users,
  Percent,
  ShoppingCart,
  Truck,
  TrendingUp,
  Calculator,
  CalendarDays,
  Target,
  FileBarChart,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CompanySwitcher } from "@/components/company-switcher";
import { EMPRESAS, type EmpresaSlug } from "@/lib/empresas";

// Los GRUPOS existen desde el día 1 y no se reordenan nunca; los ítems se
// agregan a su grupo a medida que los módulos salen (Etapas 2-3):
// DIARIO (Movimientos · Ingresos · Gastos · Compras)
// COMPROMISOS (Por pagar · Por cobrar · Sueldos · Impuestos · Calendario)
// ANÁLISIS (Cash Flow · Presupuesto · Costos* · Reportes)
// DIRECTORIO (Proveedores · Clientes)
function nav(base: string, labelCostos: string): { href: string; label: string; icon: LucideIcon; grupo?: string }[] {
  return [
    { href: `${base}/hoy`, label: "Hoy", icon: Sun },
    { href: `${base}/movimientos`, label: "Movimientos", icon: ArrowLeftRight, grupo: "Diario" },
    { href: `${base}/movimientos/conciliar`, label: "Conciliación", icon: Landmark, grupo: "Diario" },
    { href: `${base}/pagar`, label: "Por pagar", icon: CreditCard, grupo: "Compromisos" },
    { href: `${base}/cobrar`, label: "Por cobrar", icon: HandCoins, grupo: "Compromisos" },
    { href: `${base}/impuestos`, label: "Impuestos", icon: Receipt, grupo: "Compromisos" },
    { href: `${base}/sueldos`, label: "Sueldos", icon: Users, grupo: "Compromisos" },
    { href: `${base}/liquidaciones`, label: "Liquidaciones", icon: Percent, grupo: "Compromisos" },
    { href: `${base}/cashflow`, label: "Cash Flow", icon: TrendingUp, grupo: "Análisis" },
    { href: `${base}/costos`, label: labelCostos, icon: Calculator, grupo: "Análisis" },
    { href: `${base}/presupuesto`, label: "Presupuesto", icon: Target, grupo: "Análisis" },
    { href: `${base}/calendario`, label: "Calendario", icon: CalendarDays, grupo: "Análisis" },
    { href: `${base}/reportes`, label: "Reportes", icon: FileBarChart, grupo: "Análisis" },
    { href: `${base}/compras`, label: "Compras", icon: ShoppingCart, grupo: "Directorio" },
    { href: `${base}/proveedores`, label: "Proveedores", icon: Truck, grupo: "Directorio" },
    { href: `${base}/configuracion`, label: "Configuración", icon: Settings, grupo: "Sistema" },
  ];
}

export function AppSidebar({ empresa }: { empresa: EmpresaSlug }) {
  const pathname = usePathname();
  const items = nav(`/${empresa}`, EMPRESAS[empresa].labelCostos);
  return (
    <aside className="flex h-screen w-52 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <CompanySwitcher actual={empresa} />
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {items.map(({ href, label, icon: Icon, grupo }, i) => {
          // comparación EXACTA (lección del CRM: startsWith prende dos a la vez)
          const active = pathname === href;
          const abreGrupo = grupo && grupo !== items[i - 1]?.grupo;
          return (
            <div key={href}>
              {abreGrupo ? (
                <div className="px-2.5 pb-1 pt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/45">
                  {grupo}
                </div>
              ) : null}
              <Link
                href={href}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white"
                )}
              >
                {active ? (
                  <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-sidebar-primary" />
                ) : null}
                <Icon className={cn("h-4 w-4", active && "text-sidebar-primary")} strokeWidth={1.75} />
                {label}
              </Link>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-sidebar-border px-4 py-3 text-[10px] font-medium text-sidebar-foreground/60">
        Finanzas · nada se consolida
      </div>
    </aside>
  );
}

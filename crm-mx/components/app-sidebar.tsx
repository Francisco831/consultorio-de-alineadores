"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sun,
  LayoutDashboard,
  Stethoscope,
  UserPlus,
  KanbanSquare,
  FolderOpen,
  CheckSquare,
  BarChart3,
  Users,
  ShieldCheck,
  Settings,
  ListChecks,
  CalendarDays,
  BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

// El CRM son DOS ÁREAS, y hasta acá existían solo como estos comentarios: el menú
// era una lista plana de 11 items donde "Prospección" y "Doctores" se veían igual.
// El corte es doctors.is_accredited (supabase/migrations/0015_two_universes.sql:12).
//
// El vocabulario es fijo y siempre en este orden —"Por acreditarse", "Acreditados"—
// y es el mismo par de títulos en las secciones de /tareas, en los bloques de /hoy y
// en los resultados del buscador. Una sola distinción para aprender.
const NAV: { href: string; label: string; icon: typeof Sun; grupo?: string }[] =
  [
    { href: "/hoy", label: "Hoy", icon: Sun },
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },

    {
      href: "/prospeccion",
      label: "Pipeline",
      icon: UserPlus,
      grupo: "Por acreditarse",
    },
    {
      href: "/prospeccion/lista",
      label: "Lista",
      icon: ListChecks,
      grupo: "Por acreditarse",
    },

    {
      href: "/doctores",
      label: "Doctores",
      icon: Stethoscope,
      grupo: "Acreditados",
    },
    {
      href: "/pipeline",
      label: "Oportunidades",
      icon: KanbanSquare,
      grupo: "Acreditados",
    },
    { href: "/casos", label: "Casos", icon: FolderOpen, grupo: "Acreditados" },

    { href: "/tareas", label: "Tareas", icon: CheckSquare },
    { href: "/eventos", label: "Eventos", icon: CalendarDays },
    { href: "/herramientas", label: "Herramientas", icon: BookOpen },
    { href: "/reportes", label: "Reportes", icon: BarChart3 },
    { href: "/equipo", label: "Equipo", icon: Users },
    // qué sabe y qué no sabe la capa AI + las colas de clasificación humana
    { href: "/calidad", label: "Calidad", icon: ShieldCheck },
    { href: "/ajustes", label: "Ajustes", icon: Settings },
  ];

export function AppSidebar() {
  const pathname = usePathname();
  return (
    <aside className="flex h-screen w-52 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex h-14 flex-col justify-center gap-1 border-b border-sidebar-border px-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- logo estático local */}
        <img
          src="/KS-logo-white.png"
          alt="KeepSmiling"
          className="h-5 w-auto self-start"
        />
        <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-sidebar-primary">
          CRM México
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV.map(({ href, label, icon: Icon, grupo }, i) => {
          // Comparación EXACTA, no startsWith: con las rutas anidadas de las dos
          // áreas ("/prospeccion" y "/prospeccion/lista"), startsWith prendía los
          // dos items a la vez.
          const active = pathname === href;
          const abreGrupo = grupo && grupo !== NAV[i - 1]?.grupo;
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
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white",
                )}
              >
                {active ? (
                  <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-sidebar-primary" />
                ) : null}
                <Icon
                  className={cn("h-4 w-4", active && "text-sidebar-primary")}
                  strokeWidth={1.75}
                />
                {label}
              </Link>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-sidebar-border px-4 py-3 text-[10px] font-medium text-sidebar-foreground/60">
        Commercial OS · KeepSmiling
      </div>
    </aside>
  );
}

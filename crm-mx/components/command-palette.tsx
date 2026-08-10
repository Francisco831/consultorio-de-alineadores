"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { searchAll, type SearchResult } from "@/lib/actions/search";
import {
  Sun,
  LayoutDashboard,
  Stethoscope,
  KanbanSquare,
  FolderOpen,
  CheckSquare,
  BarChart3,
  Users,
  Settings,
  Search,
  Target,
} from "lucide-react";

const PAGES = [
  { href: "/hoy", label: "Hoy", icon: Sun },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/doctores", label: "Doctores", icon: Stethoscope },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/casos", label: "Casos", icon: FolderOpen },
  { href: "/tareas", label: "Tareas", icon: CheckSquare },
  { href: "/reportes", label: "Reportes", icon: BarChart3 },
  { href: "/equipo", label: "Equipo", icon: Users },
  { href: "/ajustes", label: "Ajustes", icon: Settings },
];

const KIND_ICON = {
  doctor: Stethoscope,
  caso: FolderOpen,
  oportunidad: Target,
} as const;

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    if (value.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        const r = await searchAll(value);
        setResults(r);
      } finally {
        setSearching(false);
      }
    }, 250);
  }, []);

  function go(href: string) {
    setOpen(false);
    setQuery("");
    setResults([]);
    router.push(href);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Buscar"
      description="Buscar doctores, casos y oportunidades"
    >
      <Command shouldFilter={query.trim().length < 2}>
      <CommandInput
        placeholder="Buscar doctor, paciente, caso… (Cmd+K)"
        value={query}
        onValueChange={onQueryChange}
      />
      <CommandList>
        <CommandEmpty>
          {searching ? "Buscando…" : "Sin resultados."}
        </CommandEmpty>
        {results.length > 0 ? (
          <CommandGroup heading="Resultados">
            {results.map((r) => {
              const Icon = KIND_ICON[r.kind];
              return (
                <CommandItem
                  key={`${r.kind}-${r.id}`}
                  value={`${r.title} ${r.subtitle ?? ""} ${r.id}`}
                  onSelect={() => go(r.href)}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  <span>{r.title}</span>
                  {r.subtitle ? (
                    <span className="ml-2 text-muted-foreground">
                      {r.subtitle}
                    </span>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {results.length > 0 ? <CommandSeparator /> : null}
        <CommandGroup heading="Ir a">
          {PAGES.map((p) => (
            <CommandItem key={p.href} value={p.label} onSelect={() => go(p.href)}>
              <p.icon className="mr-2 h-4 w-4" />
              {p.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}

export function SearchButton() {
  return (
    <button
      className="flex h-8 w-56 items-center gap-2 rounded-lg border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
      onClick={() =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true })
        )
      }
    >
      <Search className="h-3.5 w-3.5" />
      Buscar…
      <kbd className="ml-auto rounded border bg-muted px-1 text-[10px]">⌘K</kbd>
    </button>
  );
}

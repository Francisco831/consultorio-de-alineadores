"use client";

import { Search } from "lucide-react";

/** Recordatorio visible del ⌘K, para el que no sabe que existe el atajo. */
export function BotonBuscar() {
  return (
    <button
      type="button"
      onClick={() => document.dispatchEvent(new CustomEvent("abrir-buscador"))}
      className="mr-auto hidden items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent sm:flex"
    >
      <Search className="h-3.5 w-3.5" />
      Buscar…
      <kbd className="rounded bg-muted px-1 font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}

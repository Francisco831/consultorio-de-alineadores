"use client";

// Filtro por etiqueta de las listas de doctores (/doctores y /prospeccion/lista).
// Un <select> con las etiquetas en uso y cuántos doctores tiene cada una
// (tags_en_uso(), migración 0061). Cambiarlo navega: la etiqueta viaja en la
// URL (?tag=…) como el resto de los filtros, así la lista se comparte por link.

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Tag } from "lucide-react";
import { etiquetaLegible } from "@/lib/etiquetas";

const selectClass =
  "h-8 max-w-64 rounded-lg border border-input bg-transparent px-2 text-[13px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60";

export function FiltroEtiqueta({
  base,
  params,
  actual,
  etiquetas,
}: {
  /** "/doctores" o "/prospeccion/lista" */
  base: string;
  /** los demás filtros vigentes, para que sigan puestos al cambiar la etiqueta */
  params: Record<string, string>;
  actual: string;
  etiquetas: { tag: string; n: number }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function ir(tag: string) {
    const p = new URLSearchParams(params);
    if (tag) p.set("tag", tag);
    else p.delete("tag");
    p.delete("p"); // otra lista, primera página
    const qs = p.toString();
    startTransition(() => router.push(qs ? `${base}?${qs}` : base));
  }

  // una etiqueta tipeada en la URL que no está en la lista (o que quedó sin
  // doctores) igual se muestra elegida, para que se entienda qué filtró
  const conocida = !actual || etiquetas.some((e) => e.tag === actual);

  return (
    <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <Tag className="h-3.5 w-3.5" />
      <select
        value={actual}
        onChange={(e) => ir(e.target.value)}
        disabled={pending}
        aria-label="Filtrar por etiqueta"
        className={selectClass}
      >
        <option value="">Etiqueta: todas</option>
        {!conocida ? <option value={actual}>{actual} (0)</option> : null}
        {etiquetas.map((e) => (
          <option key={e.tag} value={e.tag}>
            {etiquetaLegible(e.tag)} ({e.n})
          </option>
        ))}
      </select>
    </label>
  );
}

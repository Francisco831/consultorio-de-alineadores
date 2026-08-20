"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CampoSelect } from "@/components/ui/campo-select";
import {
  sugerirMatches, confirmarSugerencia, crearDesdeLinea, marcarLinea,
} from "@/lib/actions/importar";
import type { EmpresaSlug } from "@/lib/empresas";

export function SugerirBoton({ empresa }: { empresa: EmpresaSlug }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await sugerirMatches(empresa);
          if ("error" in res && res.error) toast.error(String(res.error));
          else {
            const r = res as { sugeridas: number; sinMatch: number };
            toast.success(`${r.sugeridas} sugerencias · ${r.sinMatch} sin candidato`);
          }
        })
      }
    >
      {pending ? "Buscando…" : "Buscar coincidencias"}
    </Button>
  );
}

export function ConciliarAcciones({
  empresa, lineaId, estado, tieneSugerencia, categorias,
}: {
  empresa: EmpresaSlug;
  lineaId: string;
  estado: string;
  tieneSugerencia: boolean;
  categorias: Array<{ id: string; name: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [categoria, setCategoria] = useState<string>("");

  if (estado === "matched") return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {tieneSugerencia ? (
        <Button
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await confirmarSugerencia(empresa, lineaId);
              if (res?.error) toast.error(res.error);
              else toast.success("Conciliado");
            })
          }
        >
          ✓ Confirmar
        </Button>
      ) : (
        <>
          <CampoSelect value={categoria} onValueChange={setCategoria}
            className="h-7 w-36 text-xs" placeholder="Categoría…"
            opciones={categorias.map((c) => ({ value: c.id, label: c.name }))} />
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res = await crearDesdeLinea(empresa, lineaId, categoria || null);
                if (res?.error) toast.error(res.error);
                else toast.success("Movimiento creado desde el extracto");
              })
            }
          >
            + Crear movimiento
          </Button>
        </>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-muted-foreground"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await marcarLinea(empresa, lineaId, "duplicate");
            if (res?.error) toast.error(res.error);
          })
        }
      >
        Duplicado
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-muted-foreground"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await marcarLinea(empresa, lineaId, "ignored");
            if (res?.error) toast.error(res.error);
          })
        }
      >
        Ignorar
      </Button>
    </div>
  );
}

"use client";

// Cargar la lista de aranceles nueva cuando llega el mail de KS.
//
// El formulario arranca con los precios de la última vigencia, porque así llega
// el arancel: la misma grilla con otros números. Y la estructura de la grilla
// sale de esa lista, no de una constante — si mañana KS agrega un tipo de
// tratamiento, aparece solo.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { guardarVigenciaPrecios } from "@/lib/actions/precios";
import { parseMoneyInput } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";

export type PrecioFila = {
  audience: string; scope: string; arcades: number;
  listPrice: number; discountPct: number;
};

const ETIQUETA_SCOPE: Record<string, string> = {
  full: "Full", medium: "Medium", fast: "Fast",
};
const ETIQUETA_AUDIENCE: Record<string, string> = {
  adultos: "Adultos", teens: "Teens", kids: "Kids",
};

export function VigenciaPrecios({
  empresa, base, validFrom, esNueva,
}: {
  empresa: EmpresaSlug;
  /** Los precios que se muestran al abrir: la vigencia a copiar o a corregir. */
  base: PrecioFila[];
  validFrom: string;
  esNueva: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [desde, setDesde] = useState(validFrom);
  const [dto, setDto] = useState(String(base[0]?.discountPct ?? 40));
  const [precios, setPrecios] = useState<Record<string, string>>(
    Object.fromEntries(base.map((p) => [`${p.audience}/${p.scope}/${p.arcades}`, String(p.listPrice)]))
  );

  const audiences = [...new Set(base.map((p) => p.audience))];
  const columnas = [...new Set(base.map((p) => `${p.scope}/${p.arcades}`))];

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const filas = Object.entries(precios)
      .map(([clave, valor]) => {
        const [audience, scope, arcades] = clave.split("/");
        return { audience, scope, arcades: Number(arcades), listPrice: parseMoneyInput(valor) ?? 0 };
      })
      .filter((f) => f.listPrice > 0);
    if (filas.length !== base.length) {
      toast.error("Faltan precios: la lista tiene que quedar completa");
      return;
    }
    startTransition(async () => {
      const res = await guardarVigenciaPrecios({
        empresa, validFrom: desde, discountPct: Number(dto) || 0, precios: filas,
      });
      if (res?.error) { toast.error(res.error); return; }
      setOpen(false);
      toast.success(res?.mensaje ?? "Lista guardada");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={esNueva
        ? "inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
        : "text-xs font-medium text-primary hover:underline"}>
        {esNueva ? "+ Nueva vigencia" : "Editar"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{esNueva ? "Nueva lista de precios KS" : `Lista vigente desde ${validFrom}`}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="desde">Vigente desde</Label>
              <Input id="desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dto">Descuento del consultorio %</Label>
              <Input id="dto" inputMode="decimal" value={dto} onChange={(e) => setDto(e.target.value)} />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-2 font-medium"></th>
                  {columnas.map((c) => {
                    const [scope, arcades] = c.split("/");
                    return (
                      <th key={c} className="py-1.5 pr-2 text-right font-medium">
                        {ETIQUETA_SCOPE[scope] ?? scope} {arcades}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {audiences.map((a) => (
                  <tr key={a} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-medium">{ETIQUETA_AUDIENCE[a] ?? a}</td>
                    {columnas.map((c) => {
                      const clave = `${a}/${c}`;
                      return (
                        <td key={c} className="py-1 pr-2">
                          <Input
                            inputMode="decimal" className="h-8 text-right"
                            value={precios[clave] ?? ""}
                            onChange={(e) => setPrecios((p) => ({ ...p, [clave]: e.target.value }))}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Precios de lista, sin el descuento. Cada caso paga la lista vigente
            cuando ENTRÓ, así que las listas viejas no se tocan: se agrega una
            nueva. Al guardar se recalculan las liquidaciones abiertas.
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Guardando…" : "Guardar y recalcular"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

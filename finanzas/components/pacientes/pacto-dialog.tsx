"use client";

// Cargar o corregir el pacto de un paciente sin pasar por el código.
//
// Lo que se toca acá decide cuánto costo KS se le descuenta a la doctora en
// cada cobro, así que el diálogo dice qué va a pasar al guardar (se recalcula
// lo que esté abierto; lo cerrado no se toca) en vez de hacerlo callado.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CampoSelect } from "@/components/ui/campo-select";
import { guardarPacto } from "@/lib/actions/pactos";
import { parseMoneyInput } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { EmpresaSlug } from "@/lib/empresas";

export type Pacto = {
  total: number | null;
  currency: string;
  cuotas: number | null;
  descuentoPct: number | null;
  etapaAdicional: boolean;
  precioListaEtapa: number | null;
  alias: string[];
};

export function PactoDialog({
  empresa, patientId, paciente, pacto, faltante,
}: {
  empresa: EmpresaSlug;
  patientId: string;
  paciente: string;
  pacto: Pacto | null;
  /** true = tiene cobros de alineadores y ningún pacto: es plata mal liquidada. */
  faltante: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [total, setTotal] = useState(pacto?.total ? String(pacto.total) : "");
  const [currency, setCurrency] = useState(pacto?.currency ?? "ARS");
  const [cuotas, setCuotas] = useState(pacto?.cuotas ? String(pacto.cuotas) : "");
  const [dto, setDto] = useState(pacto?.descuentoPct ? String(pacto.descuentoPct) : "");
  const [etapa, setEtapa] = useState(pacto?.etapaAdicional ?? false);
  const [precioEtapa, setPrecioEtapa] = useState(
    pacto?.precioListaEtapa ? String(pacto.precioListaEtapa) : ""
  );
  const [alias, setAlias] = useState((pacto?.alias ?? []).join(", "));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await guardarPacto({
        empresa, patientId,
        total: parseMoneyInput(total) || null,
        currency: currency as "ARS" | "USD",
        cuotas: cuotas ? Number(cuotas) : null,
        descuentoPct: dto ? Number(dto) : null,
        etapaAdicional: etapa,
        precioListaEtapa: parseMoneyInput(precioEtapa) || null,
        alias: alias.split(",").map((a) => a.trim()).filter((a) => a.length > 1),
      });
      if (res?.error) { toast.error(res.error); return; }
      setOpen(false);
      toast.success(res?.mensaje ?? "Pacto guardado");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className={cn(
          "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-accent",
          faltante && "border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
        )}
        title="Precio pactado, cuotas y descuento de este paciente"
      >
        {faltante ? "Falta el pacto" : pacto?.total ? "Editar" : "Cargar"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Pacto de {paciente}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="total">Precio total acordado</Label>
              <Input id="total" inputMode="decimal" value={total} placeholder="0"
                onChange={(e) => setTotal(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Moneda</Label>
              <CampoSelect value={currency} onValueChange={setCurrency}
                opciones={[{ value: "ARS", label: "ARS" }, { value: "USD", label: "USD" }]} />
            </div>
          </div>
          <p className="-mt-1 text-[11px] text-muted-foreground">
            Es lo que paga el paciente por TODO el tratamiento. De acá sale qué
            porcentaje del caso representa cada cobro.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cuotas">Cuotas (opcional)</Label>
              <Input id="cuotas" inputMode="numeric" value={cuotas} placeholder="6"
                onChange={(e) => setCuotas(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dto">Descuento KS %</Label>
              <Input id="dto" inputMode="decimal" value={dto} placeholder="0"
                onChange={(e) => setDto(e.target.value)} />
            </div>
          </div>
          <p className="-mt-1 text-[11px] text-muted-foreground">
            El descuento va sobre lo que el consultorio le paga a la fábrica, no
            sobre lo que paga el paciente.
          </p>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={etapa} onChange={(e) => setEtapa(e.target.checked)}
              className="size-4 accent-primary" />
            Es una etapa adicional
          </label>
          {etapa ? (
            <div className="space-y-1.5">
              <Label htmlFor="precioEtapa">Precio de lista de la etapa</Label>
              <Input id="precioEtapa" inputMode="decimal" value={precioEtapa} placeholder="498.000"
                onChange={(e) => setPrecioEtapa(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">
                Vacío = viene incluida en el programa 1 a 4 y no cuesta nada. Con
                precio, se le aplica el descuento de lista y se imputa entera en
                el primer cobro.
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="alias">Otras grafías en la caja</Label>
            <Input id="alias" value={alias} onChange={(e) => setAlias(e.target.value)}
              placeholder="Nisenbaum, Martin Nissenbaum" />
            <p className="text-[11px] text-muted-foreground">
              Separadas por coma. La caja escribe el mismo paciente de varias
              formas; acá se declaran para que sus cobros caigan en este pacto.
            </p>
          </div>

          <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <p className="mr-auto text-[11px] text-muted-foreground">
              Al guardar se recalculan las liquidaciones abiertas. Las
              confirmadas y pagadas no se tocan.
            </p>
            <Button type="button" variant="outline" size="sm"
              onClick={() => setOpen(false)} disabled={pending}>
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

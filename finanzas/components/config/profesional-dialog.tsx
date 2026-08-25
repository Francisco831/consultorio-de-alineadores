"use client";

// El porcentaje que cobra cada doctora, y si liquida por cuenta propia.
//
// Cambiar el % mueve las liquidaciones ABIERTAS: el porcentaje se congela en
// cada liquidación al guardarla, así que las cerradas conservan el que tenían.
// El diálogo lo dice, porque no es obvio.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { guardarProfesional } from "@/lib/actions/precios";
import type { EmpresaSlug } from "@/lib/empresas";

export function ProfesionalDialog({
  empresa, counterpartyId, nombre, pct, cuentaPropia, activa,
}: {
  empresa: EmpresaSlug;
  counterpartyId: string;
  nombre: string;
  pct: number;
  cuentaPropia: boolean;
  activa: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [valor, setValor] = useState(String(pct));
  const [propia, setPropia] = useState(cuentaPropia);
  const [act, setAct] = useState(activa);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await guardarProfesional({
        empresa, counterpartyId,
        settlementPct: Number(valor) || 0,
        settlesSeparately: propia,
        active: act,
      });
      if (res?.error) { toast.error(res.error); return; }
      setOpen(false);
      toast.success(res?.mensaje ?? "Guardado");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="text-xs font-medium text-primary hover:underline">Editar</DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>{nombre}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pct">Porcentaje de liquidación</Label>
            <Input id="pct" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={propia} onChange={(e) => setPropia(e.target.checked)}
              className="mt-0.5 size-4 accent-primary" />
            <span>
              Cobra a cuenta propia
              <span className="block text-[11px] text-muted-foreground">
                Sus cobros no generan liquidación ni quedan para la casa: son de ella.
              </span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={act} onChange={(e) => setAct(e.target.checked)}
              className="size-4 accent-primary" />
            Activa
          </label>
          <p className="text-[11px] text-muted-foreground">
            El porcentaje se congela en cada liquidación al confirmarla: cambiarlo
            mueve las abiertas y deja las cerradas como estaban.
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

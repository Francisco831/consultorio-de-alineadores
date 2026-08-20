"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { guardarProduccion } from "@/lib/actions/compras";
import type { EmpresaSlug } from "@/lib/empresas";

export function CargarProduccion({
  empresa, periodo,
}: { empresa: EmpresaSlug; periodo: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const aligners = Number(fd.get("aligners"));
    if (!Number.isFinite(aligners) || aligners < 0) { toast.error("Cantidad inválida"); return; }
    startTransition(async () => {
      const res = await guardarProduccion({
        empresa, period: String(fd.get("period")), aligners,
        cases: Number(fd.get("cases")) || undefined,
      });
      if (res?.error) toast.error(res.error);
      else { toast.success("Producción cargada"); setOpen(false); }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
        Cargar producción del mes
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Producción del mes</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <div className="space-y-1.5">
            <Label htmlFor="period">Mes</Label>
            <Input id="period" name="period" defaultValue={periodo} pattern="\d{4}-\d{2}" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aligners">Alineadores producidos</Label>
            <Input id="aligners" name="aligners" type="number" min={0} autoFocus required
              className="fig text-right" />
            <p className="text-xs text-muted-foreground">
              El número real que sale de la planta. Es el dato que ningún sistema tiene todavía.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cases">Casos enviados (opcional)</Label>
            <Input id="cases" name="cases" type="number" min={0} className="fig text-right" />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

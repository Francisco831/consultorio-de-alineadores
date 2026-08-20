"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CampoSelect } from "@/components/ui/campo-select";
import { guardarPresupuesto } from "@/lib/actions/presupuesto";
import { parseMoneyInput } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";

export function CargarPresupuesto({
  empresa, periodo, categorias, moneda,
}: {
  empresa: EmpresaSlug; periodo: string; moneda: string;
  categorias: Array<{ id: string; name: string; flow: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const amount = parseMoneyInput(String(fd.get("amount") ?? ""));
    if (!amount || amount < 0) { toast.error("Monto inválido"); return; }
    startTransition(async () => {
      const res = await guardarPresupuesto({
        empresa, period: String(fd.get("period")),
        categoryId: String(fd.get("category")), currency: moneda, amount,
      });
      if (res?.error) toast.error(res.error);
      else { toast.success("Presupuesto guardado"); setOpen(false); }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
        + Presupuestar categoría
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Presupuesto por categoría</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="period">Mes</Label>
              <Input id="period" name="period" defaultValue={periodo} pattern="\d{4}-\d{2}" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="amount">Monto ({moneda})</Label>
              <Input id="amount" name="amount" autoFocus required inputMode="decimal" className="fig text-right" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Categoría</Label>
            <CampoSelect name="category" defaultValue={categorias[0]?.id}
              opciones={categorias.map((c) => ({
                value: c.id,
                label: `${c.name}${c.flow === "income" ? " (ingreso)" : ""}`,
              }))} />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

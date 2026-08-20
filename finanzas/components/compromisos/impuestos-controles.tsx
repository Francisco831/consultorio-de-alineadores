"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { guardarObligacion, obligacionAPagar } from "@/lib/actions/compromisos";
import { parseMoneyInput } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";

export function NuevaObligacion({
  empresa, hoy,
}: { empresa: EmpresaSlug; hoy: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const sugerencias = empresa === "ar"
    ? ["IVA", "Ganancias", "IIBB", "F.931 (cargas sociales)", "Autónomos"]
    : ["ISR", "IVA", "IMSS", "INFONAVIT"];

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const est = parseMoneyInput(String(fd.get("amount") ?? ""));
    startTransition(async () => {
      const res = await guardarObligacion({
        empresa,
        taxName: String(fd.get("taxName")),
        jurisdiction: String(fd.get("jurisdiction")),
        period: String(fd.get("period")),
        dueOn: String(fd.get("dueOn")),
        amountEstimated: est ?? undefined,
      });
      if (res?.error) toast.error(res.error);
      else { toast.success("Obligación agendada"); setOpen(false); }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
        + Nueva obligación
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Agendar un impuesto</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <div className="space-y-1.5">
            <Label htmlFor="taxName">Impuesto</Label>
            <Input id="taxName" name="taxName" autoFocus required list="impuestos-sug" />
            <datalist id="impuestos-sug">
              {sugerencias.map((s) => <option key={s} value={s} />)}
            </datalist>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="jurisdiction">Jurisdicción</Label>
              <Input id="jurisdiction" name="jurisdiction" required
                defaultValue={empresa === "ar" ? "ARCA" : "SAT"} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="period">Período</Label>
              <Input id="period" name="period" required placeholder="2026-08"
                defaultValue={hoy.slice(0, 7)} pattern="\d{4}-\d{2}" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dueOn">Vence</Label>
              <Input id="dueOn" name="dueOn" type="date" defaultValue={hoy} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="amount">Monto estimado</Label>
              <Input id="amount" name="amount" inputMode="decimal" className="fig text-right" />
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Guardando…" : "Agendar"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MandarAPagar({
  empresa, obligacionId,
}: { empresa: EmpresaSlug; obligacionId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await obligacionAPagar(empresa, obligacionId);
          if (res?.error) toast.error(res.error);
          else toast.success("Mandada a Por pagar");
        })
      }>
      {pending ? "…" : "Mandar a pagar"}
    </Button>
  );
}

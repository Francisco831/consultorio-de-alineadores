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
import { crearPayable, pagarPayable } from "@/lib/actions/compromisos";
import { parseMoneyInput, formatMoney } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";

type Cuenta = { id: string; name: string; currency: string };

export function PagarBoton({
  empresa, payableId, concepto, saldo, currency, cuentas, hoy,
}: {
  empresa: EmpresaSlug; payableId: string; concepto: string;
  saldo: number; currency: string; cuentas: Cuenta[]; hoy: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const amount = parseMoneyInput(String(fd.get("amount") ?? ""));
    if (!amount || amount <= 0) { toast.error("Monto inválido"); return; }
    startTransition(async () => {
      const res = await pagarPayable({
        empresa, payableId, accountId: String(fd.get("account")),
        amount, date: String(fd.get("date")),
      });
      if (res?.error) toast.error(res.error);
      else {
        toast.success(amount < saldo ? "Pago parcial registrado" : "Pagado · el egreso quedó cargado");
        setOpen(false);
      }
    });
  }

  if (!cuentas.length) {
    return <span className="text-xs text-muted-foreground">sin cuenta en {currency}</span>;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">
        Marcar pagada
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Pagar · {concepto}</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <p className="text-sm text-muted-foreground">
            Saldo: <span className="fig font-medium text-foreground">{formatMoney(saldo, currency, "es-AR")}</span>
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="amount">Monto a pagar</Label>
            <Input id="amount" name="amount" autoFocus defaultValue={String(saldo)}
              inputMode="decimal" className="fig text-right" required />
            <p className="text-xs text-muted-foreground">Podés pagar menos: queda como pago parcial.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Sale de</Label>
              <CampoSelect name="account" defaultValue={cuentas[0]?.id}
                opciones={cuentas.map((c) => ({ value: c.id, label: c.name }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="date">Fecha</Label>
              <Input id="date" name="date" type="date" defaultValue={hoy} required />
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Registrando…" : "Pagar y generar el egreso"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function NuevaDeudaDialog({
  empresa, monedas, categorias, hoy,
}: {
  empresa: EmpresaSlug; monedas: string[];
  categorias: Array<{ id: string; name: string }>; hoy: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const amount = parseMoneyInput(String(fd.get("amount") ?? ""));
    if (!amount || amount <= 0) { toast.error("Monto inválido"); return; }
    startTransition(async () => {
      const res = await crearPayable({
        empresa,
        concept: String(fd.get("concept")),
        counterpartyName: (fd.get("counterparty") as string) || undefined,
        categoryId: (fd.get("category") as string) || null,
        currency: String(fd.get("currency")),
        amount, dueOn: String(fd.get("dueOn")),
      });
      if (res?.error) toast.error(res.error);
      else { toast.success("Deuda agendada"); setOpen(false); }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
        + Nueva deuda
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Agendar un pago</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <div className="space-y-1.5">
            <Label htmlFor="concept">Concepto</Label>
            <Input id="concept" name="concept" autoFocus required placeholder="Alquiler agosto" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="amount">Monto</Label>
              <Input id="amount" name="amount" required inputMode="decimal" className="fig text-right" />
            </div>
            <div className="space-y-1.5">
              <Label>Moneda</Label>
              <CampoSelect name="currency" defaultValue={monedas[0]}
                opciones={monedas.map((m) => ({ value: m, label: m }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="counterparty">Proveedor</Label>
            <Input id="counterparty" name="counterparty" placeholder="Opcional; se crea si no existe" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Categoría</Label>
              <CampoSelect name="category" placeholder="Sin categoría"
                opciones={categorias.map((c) => ({ value: c.id, label: c.name }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dueOn">Vence</Label>
              <Input id="dueOn" name="dueOn" type="date" defaultValue={hoy} required />
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

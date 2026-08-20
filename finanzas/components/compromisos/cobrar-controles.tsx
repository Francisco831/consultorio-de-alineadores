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
import { crearReceivable, cobrarReceivable } from "@/lib/actions/compromisos";
import { parseMoneyInput, formatMoney } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";

type Cuenta = { id: string; name: string; currency: string };

export function CobrarBoton({
  empresa, receivableId, concepto, saldo, currency, cuentas, hoy,
}: {
  empresa: EmpresaSlug; receivableId: string; concepto: string;
  saldo: number; currency: string; cuentas: Cuenta[]; hoy: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const amount = parseMoneyInput(String(fd.get("amount") ?? ""));
    if (!amount || amount <= 0) { toast.error("Monto inválido"); return; }
    startTransition(async () => {
      const res = await cobrarReceivable({
        empresa, receivableId, accountId: String(fd.get("account")),
        amount, date: String(fd.get("date")),
      });
      if (res?.error) toast.error(res.error);
      else {
        toast.success(amount < saldo ? "Cobro parcial registrado" : "Cobrado · el ingreso quedó cargado");
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
        Cobrar
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Cobrar · {concepto}</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <p className="text-sm text-muted-foreground">
            Saldo: <span className="fig font-medium text-foreground">{formatMoney(saldo, currency, "es-AR")}</span>
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="amount">Monto cobrado</Label>
            <Input id="amount" name="amount" autoFocus defaultValue={String(saldo)}
              inputMode="decimal" className="fig text-right" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Entra en</Label>
              <CampoSelect name="account" defaultValue={cuentas[0]?.id}
                opciones={cuentas.map((c) => ({ value: c.id, label: c.name }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="date">Fecha</Label>
              <Input id="date" name="date" type="date" defaultValue={hoy} required />
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Registrando…" : "Cobrar y generar el ingreso"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function NuevaDeudaClienteDialog({
  empresa, monedas, hoy,
}: {
  empresa: EmpresaSlug; monedas: string[]; hoy: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const amount = parseMoneyInput(String(fd.get("amount") ?? ""));
    const cuotas = Number(fd.get("installments") ?? 1);
    if (!amount || amount <= 0) { toast.error("Monto inválido"); return; }
    startTransition(async () => {
      const res = await crearReceivable({
        empresa,
        counterpartyName: String(fd.get("counterparty")),
        concept: String(fd.get("concept")),
        currency: String(fd.get("currency")),
        amount,
        dueOn: String(fd.get("dueOn")),
        installments: Number.isFinite(cuotas) && cuotas > 0 ? cuotas : 1,
      });
      if (res?.error) toast.error(res.error);
      else {
        toast.success(res.cuotas && res.cuotas > 1 ? `${res.cuotas} cuotas generadas` : "Deuda registrada");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
        + Nueva deuda
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Registrar lo que te deben</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <div className="space-y-1.5">
            <Label htmlFor="counterparty">{empresa === "ar" ? "Paciente" : "Doctor"}</Label>
            <Input id="counterparty" name="counterparty" autoFocus required placeholder="Se crea si no existe" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="concept">Concepto</Label>
            <Input id="concept" name="concept" required placeholder="Tratamiento alineadores" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="amount">Total</Label>
              <Input id="amount" name="amount" required inputMode="decimal" className="fig text-right" />
            </div>
            <div className="space-y-1.5">
              <Label>Moneda</Label>
              <CampoSelect name="currency" defaultValue={monedas[0]}
                opciones={monedas.map((m) => ({ value: m, label: m }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="installments">Cuotas</Label>
              <Input id="installments" name="installments" type="number" min={1} max={60}
                defaultValue={1} className="fig text-right" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dueOn">Vence la 1ª</Label>
            <Input id="dueOn" name="dueOn" type="date" defaultValue={hoy} required />
            <p className="text-xs text-muted-foreground">Las siguientes vencen mes a mes.</p>
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Guardando…" : "Registrar"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

"use client";

// El "+ Nuevo" del header con sus modales de alta rápida.
// Presupuesto del flujo diario: cargar un gasto en <10 segundos —
// Monto (foco inicial) → contraparte → ⌘Enter.

import { useState, useTransition } from "react";
import { Plus, ArrowDownLeft, ArrowUpRight, ArrowLeftRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CampoSelect } from "@/components/ui/campo-select";
import { crearMovimiento, crearTransferencia } from "@/lib/actions/movimientos";
import { parseMoneyInput } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";

export type CuentaOpt = { id: string; name: string; currency: string };
export type CategoriaOpt = { id: string; name: string; flow: string };

type Props = {
  empresa: EmpresaSlug;
  cuentas: CuentaOpt[];
  categorias: CategoriaOpt[];
  hoy: string; // YYYY-MM-DD en la TZ de la empresa (viene del server)
};

export function NuevoMenu({ empresa, cuentas, categorias, hoy }: Props) {
  const [dialogo, setDialogo] = useState<null | "income" | "expense" | "transfer">(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Nuevo
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => setDialogo("income")}>
            <ArrowDownLeft className="h-4 w-4 text-emerald-600" /> Ingreso
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialogo("expense")}>
            <ArrowUpRight className="h-4 w-4 text-red-500" /> Gasto
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialogo("transfer")}>
            <ArrowLeftRight className="h-4 w-4 text-muted-foreground" /> Transferencia
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialogo === "income" || dialogo === "expense" ? (
        <MovimientoDialog
          empresa={empresa} cuentas={cuentas} categorias={categorias} hoy={hoy}
          kind={dialogo} onClose={() => setDialogo(null)}
        />
      ) : null}
      {dialogo === "transfer" ? (
        <TransferenciaDialog
          empresa={empresa} cuentas={cuentas} hoy={hoy} onClose={() => setDialogo(null)}
        />
      ) : null}
    </>
  );
}

function MovimientoDialog({
  empresa, cuentas, categorias, hoy, kind, onClose,
}: Props & { kind: "income" | "expense"; onClose: () => void }) {
  const [pending, startTransition] = useTransition();
  const cats = categorias.filter((c) => c.flow === kind);

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const amount = parseMoneyInput(String(fd.get("amount") ?? ""));
    if (!amount || amount <= 0) {
      toast.error("Monto inválido");
      return;
    }
    startTransition(async () => {
      const res = await crearMovimiento({
        empresa,
        kind,
        amount,
        accountId: String(fd.get("account")),
        categoryId: (fd.get("category") as string) || null,
        counterpartyName: (fd.get("counterparty") as string) || undefined,
        occurredOn: String(fd.get("date")),
        description: (fd.get("description") as string) || undefined,
        status: "confirmed",
      });
      if (res?.error) toast.error(res.error);
      else {
        toast.success(kind === "income" ? "Ingreso cargado" : "Gasto cargado");
        onClose();
      }
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{kind === "income" ? "Nuevo ingreso" : "Nuevo gasto"}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit(e.currentTarget);
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="amount">Monto</Label>
            <Input
              id="amount" name="amount" autoFocus required inputMode="decimal"
              placeholder="0" className="fig text-right text-lg font-semibold"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Cuenta</Label>
              <CampoSelect name="account" defaultValue={cuentas[0]?.id} placeholder="Cuenta"
                opciones={cuentas.map((c) => ({ value: c.id, label: `${c.name} · ${c.currency}` }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="date">Fecha</Label>
              <Input id="date" name="date" type="date" defaultValue={hoy} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="counterparty">
              {kind === "income" ? "Cliente / paciente" : "Proveedor"}
            </Label>
            <Input id="counterparty" name="counterparty" placeholder="Se crea si no existe" />
          </div>
          <div className="space-y-1.5">
            <Label>Categoría</Label>
            <CampoSelect name="category" placeholder="Sin categoría"
              opciones={cats.map((c) => ({ value: c.id, label: c.name }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Concepto</Label>
            <Input id="description" name="description" placeholder="Opcional" />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Guardando…" : "Guardar (⌘Enter)"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TransferenciaDialog({
  empresa, cuentas, hoy, onClose,
}: Omit<Props, "categorias"> & { onClose: () => void }) {
  const [pending, startTransition] = useTransition();
  const [fromId, setFromId] = useState(cuentas[0]?.id ?? "");
  const [toId, setToId] = useState(cuentas[1]?.id ?? "");
  const from = cuentas.find((c) => c.id === fromId);
  const to = cuentas.find((c) => c.id === toId);
  const crossCurrency = from && to && from.currency !== to.currency;

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const amountOut = parseMoneyInput(String(fd.get("amountOut") ?? ""));
    const amountIn = crossCurrency
      ? parseMoneyInput(String(fd.get("amountIn") ?? ""))
      : amountOut;
    if (!amountOut || amountOut <= 0 || !amountIn || amountIn <= 0) {
      toast.error("Montos inválidos");
      return;
    }
    startTransition(async () => {
      const res = await crearTransferencia({
        empresa,
        fromAccountId: fromId,
        toAccountId: toId,
        amountOut,
        amountIn,
        occurredOn: String(fd.get("date")),
        description: (fd.get("description") as string) || undefined,
      });
      if (res?.error) toast.error(res.error);
      else {
        toast.success("Transferencia registrada (no es ingreso ni gasto)");
        onClose();
      }
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transferencia entre cuentas</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Desde</Label>
              <CampoSelect value={fromId} onValueChange={setFromId}
                opciones={cuentas.map((c) => ({ value: c.id, label: `${c.name} · ${c.currency}` }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Hacia</Label>
              <CampoSelect value={toId} onValueChange={setToId}
                opciones={cuentas.filter((c) => c.id !== fromId).map((c) => ({ value: c.id, label: `${c.name} · ${c.currency}` }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="amountOut">
              {crossCurrency ? `Sale (${from?.currency})` : "Monto"}
            </Label>
            <Input id="amountOut" name="amountOut" required inputMode="decimal" className="fig text-right" />
          </div>
          {crossCurrency ? (
            <div className="space-y-1.5">
              <Label htmlFor="amountIn">Entra ({to?.currency})</Label>
              <Input id="amountIn" name="amountIn" required inputMode="decimal" className="fig text-right" />
              <p className="text-xs text-muted-foreground">
                Monedas distintas: ambos montos explícitos. Acá no se inventan tipos de cambio.
              </p>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="date">Fecha</Label>
              <Input id="date" name="date" type="date" defaultValue={hoy} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="description">Concepto</Label>
              <Input id="description" name="description" placeholder="Opcional" />
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Guardando…" : "Registrar transferencia"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal, Ban, Pencil } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CampoSelect } from "@/components/ui/campo-select";
import { anularMovimiento, corregirMovimiento } from "@/lib/actions/movimientos";
import { parseMoneyInput } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";
import type { CuentaOpt, CategoriaOpt } from "@/components/movimientos/nuevo-menu";

export type MovimientoFila = {
  id: string;
  status: string;
  source: string;
  kind: string;
  amount: number;
  currency: string;
  occurredOn: string;
  accountId: string;
  categoryId: string | null;
  description: string | null;
};

// Los que nacen en la app se corrigen acá; los que vienen de afuera, en la fuente
// (si no, el próximo sync pisa la corrección). Misma regla que correct_movement.
const CORREGIBLES = new Set(["manual", "payable", "receivable", "settlement", "payroll"]);

export function RowActions({
  empresa, movimiento, cuentas, categorias,
}: {
  empresa: EmpresaSlug;
  movimiento: MovimientoFila;
  cuentas: CuentaOpt[];
  categorias: CategoriaOpt[];
}) {
  const [pending, startTransition] = useTransition();
  const [corrigiendo, setCorrigiendo] = useState(false);
  const { id, status, source, kind } = movimiento;
  if (status === "void") return null;

  const esTransfer = kind === "transfer_in" || kind === "transfer_out";
  const sePuedeCorregir = CORREGIBLES.has(source) && !esTransfer;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="rounded p-1 text-muted-foreground hover:bg-accent">
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {sePuedeCorregir ? (
            <DropdownMenuItem onClick={() => setCorrigiendo(true)}>
              <Pencil className="h-4 w-4" /> Corregir
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                if (!confirm("¿Anular este movimiento? Queda en el historial como anulado, y si pagaba una deuda, la deuda vuelve a Por pagar.")) return;
                const res = await anularMovimiento(empresa, id);
                if (res?.error) toast.error(res.error);
                else toast.success("Movimiento anulado");
              })
            }
            className="text-red-600"
          >
            <Ban className="h-4 w-4" /> Anular
          </DropdownMenuItem>
          {!sePuedeCorregir && source !== "manual" ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              {esTransfer
                ? "Transferencia: se corrige anulándola y rehaciéndola."
                : `Origen ${source}: los montos se corrigen en la fuente.`}
            </div>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {corrigiendo ? (
        <CorregirDialog
          empresa={empresa} movimiento={movimiento}
          cuentas={cuentas} categorias={categorias}
          onClose={() => setCorrigiendo(false)}
        />
      ) : null}
    </>
  );
}

/**
 * El caso que existe todos los días: lo pagué desde otra cuenta / me equivoqué la
 * fecha o el monto. Corrige en el lugar, sin anular ni volver a cargar — y si el
 * movimiento pagaba una deuda, el pago aplicado se mueve con él.
 */
function CorregirDialog({
  empresa, movimiento, cuentas, categorias, onClose,
}: {
  empresa: EmpresaSlug;
  movimiento: MovimientoFila;
  cuentas: CuentaOpt[];
  categorias: CategoriaOpt[];
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  // la moneda no se corrige: cambiarla sería otro movimiento
  const cuentasMoneda = cuentas.filter((c) => c.currency === movimiento.currency);
  const cats = categorias.filter((c) => c.flow === movimiento.kind);

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const amount = parseMoneyInput(String(fd.get("amount") ?? ""));
    if (!amount || amount <= 0) {
      toast.error("Monto inválido");
      return;
    }
    startTransition(async () => {
      const res = await corregirMovimiento({
        empresa,
        movementId: movimiento.id,
        accountId: String(fd.get("account")),
        amount,
        occurredOn: String(fd.get("date")),
        categoryId: (fd.get("category") as string) || null,
        description: (fd.get("description") as string) || undefined,
      });
      if (res?.error) toast.error(res.error);
      else {
        toast.success("Movimiento corregido");
        onClose();
      }
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Corregir movimiento</DialogTitle>
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
            <Label>Cuenta</Label>
            <CampoSelect
              name="account" defaultValue={movimiento.accountId} placeholder="Cuenta"
              opciones={cuentasMoneda.map((c) => ({ value: c.id, label: `${c.name} · ${c.currency}` }))}
            />
            <p className="text-[11px] text-muted-foreground">
              Con qué plata salió (o entró) de verdad.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="amount">Monto</Label>
              <Input
                id="amount" name="amount" required inputMode="decimal"
                defaultValue={String(movimiento.amount)}
                className="fig text-right font-semibold"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="date">Fecha</Label>
              <Input id="date" name="date" type="date" defaultValue={movimiento.occurredOn} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Categoría</Label>
            <CampoSelect
              name="category" defaultValue={movimiento.categoryId ?? undefined} placeholder="Sin categoría"
              opciones={cats.map((c) => ({ value: c.id, label: c.name }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Concepto</Label>
            <Input id="description" name="description" defaultValue={movimiento.description ?? ""} placeholder="Opcional" />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Guardando…" : "Guardar (⌘Enter)"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

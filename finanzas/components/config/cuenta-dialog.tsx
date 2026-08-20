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
import { guardarCuenta } from "@/lib/actions/config";
import type { EmpresaSlug } from "@/lib/empresas";

type CuentaEdit = {
  id: string; name: string; type: string; currency: string;
  includeInTotals: boolean; isActive: boolean;
};

export function CuentaDialog({
  empresa, monedas, cuenta,
}: {
  empresa: EmpresaSlug; monedas: string[]; cuenta?: CuentaEdit;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const esEdicion = !!cuenta;

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    startTransition(async () => {
      const res = await guardarCuenta({
        empresa,
        id: cuenta?.id,
        name: String(fd.get("name")),
        type: String(fd.get("type")) as "bank" | "mercadopago" | "cash" | "external",
        currency: String(fd.get("currency") ?? cuenta?.currency ?? monedas[0]),
        bankName: (fd.get("bankName") as string) || undefined,
        includeInTotals: fd.get("includeInTotals") === "on",
        isActive: esEdicion ? fd.get("isActive") === "on" : true,
      });
      if (res?.error) toast.error(res.error);
      else {
        toast.success(esEdicion ? "Cuenta actualizada" : "Cuenta creada");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className={
          esEdicion
            ? "text-xs font-medium text-primary hover:underline"
            : "inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
        }
      >
        {esEdicion ? "Editar" : "+ Nueva cuenta"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{esEdicion ? `Editar ${cuenta.name}` : "Nueva cuenta"}</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <div className="space-y-1.5">
            <Label htmlFor="name">Nombre</Label>
            <Input id="name" name="name" required defaultValue={cuenta?.name} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <CampoSelect name="type" defaultValue={cuenta?.type ?? "bank"}
                opciones={[
                  { value: "bank", label: "Banco" },
                  { value: "mercadopago", label: "Mercado Pago" },
                  { value: "cash", label: "Efectivo" },
                  { value: "external", label: "Externa" },
                ]} />
            </div>
            <div className="space-y-1.5">
              <Label>Moneda</Label>
              {esEdicion ? (
                <Input value={cuenta.currency} disabled title="La moneda de una cuenta no se cambia" />
              ) : (
                <CampoSelect name="currency" defaultValue={monedas[0]}
                  opciones={monedas.map((m) => ({ value: m, label: m }))} />
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bankName">Banco (opcional)</Label>
            <Input id="bankName" name="bankName" placeholder="BBVA, Macro…" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox" name="includeInTotals"
              defaultChecked={cuenta?.includeInTotals ?? true}
            />
            Suma a la disponibilidad total
          </label>
          {esEdicion ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isActive" defaultChecked={cuenta.isActive} />
              Cuenta activa
            </label>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

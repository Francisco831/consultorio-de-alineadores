"use client";

// Poner a mano los dos números de una línea: lo cobrado y el costo KS.
//
// La corrección NO se guarda en la liquidación: se guarda aparte
// (settlement_line_overrides) y el motor la vuelve a aplicar en cada recálculo.
// Si se escribiera en el resultado, el próximo recálculo la pisaría — y el
// recálculo no lo dispara sólo el botón: también guardar un pacto o tocar la
// lista de precios.
//
// Vacío ≠ cero. Un campo vacío significa "no lo toco, vale lo que calculó el
// motor"; para decir cero se escribe 0. Son dos cosas distintas y las dos hacen
// falta.
//
// Todo el diálogo es HTML nativo con submit explícito, por la misma razón que
// ImputarCobro: el 25/8/26 un control de la librería escribió solo, dos veces,
// sobre tres cobros de Virginia. Nada acá se guarda sin apretar el botón.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { editarLineaLiquidacion, deshacerLineaLiquidacion } from "@/lib/actions/liquidaciones";
import { formatMoney, parseMoneyInput } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { EmpresaSlug } from "@/lib/empresas";

export type OverrideActual = {
  cobradoArs: number | null;
  costoKsArs: number | null;
  motivo: string;
};

export function EditarLinea({
  empresa, movementId, paciente, cobradoCalculado, costoCalculado,
  montoCaja, moneda, locale, override,
}: {
  empresa: EmpresaSlug;
  movementId: string;
  paciente: string;
  /** Lo que muestra hoy la línea (ya con el override aplicado, si lo hay). */
  cobradoCalculado: number;
  costoCalculado: number;
  /** Lo que dice la caja, en su moneda: para poder avisar cuando ya no coinciden. */
  montoCaja: number;
  moneda: string;
  locale: string;
  override: OverrideActual | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [cobrado, setCobrado] = useState(override?.cobradoArs != null ? String(override.cobradoArs) : "");
  const [costo, setCosto] = useState(override?.costoKsArs != null ? String(override.costoKsArs) : "");
  const [motivo, setMotivo] = useState(override?.motivo ?? "");

  const nuevoCobrado = cobrado.trim() ? parseMoneyInput(cobrado) : null;
  const difiereDeLaCaja =
    nuevoCobrado != null && moneda !== "USD" && Math.abs(nuevoCobrado - montoCaja) >= 1;

  function guardar(e: React.FormEvent) {
    e.preventDefault();
    const c = cobrado.trim() ? parseMoneyInput(cobrado) : null;
    const k = costo.trim() ? parseMoneyInput(costo) : null;
    if (cobrado.trim() && c == null) return toast.error("El cobrado no es un número");
    if (costo.trim() && k == null) return toast.error("El costo KS no es un número");
    if (c == null && k == null) {
      return toast.error("Dejá al menos uno de los dos números, o deshacé la corrección");
    }
    if (motivo.trim().length < 3) return toast.error("Escribí por qué: dentro de tres meses va a ser lo único que lo explique");

    startTransition(async () => {
      const res = await editarLineaLiquidacion({
        empresa, movementId, cobradoArs: c, costoKsArs: k, motivo: motivo.trim(),
      });
      if (res?.error) toast.error(res.error);
      else {
        setOpen(false);
        toast.success(`${paciente}: línea puesta a mano · mes recalculado`);
        router.refresh();
      }
    });
  }

  function deshacer() {
    startTransition(async () => {
      const res = await deshacerLineaLiquidacion({ empresa, movementId });
      if (res?.error) toast.error(res.error);
      else {
        setOpen(false);
        toast.success(`${paciente}: la línea vuelve a lo que calcula el sistema`);
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-md border transition-colors hover:bg-accent",
          override && "border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300"
        )}
        title={override ? "Esta línea tiene números puestos a mano" : "Poner los números de esta línea a mano"}
      >
        <Pencil className="size-3" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Poner esta línea a mano</DialogTitle></DialogHeader>
        <p className="-mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{paciente}</span>
          {" · la caja dice "}{formatMoney(montoCaja, moneda, locale)}
        </p>

        <form className="space-y-3" onSubmit={guardar}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ov-cobrado">Cobrado</Label>
              <Input
                id="ov-cobrado" inputMode="decimal" autoComplete="off"
                placeholder={String(Math.round(cobradoCalculado))}
                value={cobrado} onChange={(e) => setCobrado(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Vacío = {formatMoney(cobradoCalculado, "ARS", locale)} (lo calculado)
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ov-costo">Costo KS</Label>
              <Input
                id="ov-costo" inputMode="decimal" autoComplete="off"
                placeholder={String(Math.round(costoCalculado))}
                value={costo} onChange={(e) => setCosto(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Vacío = {formatMoney(costoCalculado, "ARS", locale)} (lo calculado)
              </p>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="ov-motivo">Por qué</Label>
            <Input
              id="ov-motivo" autoComplete="off" placeholder="pagó el tratamiento entero con 10% de descuento"
              value={motivo} onChange={(e) => setMotivo(e.target.value)}
            />
          </div>

          {difiereDeLaCaja ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              La caja va a seguir diciendo {formatMoney(montoCaja, moneda, locale)}. Acá cambiás lo
              que entra a la liquidación de la doctora, no lo que pasó: si lo que está mal es la
              caja, se corrige en la planilla.
            </p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Para sacar la línea de la liquidación no pongas cobrado 0: usá “no se liquida a nadie”
            en el selector de la doctora, que es lo que deja el cobro para la casa.
          </p>

          <DialogFooter className="items-center">
            {override ? (
              <Button type="button" variant="outline" size="sm" onClick={deshacer} disabled={pending}
                className="mr-auto text-muted-foreground">
                Deshacer
              </Button>
            ) : null}
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

/**
 * Volver atrás, de un click: la línea deja de tener números a mano y vuelve a
 * valer lo que calcula el sistema. La fila no se borra —queda anulada, con su
 * historia en audit_log— porque un borrado no deja rastro de que existió.
 */
export function DeshacerLinea({
  empresa, movementId, paciente,
}: {
  empresa: EmpresaSlug;
  movementId: string;
  paciente: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      title={`Volver al número que calcula el sistema (${paciente})`}
      className="rounded-md border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      onClick={() =>
        startTransition(async () => {
          const res = await deshacerLineaLiquidacion({ empresa, movementId });
          if (res?.error) toast.error(res.error);
          else {
            toast.success(`${paciente}: la línea vuelve a lo que calcula el sistema`);
            router.refresh();
          }
        })
      }
    >
      {pending ? "…" : "Deshacer"}
    </button>
  );
}

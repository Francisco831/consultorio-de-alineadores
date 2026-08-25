"use client";

// A quién se le liquida ESTE cobro. La caja anota quién estaba en el
// consultorio, no quién hizo el tratamiento: cuando la paciente sólo pasa a
// retirar, la plata no se le liquida a nadie y queda para la casa.
//
// POR QUÉ ES UN BOTÓN QUE ABRE UN DIÁLOGO Y NO UN SELECT.
// La primera versión era un <CampoSelect> en la fila. El 25/8/26 escribió sola,
// dos veces, la MISMA opción —la última de la lista, "no se liquida"— sobre
// tres cobros de Virginia que nadie había tocado: alcanzaba con que la página
// se volviera a renderizar. Un control que mueve plata no puede depender de que
// la librería no dispare onValueChange de más. Acá nada se escribe si no se
// aprieta "Guardar": los radios son nativos y el envío es un submit explícito.

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { imputarCobro } from "@/lib/actions/liquidaciones";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { EmpresaSlug } from "@/lib/empresas";

export const DESTINO_CASA = "casa";
export const DESTINO_CAJA = "caja";

export function ImputarCobro({
  empresa, movementId, valor, doctoraCaja, doctoras, paciente, monto, moneda, locale,
}: {
  empresa: EmpresaSlug;
  movementId: string;
  /** uuid de la profesional · "casa" (a nadie) · "caja" (como viene) */
  valor: string;
  doctoraCaja: string | null;
  doctoras: Array<{ id: string; nombre: string }>;
  paciente: string;
  monto: number;
  moneda: string;
  locale: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [actual, setActual] = useState(valor);

  const etiqueta = (v: string) =>
    v === DESTINO_CASA ? "No se liquida"
    : v === DESTINO_CAJA ? (doctoraCaja ?? "Sin doctora")
    : (doctoras.find((d) => d.id === v)?.nombre ?? "—");

  const opciones = [
    {
      value: DESTINO_CAJA,
      titulo: doctoraCaja ? `${doctoraCaja} — como dice la caja` : "Nadie: la caja no dice doctora",
      detalle: "Queda como viene. Sirve para dejar constancia de que lo miraste.",
    },
    ...doctoras.map((d) => ({
      value: d.id,
      titulo: d.nombre,
      detalle: d.nombre === doctoraCaja ? "Igual que la caja, pero fijado a mano" : "Se lo liquidás a ella",
    })),
    {
      value: DESTINO_CASA,
      titulo: "No se liquida a nadie",
      detalle: "La paciente sólo retiró: el cobro queda entero para vos.",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className={cn(
          "inline-flex h-7 max-w-[210px] items-center truncate rounded-md border px-2 text-[11px] font-medium transition-colors hover:bg-accent",
          actual === DESTINO_CASA && "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
        )}
        title="Cambiar a quién se le liquida este cobro"
      >
        {etiqueta(actual)}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>¿A quién se le liquida?</DialogTitle></DialogHeader>
        <p className="-mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{paciente}</span>
          {" · "}{formatMoney(monto, moneda, locale)}
        </p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const elegido = String(new FormData(e.currentTarget).get("destino") ?? "");
            if (!elegido || elegido === actual) { setOpen(false); return; }
            const previo = actual;
            setActual(elegido);
            startTransition(async () => {
              const res = await imputarCobro({ empresa, movementId, destino: elegido });
              if (res?.error) {
                setActual(previo);
                toast.error(res.error);
              } else {
                setOpen(false);
                toast.success(
                  elegido === DESTINO_CASA
                    ? `${paciente}: no se liquida a nadie · mes recalculado`
                    : `${paciente}: se le liquida a ${etiqueta(elegido)} · mes recalculado`
                );
              }
            });
          }}
        >
          <div className="space-y-1">
            {opciones.map((o) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-start gap-2.5 rounded-md border border-transparent p-2 hover:bg-accent has-checked:border-primary has-checked:bg-accent"
              >
                <input
                  type="radio" name="destino" value={o.value}
                  defaultChecked={o.value === actual}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span className="text-[13px] leading-tight">
                  <span className="font-medium">{o.titulo}</span>
                  <span className="block text-[11px] text-muted-foreground">{o.detalle}</span>
                </span>
              </label>
            ))}
          </div>
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

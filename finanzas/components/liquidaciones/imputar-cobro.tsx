"use client";

// A quién se le liquida ESTE cobro. La caja anota quién estaba en el
// consultorio, no quién hizo el tratamiento: cuando la paciente sólo pasa a
// retirar, la plata no se le liquida a nadie y queda para la casa.
//
// PREGUNTA ANTES DE ESCRIBIR, a propósito. Probando el panel el 25/8/26, tres
// cobros de Virginia cambiaron de imputación sin que nadie eligiera nada:
// alcanzó con moverse por la lista con el teclado. Mover un cobro de una
// liquidación a otra es mover plata, así que un roce no puede alcanzar.
//
// Confirmado el cambio, el mes se recalcula en el acto: si hubiera que apretar
// después "Recalcular", el panel mostraría números viejos sin avisar que lo son.

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CampoSelect } from "@/components/ui/campo-select";
import { imputarCobro } from "@/lib/actions/liquidaciones";
import { formatMoney } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";

export const DESTINO_CASA = "casa";
export const DESTINO_CAJA = "caja";

export function ImputarCobro({
  empresa, movementId, valor, doctoraCaja, doctoras, paciente, monto, moneda, locale,
}: {
  empresa: EmpresaSlug;
  movementId: string;
  /** uuid de la profesional · "casa" (a nadie) · "caja" (sin corrección) */
  valor: string;
  doctoraCaja: string | null;
  doctoras: Array<{ id: string; nombre: string }>;
  paciente: string;
  monto: number;
  moneda: string;
  locale: string;
}) {
  const [pending, startTransition] = useTransition();
  const [actual, setActual] = useState(valor);

  const opciones = [
    {
      value: DESTINO_CAJA,
      label: doctoraCaja ? `Como dice la caja (${doctoraCaja})` : "Sin doctora en la caja",
    },
    ...doctoras.map((d) => ({ value: d.id, label: d.nombre })),
    { value: DESTINO_CASA, label: "No se liquida (para vos)" },
  ];

  const destinoLegible = (v: string) =>
    v === DESTINO_CASA ? "a nadie: queda entero para vos"
    : v === DESTINO_CAJA ? `a ${doctoraCaja ?? "nadie"}, como dice la caja`
    : `a ${doctoras.find((d) => d.id === v)?.nombre ?? "esa doctora"}`;

  return (
    <CampoSelect
      className="h-7 w-[235px] text-xs"
      opciones={opciones}
      value={actual}
      disabled={pending}
      onValueChange={(v) => {
        if (!v || v === actual) return;
        const previo = actual;
        const ok = window.confirm(
          `${formatMoney(monto, moneda, locale)} de ${paciente}\n\n` +
          `Pasa a liquidarse ${destinoLegible(v)}.\n\n` +
          `Se recalcula el mes de las dos doctoras involucradas.`
        );
        if (!ok) return;
        setActual(v);
        startTransition(async () => {
          const res = await imputarCobro({ empresa, movementId, destino: v });
          if (res?.error) {
            setActual(previo);
            toast.error(res.error);
          } else {
            toast.success(`${paciente}: ahora se liquida ${destinoLegible(v)} · mes recalculado`);
          }
        });
      }}
    />
  );
}

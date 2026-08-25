"use client";

// "Esta línea ya la miré y está bien." No mueve un peso: sirve para que el mes
// que viene Pancho sepa cuáles ya revisó y no vuelva a leer las 47 de Mónica
// desde cero.
//
// Es un <button> pelado y no un componente de la librería a propósito: el
// selector de imputación que sí usaba la librería escribió solo dos veces
// (25/8/26). Un botón nativo sólo se dispara con un clic.

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CheckIcon } from "lucide-react";
import { marcarRevisado } from "@/lib/actions/liquidaciones";
import { cn } from "@/lib/utils";
import type { EmpresaSlug } from "@/lib/empresas";

export function RevisadoCheck({
  empresa, movementId, revisado, paciente,
}: {
  empresa: EmpresaSlug;
  movementId: string;
  revisado: boolean;
  paciente: string;
}) {
  const [pending, startTransition] = useTransition();
  const [marcado, setMarcado] = useState(revisado);

  return (
    <button
      type="button"
      aria-pressed={marcado}
      disabled={pending}
      title={marcado ? `Revisado — clic para destildar (${paciente})` : `Marcar como revisado (${paciente})`}
      className={cn(
        "inline-flex size-4 items-center justify-center rounded-[4px] border transition-colors",
        marcado
          ? "border-emerald-600 bg-emerald-600 text-white"
          : "border-input hover:border-emerald-500 hover:bg-accent",
        pending && "opacity-50"
      )}
      onClick={() => {
        const nuevo = !marcado;
        setMarcado(nuevo);
        startTransition(async () => {
          const res = await marcarRevisado({ empresa, movementId, revisado: nuevo });
          if (res?.error) {
            setMarcado(!nuevo);
            toast.error(res.error);
          }
        });
      }}
    >
      {marcado ? <CheckIcon className="size-3" /> : null}
    </button>
  );
}

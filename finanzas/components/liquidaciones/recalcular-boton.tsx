"use client";

// Vuelve a calcular el mes con lo que hay hoy en el ledger. Existe porque hasta
// hoy la única forma de recalcular era correr un script en la terminal de la
// Mac de Pancho: si él estaba en la otra computadora, el panel se quedaba con
// los números de la última corrida y no había manera de saberlo.

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { recalcularPeriodo } from "@/lib/actions/liquidaciones";
import type { EmpresaSlug } from "@/lib/empresas";

export function RecalcularBoton({ empresa, periodo }: { empresa: EmpresaSlug; periodo: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await recalcularPeriodo(empresa, periodo);
          if (res?.error) toast.error(res.error);
          else toast.success(res?.mensaje ?? "Recalculado");
        })
      }
    >
      {pending ? "Recalculando…" : `Recalcular ${periodo}`}
    </Button>
  );
}

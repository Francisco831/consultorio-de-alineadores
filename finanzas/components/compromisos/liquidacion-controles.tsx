"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { confirmarLiquidacion } from "@/lib/actions/compromisos";
import { formatMoney } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";

export function ConfirmarLiquidacion({
  empresa, settlementId, profesional, monto, hoy,
}: {
  empresa: EmpresaSlug; settlementId: string; profesional: string; monto: number; hoy: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const ok = confirm(
            `Confirmar la liquidación de ${profesional} por ${formatMoney(monto, "ARS", "es-AR")}?\n\n` +
            `Se congela el porcentaje y pasa a "Por pagar".`
          );
          if (!ok) return;
          const res = await confirmarLiquidacion(empresa, settlementId, hoy);
          if (res?.error) toast.error(res.error);
          else toast.success("Confirmada · ya está en Por pagar");
        })
      }
    >
      {pending ? "…" : "Confirmar"}
    </Button>
  );
}

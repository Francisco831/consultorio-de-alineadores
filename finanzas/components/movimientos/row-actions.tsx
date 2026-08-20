"use client";

import { useTransition } from "react";
import { MoreHorizontal, Ban } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { anularMovimiento } from "@/lib/actions/movimientos";
import type { EmpresaSlug } from "@/lib/empresas";

export function RowActions({
  empresa, movementId, status, source,
}: {
  empresa: EmpresaSlug; movementId: string; status: string; source: string;
}) {
  const [pending, startTransition] = useTransition();
  if (status === "void") return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="rounded p-1 text-muted-foreground hover:bg-accent">
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              if (!confirm("¿Anular este movimiento? Queda en el historial como anulado.")) return;
              const res = await anularMovimiento(empresa, movementId);
              if (res?.error) toast.error(res.error);
              else toast.success("Movimiento anulado");
            })
          }
          className="text-red-600"
        >
          <Ban className="h-4 w-4" /> Anular
        </DropdownMenuItem>
        {source !== "manual" ? (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
            Origen {source}: los montos se corrigen en la fuente.
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

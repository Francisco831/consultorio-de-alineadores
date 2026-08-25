"use client";

// Deshacer un retiro mal anotado. Pide confirmación porque mueve plata, y no
// borra nada: el movimiento queda con status void, que es como se anula
// cualquier cosa en este sistema.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { anularRetiro } from "@/lib/actions/retiros";
import type { EmpresaSlug } from "@/lib/empresas";

export function AnularRetiro({
  empresa, movementId, quien,
}: {
  empresa: EmpresaSlug;
  movementId: string;
  quien: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Anular este retiro"
      >
        <Trash2 className="size-3.5" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>¿Anular el retiro?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          El retiro de {quien} deja de contar en la caja. El movimiento no se
          borra: queda anulado y se puede ver en Movimientos.
        </p>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button
            size="sm" disabled={pending}
            onClick={() => startTransition(async () => {
              const res = await anularRetiro(empresa, movementId);
              if (res?.error) { toast.error(res.error); return; }
              setOpen(false);
              toast.success("Retiro anulado");
              router.refresh();
            })}
          >
            {pending ? "Anulando…" : "Anular"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

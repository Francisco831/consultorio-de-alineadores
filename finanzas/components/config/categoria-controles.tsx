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
import { crearCategoria, toggleCategoria } from "@/lib/actions/config";
import type { EmpresaSlug } from "@/lib/empresas";

export function CategoriaNueva({ empresa }: { empresa: EmpresaSlug }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    startTransition(async () => {
      const cb = String(fd.get("costBehavior") ?? "");
      const res = await crearCategoria({
        empresa,
        name: String(fd.get("name")),
        flow: String(fd.get("flow")) as "income" | "expense",
        costBehavior: cb === "fixed" || cb === "variable" ? cb : null,
      });
      if (res?.error) toast.error(res.error);
      else {
        toast.success("Categoría creada");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
        + Nueva categoría
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Nueva categoría</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
          <div className="space-y-1.5">
            <Label htmlFor="name">Nombre</Label>
            <Input id="name" name="name" required autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Flujo</Label>
              <CampoSelect name="flow" defaultValue="expense"
                opciones={[
                  { value: "expense", label: "Egreso" },
                  { value: "income", label: "Ingreso" },
                ]} />
            </div>
            <div className="space-y-1.5">
              <Label>Comportamiento</Label>
              <CampoSelect name="costBehavior" placeholder="—"
                opciones={[
                  { value: "fixed", label: "Fijo" },
                  { value: "variable", label: "Variable" },
                ]} />
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Creando…" : "Crear"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CategoriaToggle({
  empresa, id, activa, esSistema,
}: {
  empresa: EmpresaSlug; id: string; activa: boolean; esSistema: boolean;
}) {
  const [pending, startTransition] = useTransition();
  if (esSistema) return null;
  return (
    <button
      className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await toggleCategoria(empresa, id, !activa);
          if (res?.error) toast.error(res.error);
        })
      }
    >
      {activa ? "Desactivar" : "Activar"}
    </button>
  );
}

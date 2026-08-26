"use client";

// La libreta personal: se escribe, se tacha y se borra. Componente autónomo —
// recibe las filas ya leídas por la página (/hoy la propia, /panel?u= la de otro).
//
// `editable` es la única distinción que importa: en la libreta ajena no hay
// checkbox ni X ni formulario, porque RLS (0039) tampoco lo dejaría pasar y no
// tiene sentido ofrecer un botón que va a fallar.
//
// El orden lo define la query de la página (order orden asc, created_at asc, que
// es el índice de 0039): acá solo se separan los tachados para mandarlos al final.

import { useRef, useState, useTransition } from "react";
import { Check, Loader2, Plus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  borrarPendiente,
  crearPendiente,
  togglePendiente,
} from "@/lib/actions/pendientes";
import type { Pendiente } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Arriba de 3 tachados la lista empieza a tapar lo que falta hacer. */
const MAX_HECHOS_A_LA_VISTA = 3;

type Resultado = { error?: string; ok?: boolean };

export function PendientesCard({
  pendientes,
  editable,
}: {
  pendientes: Pendiente[];
  editable: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [agregado, setAgregado] = useState(false);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  const abiertos = pendientes.filter((p) => !p.hecho);
  const hechos = pendientes.filter((p) => p.hecho);
  const colapsar = hechos.length > MAX_HECHOS_A_LA_VISTA;
  // los tachados van al final; si son muchos se guardan en el <details>
  const visibles = colapsar ? abiertos : [...abiertos, ...hechos];

  function enviar(
    action: (fd: FormData) => Promise<Resultado>,
    fd: FormData
  ) {
    setError(null);
    setAgregado(false);
    startTransition(async () => {
      const res = await action(fd);
      if (res?.error) setError(res.error);
    });
  }

  function alta(fd: FormData) {
    setError(null);
    setAgregado(false);
    startTransition(async () => {
      const res = await crearPendiente(fd);
      if (res?.error) {
        setError(res.error);
        return;
      }
      formRef.current?.reset();
      setAgregado(true);
      setTimeout(() => setAgregado(false), 3000);
    });
  }

  function renglon(p: Pendiente) {
    return (
      <li key={p.id} className="group flex items-center gap-2 px-3 py-2">
        {editable ? (
          <form action={(fd) => enviar(togglePendiente, fd)}>
            <input type="hidden" name="id" value={p.id} />
            <input type="hidden" name="hecho" value={p.hecho ? "false" : "true"} />
            <Button
              type="submit"
              size="icon-xs"
              variant="ghost"
              title={p.hecho ? "Destachar" : "Tachar"}
            >
              {p.hecho ? (
                <Check className="text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Square className="text-muted-foreground" />
              )}
            </Button>
          </form>
        ) : (
          <span className="flex size-6 shrink-0 items-center justify-center">
            {p.hecho ? (
              <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Square className="size-3 text-muted-foreground" />
            )}
          </span>
        )}

        <span
          className={cn(
            "min-w-0 flex-1 text-sm wrap-anywhere",
            p.hecho && "line-through opacity-60"
          )}
        >
          {p.texto}
        </span>

        {editable ? (
          <form action={(fd) => enviar(borrarPendiente, fd)}>
            <input type="hidden" name="id" value={p.id} />
            <Button
              type="submit"
              size="icon-xs"
              variant="ghost"
              title="Borrar"
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X />
            </Button>
          </form>
        ) : null}
      </li>
    );
  }

  return (
    <div className="space-y-3">
      {pendientes.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {editable
            ? "Sin pendientes. Anotá lo que tengas que hacer hoy."
            : "Sin pendientes anotados."}
        </p>
      ) : null}

      {visibles.length > 0 ? (
        <ul className="divide-y rounded-lg border">{visibles.map(renglon)}</ul>
      ) : null}

      {colapsar ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Hechos · {hechos.length}
          </summary>
          <ul className="mt-2 divide-y rounded-lg border">
            {hechos.map(renglon)}
          </ul>
        </details>
      ) : null}

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {editable ? (
        <form ref={formRef} action={alta} className="flex items-center gap-2">
          <Input
            name="texto"
            placeholder="Anotá un pendiente…"
            autoComplete="off"
            maxLength={500}
            aria-label="Nuevo pendiente"
          />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <>
                <Plus data-icon="inline-start" />
                Agregar
              </>
            )}
          </Button>
          {agregado ? (
            <span className="flex shrink-0 items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
              <Check className="h-4 w-4" /> Anotado
            </span>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

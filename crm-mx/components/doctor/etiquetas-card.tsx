"use client";

// Las etiquetas del doctor, cargadas a mano. Pedido del grupo México (11/9):
// listas como "los que van al Summit" sin revisar ficha por ficha. Cada chip
// es un link a la lista filtrada por esa etiqueta, así se ve enseguida
// "quiénes más tienen esta". Las del sistema (imports, censo de Instagram) se
// muestran apagadas y no se borran desde acá.

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agregarEtiqueta, quitarEtiqueta } from "@/lib/actions/doctors";
import {
  esEtiquetaDelSistema,
  etiquetaLegible,
  normalizarEtiqueta,
} from "@/lib/etiquetas";

export function EtiquetasCard({
  doctorId,
  tags,
  sugerencias,
  acreditado,
}: {
  doctorId: string;
  tags: string[];
  /** etiquetas que ya usa el equipo en otras fichas, para no inventar variantes */
  sugerencias: string[];
  /** define a qué lista lleva el chip: /doctores o /prospeccion/lista */
  acreditado: boolean;
}) {
  const [lista, setLista] = useState<string[]>(tags);
  const [texto, setTexto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const delEquipo = lista.filter((t) => !esEtiquetaDelSistema(t));
  const delSistema = lista.filter(esEtiquetaDelSistema);
  const listaHref = (t: string) =>
    `${acreditado ? "/doctores" : "/prospeccion/lista"}?tag=${encodeURIComponent(t)}`;
  // lo que va a quedar guardado, para que no sorprenda
  const normalizada = normalizarEtiqueta(texto);

  function agregar(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await agregarEtiqueta(fd);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setLista(res.tags);
      setTexto("");
      inputRef.current?.focus();
    });
  }

  function quitar(tag: string) {
    setError(null);
    const fd = new FormData();
    fd.set("id", doctorId);
    fd.set("tag", tag);
    startTransition(async () => {
      const res = await quitarEtiqueta(fd);
      if ("error" in res) setError(res.error);
      else setLista(res.tags);
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {delEquipo.map((t) => (
          <Badge key={t} variant="secondary" className="gap-1 pr-1 font-normal">
            <Link
              href={listaHref(t)}
              title={`Ver todos los doctores con “${t}”`}
              className="hover:underline"
            >
              {etiquetaLegible(t)}
            </Link>
            <button
              type="button"
              onClick={() => quitar(t)}
              disabled={pending}
              aria-label={`Quitar la etiqueta ${t}`}
              className="rounded-full p-0.5 hover:bg-foreground/10"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {delSistema.map((t) => (
          <Badge
            key={t}
            variant="outline"
            className="font-normal text-muted-foreground"
            title="La pone el sistema (imports y censo de Instagram); no se borra desde la ficha"
          >
            {t}
          </Badge>
        ))}
        {lista.length === 0 ? (
          <span className="text-sm text-muted-foreground">Sin etiquetas todavía.</span>
        ) : null}
      </div>

      <form action={agregar} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={doctorId} />
        <Input
          ref={inputRef}
          name="tag"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          list="etiquetas-sugeridas"
          placeholder="Nueva etiqueta: summit-2026, interesado-escaner…"
          className="h-9 w-72"
          maxLength={60}
          autoComplete="off"
        />
        <datalist id="etiquetas-sugeridas">
          {sugerencias.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Button type="submit" size="sm" variant="outline" disabled={pending || !normalizada}>
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Plus data-icon="inline-start" />
              Agregar
            </>
          )}
        </Button>
        {normalizada && normalizada !== texto.trim() ? (
          <span className="text-xs text-muted-foreground">
            se guarda como <code>{normalizada}</code>
          </span>
        ) : null}
      </form>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

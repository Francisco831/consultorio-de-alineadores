"use client";

// Las notas de un evento, que se corrigen en el mismo lugar donde se leen.
// Pedido de Pancho (31/8): "necesito en el CRM poder modificar las notas".
// Antes de la migración 0051 corregir una nota era borrar el evento y volver a
// cargarlo con toda la lista de asistentes atrás. Molde: observaciones-card.
//
// Va inline y no en un diálogo porque acá ya estamos adentro del evento
// desplegado: abrir una ventana encima para tocar dos palabras sobra.
// Solo se muestra en los eventos que cargó quien está mirando — la policy
// events_update no deja tocar los ajenos, y ofrecer un textarea que la base va
// a rechazar es prometer algo que no se cumple.

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { actualizarNotasEvento } from "@/lib/actions/events";

// El mismo tope que valida actualizarNotasEvento: de un archivo "use server" no
// se pueden exportar constantes. Acá frena el pegado largo en el momento.
const MAX = 2000;

export function NotasEvento({
  eventoId,
  notas,
}: {
  eventoId: string;
  notas: string | null;
}) {
  const [texto, setTexto] = useState(notas ?? "");
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [pending, startTransition] = useTransition();

  // "sucio" = lo que hay en pantalla difiere de lo último confirmado por el
  // server. Sin esto el botón queda habilitado siempre y no se sabe si guardó.
  const [ultimoGuardado, setUltimoGuardado] = useState(notas ?? "");
  const sucio = texto.trim() !== ultimoGuardado.trim();

  // En la lista hay un formulario de estos por evento, así que el id del evento
  // va adentro del htmlFor: sin eso los rótulos apuntarían todos al primero.
  const campoId = `notas-evento-${eventoId}`;

  function submit(fd: FormData) {
    setError(null);
    setGuardado(false);
    startTransition(async () => {
      const res = await actualizarNotasEvento(fd);
      if (res?.error) {
        setError(res.error);
        return;
      }
      setUltimoGuardado(texto);
      setGuardado(true);
      setTimeout(() => setGuardado(false), 4000);
    });
  }

  return (
    <form action={submit} className="space-y-2">
      <input type="hidden" name="id" value={eventoId} />
      <div className="space-y-1.5">
        {/* El rótulo no es solo para el lector de pantalla: en un evento propio
            sin notas cargadas esto es un recuadro vacío, y sin encabezado no se
            entiende qué se espera que uno escriba ahí. Mismo estilo que
            "Asistieron", el otro encabezado del evento desplegado. */}
        <Label
          htmlFor={campoId}
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Notas del evento
        </Label>
        <Textarea
          id={campoId}
          name="notas"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          maxLength={MAX}
          rows={2}
          placeholder="Cómo salió, qué se prometió, con quién hay que seguir…"
          className="resize-y"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant="outline" disabled={pending || !sucio}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar corrección"}
        </Button>
        {guardado ? (
          <span className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
            <Check className="h-4 w-4" /> Guardado
          </span>
        ) : null}
        {texto.length > MAX - 200 ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {MAX - texto.length} caracteres
          </span>
        ) : null}
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}

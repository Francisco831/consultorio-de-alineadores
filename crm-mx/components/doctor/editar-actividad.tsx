"use client";

// El lápiz para corregir una actividad, en la misma línea de tiempo donde se
// lee. Pedido de Pancho (31/8): "necesito en el CRM poder modificar las notas,
// por ejemplo Rocío subió una y la quiere modificar".
//
// Aparece SOLO en las notas propias, y esa decisión la toma la página al armar
// los eventos. No es cosmética: la regla de fondo es de la base (el guard de la
// migración 0051 rechaza el texto de otro), y ofrecer un botón que la base va a
// rechazar es prometer algo que no se puede cumplir. Borrar no existe a
// propósito — lo que se cargó se corrige, no se hace desaparecer.

import { useState, useTransition } from "react";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { editarActividad } from "@/lib/actions/activities";

// Los mismos topes que valida editarActividad en lib/actions/activities.ts.
// Están repetidos porque de un archivo "use server" no se pueden exportar
// constantes; acá sirven para frenar el pegado de un párrafo en el momento y no
// después de mandarlo. Si tocás uno, tocá el otro.
const MAX_SUMMARY = 2000;
const MAX_OUTCOME = 500;

export function EditarActividad({
  actividadId,
  summary,
  outcome,
}: {
  actividadId: string;
  summary: string | null;
  outcome: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [texto, setTexto] = useState(summary ?? "");
  const [resultado, setResultado] = useState(outcome ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // "sucio" = lo que hay en pantalla difiere de lo guardado. Sin esto el botón
  // queda habilitado siempre e invita a mandar una corrección que no corrige
  // nada — y cada UPDATE deja su renglón en el audit de 0051.
  const sucio =
    texto.trim() !== (summary ?? "").trim() ||
    resultado.trim() !== (outcome ?? "").trim();

  // Cerrar sin guardar descarta lo tipeado: lo que vale es lo que está en la
  // base, y al reabrir tiene que verse eso y no un borrador de hace media hora.
  //
  // Mientras está guardando, en cambio, no se cierra: el Dialog se va con
  // Escape o con un click afuera, y si la respuesta viene con error —el candado
  // de autor, el token vencido— la ventana ya no está para mostrarlo y lo
  // escrito se perdió sin que nadie avise. Se espera la respuesta, que tarda lo
  // que tarda un update.
  function abrir(o: boolean) {
    if (!o && pending) return;
    if (!o) {
      setTexto(summary ?? "");
      setResultado(outcome ?? "");
      setError(null);
    }
    setOpen(o);
  }

  // Al guardar bien se cierra el diálogo y el renglón corregido queda a la
  // vista: por eso acá no va el "Guardado" verde que sí tienen las notas del
  // doctor y las del evento. Ahí el formulario se queda en pantalla y sin el
  // cartel no se sabría si guardó; acá el cartel se apagaría junto con la
  // ventana, sin que nadie llegue a leerlo.
  function submit(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await editarActividad(fd);
      if (res?.error) {
        setError(res.error);
        return;
      }
      setOpen(false);
    });
  }

  return (
    <>
      {/* Se esconde hasta que el mouse pasa por el renglón, como la X de la
          libreta de pendientes: la línea de tiempo se lee mucho más de lo que se
          corrige. El focus-visible es para que se llegue igual con el teclado. */}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        title="Corregir esta nota"
        onClick={() => abrir(true)}
        className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Pencil />
      </Button>

      <Dialog open={open} onOpenChange={abrir}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Corregir lo que anotaste</DialogTitle>
            <DialogDescription>
              Se corrige el texto. La fecha, el tipo y el doctor quedan como se
              cargaron, y en la línea de tiempo va a figurar como corregida.
            </DialogDescription>
          </DialogHeader>
          <form action={submit} className="space-y-3">
            <input type="hidden" name="id" value={actividadId} />
            <div className="space-y-1.5">
              {/* los id llevan el de la actividad adentro: en el timeline hay un
                  formulario de estos por renglón */}
              <Label htmlFor={`ea-${actividadId}-summary`}>Resumen</Label>
              <Textarea
                id={`ea-${actividadId}-summary`}
                name="summary"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                maxLength={MAX_SUMMARY}
                rows={3}
                placeholder="Qué pasó…"
                className="resize-y"
              />
              {/* recién avisa cuando quedan menos de 200: antes es ruido */}
              {texto.length > MAX_SUMMARY - 200 ? (
                <p className="text-right text-xs text-muted-foreground tabular-nums">
                  {MAX_SUMMARY - texto.length} caracteres
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`ea-${actividadId}-outcome`}>
                Resultado (opcional)
              </Label>
              <Input
                id={`ea-${actividadId}-outcome`}
                name="outcome"
                value={resultado}
                onChange={(e) => setResultado(e.target.value)}
                maxLength={MAX_OUTCOME}
                placeholder="Interesada, pide precio…"
              />
              {resultado.length > MAX_OUTCOME - 200 ? (
                <p className="text-right text-xs text-muted-foreground tabular-nums">
                  {MAX_OUTCOME - resultado.length} caracteres
                </p>
              ) : null}
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending || !sucio}>
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Guardar corrección"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

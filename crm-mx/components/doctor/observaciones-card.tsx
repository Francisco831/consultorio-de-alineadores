"use client";

// Las notas libres del doctor. Sin diálogo ni botón "Editar": el textarea está
// siempre ahí y se guarda con un click. Pedido de Pancho (26/8): "datos de
// colores... que se pueda completar a mano". Si anotar cuesta tres clicks, nadie
// anota, y el brief previo a la llamada se queda sin lo único que no puede
// deducir solo.

import { useRef, useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { updateDoctorObservaciones } from "@/lib/actions/doctors";

const MAX = 2000;

export function ObservacionesCard({
  doctorId,
  observaciones,
}: {
  doctorId: string;
  observaciones: string | null;
}) {
  const [texto, setTexto] = useState(observaciones ?? "");
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  // "sucio" = lo que hay en pantalla difiere de lo último confirmado por el
  // server. Sin esto el botón queda habilitado siempre y no se sabe si guardó.
  const [ultimoGuardado, setUltimoGuardado] = useState(observaciones ?? "");
  const sucio = texto.trim() !== ultimoGuardado.trim();

  function submit(fd: FormData) {
    setError(null);
    setGuardado(false);
    startTransition(async () => {
      const res = await updateDoctorObservaciones(fd);
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
    <form ref={formRef} action={submit} className="space-y-2">
      <input type="hidden" name="id" value={doctorId} />
      <Textarea
        name="observaciones"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        maxLength={MAX}
        rows={3}
        placeholder="Lo que quieras recordar de este doctor: cómo prefiere que le hablen, qué le molestó, con quién trabaja, qué le prometiste…"
        className="resize-y"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || !sucio}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar nota"}
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

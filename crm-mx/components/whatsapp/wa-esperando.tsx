"use client";

// El bloque "WhatsApp esperando respuesta", uno solo para /hoy y /panel. Hasta
// el 26/8 estaba copiado a mano en las dos páginas y ya se habían separado
// (/hoy no sabía mostrar el bucket "hace más de 30 días").
//
// Dice tres cosas que antes el CRM se guardaba:
//   · qué fue lo último que escribió el doctor (así se decide sin abrir nada),
//   · en qué línea de Periskope vive el chat — un mismo chat puede pasar por
//     varias: de 1.487 chats, 320 tienen dos o más (26/8). Si no pasa por la
//     tuya, el link te abre la consola en la línea equivocada (ver lib/phone.ts),
//   · si la lista está viva o es la foto vieja del export del 7/8.
//
// Si no hay nada esperando devuelve null: las páginas pueden montarlo sin
// preguntar antes.

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { marcarRespondido } from "@/lib/actions/whatsapp";
import { lineaCorta, lineaPropia, periskopeLink, waLink } from "@/lib/phone";
import { cn } from "@/lib/utils";

export type WaEsperando = {
  id: string;
  periskope_chat_id: string | null;
  phone: string | null;
  chat_name: string | null;
  activity_bucket: string | null;
  lineas: string[] | null;
  last_message_body: string | null;
  last_message_at: string | null;
  doctor: { id: string; nombre: string; whatsapp: string | null } | null;
};

/** La línea del chat, y si es la mía. Discreto: un badge y, como mucho, un aviso. */
function LineaBadge({
  lineas,
  miLinea,
}: {
  lineas: string[] | null;
  miLinea: string | null;
}) {
  const cortas = (lineas ?? [])
    .map((l) => lineaCorta(l))
    .filter((c): c is string => c !== null);
  if (cortas.length === 0) return null;

  const propia = lineaPropia(lineas, miLinea);
  const una = cortas.length === 1;

  return (
    <>
      <Badge
        variant={propia ? "secondary" : "outline"}
        className={cn(
          "font-normal",
          propia ? "text-emerald-700 dark:text-emerald-400" : null
        )}
        title={
          una
            ? `Este chat vive en la línea …${cortas[0]}`
            : `Este chat vive en varias líneas: ${cortas
                .map((c) => `…${c}`)
                .join(" · ")}`
        }
      >
        {una ? `línea …${cortas[0]}` : `en ${cortas.length} líneas`}
      </Badge>
      {propia === false ? (
        <span
          className="text-amber-700 dark:text-amber-400"
          title="Periskope abre la línea que dejaste elegida la última vez; para ver este chat vas a tener que cambiarla en el selector de arriba."
        >
          no pasa por tu línea
        </span>
      ) : null}
    </>
  );
}

export function WaEsperandoLista({
  chats,
  miLinea,
  titulo,
  total,
}: {
  chats: WaEsperando[];
  miLinea: string | null;
  titulo?: string;
  total?: number;
}) {
  const [hechos, setHechos] = useState<string[]>([]);
  const [corriendo, setCorriendo] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; msg: string } | null>(null);
  const [, startTransition] = useTransition();

  if (chats.length === 0) return null;

  // Ningún chat con last_message_at = el webhook nunca procesó un evento, así
  // que lo que se ve es el export congelado. Decirlo, no dejarlo parecer vivo.
  const sinDatosFrescos = chats.every((c) => !c.last_message_at);

  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {titulo ?? "WhatsApp esperando respuesta"}
          {total != null && total > chats.length ? (
            <span className="ml-1.5 font-normal normal-case tracking-normal">
              · {chats.length} de {total}
            </span>
          ) : null}
        </h2>
        <p className="text-xs text-muted-foreground">
          El doctor habló último y nadie le contestó. El botón abre el chat en
          Periskope.
        </p>
      </div>

      {sinDatosFrescos ? (
        <p className="rounded-lg border border-dashed border-amber-500/60 p-3 text-xs text-amber-700 dark:text-amber-400">
          Foto del 7/8: esta lista no se actualiza sola. El webhook está
          armado y dado de alta, pero Periskope no despacha eventos porque
          tiene la cuenta mal provisionada (figura Enterprise, la tratan como
          free). Espera el reclamo a su soporte.{" "}
          <Link href="/ajustes" className="underline underline-offset-2">
            Ver el estado
          </Link>
        </p>
      ) : null}

      <ul className="divide-y rounded-lg border bg-card">
        {chats.map((c) => {
          // el equipo responde desde Periskope, no desde el WhatsApp personal
          const link =
            periskopeLink(c.periskope_chat_id) ??
            waLink(c.phone ?? c.doctor?.whatsapp ?? null);
          const hecho = hechos.includes(c.id);
          const nombre =
            c.doctor?.nombre ?? c.chat_name ?? c.phone ?? "Chat sin nombre";
          return (
            <li
              key={c.id}
              className={cn("px-3 py-2 text-sm", hecho ? "opacity-60" : null)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {c.doctor ? (
                    <Link
                      href={`/doctores/${c.doctor.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {c.doctor.nombre}
                    </Link>
                  ) : (
                    <span className="block truncate font-medium">{nombre}</span>
                  )}
                  {c.last_message_body ? (
                    <p className="line-clamp-1 text-xs text-muted-foreground">
                      «{c.last_message_body}»
                    </p>
                  ) : null}
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {c.activity_bucket === "7d" ? (
                      <span className="font-medium text-orange-600 dark:text-orange-400">
                        activo esta semana
                      </span>
                    ) : c.activity_bucket === "30d" ? (
                      <span>últimos 30 días</span>
                    ) : (
                      <span>hace más de 30 días</span>
                    )}
                    <LineaBadge lineas={c.lineas} miLinea={miLinea} />
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {link ? (
                    <a
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(
                        buttonVariants({ variant: "outline", size: "sm" })
                      )}
                    >
                      Responder
                    </a>
                  ) : null}
                  <form
                    action={(fd) => {
                      setError(null);
                      setCorriendo(c.id);
                      startTransition(async () => {
                        const res = await marcarRespondido(fd);
                        setCorriendo(null);
                        if ("error" in res) {
                          setError({ id: c.id, msg: res.error });
                          return;
                        }
                        setHechos((prev) => [...prev, c.id]);
                      });
                    }}
                  >
                    <input type="hidden" name="chat_id" value={c.id} />
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      disabled={corriendo === c.id || hecho}
                      title="Ya le contestamos: sacarlo de la lista"
                    >
                      {corriendo === c.id ? (
                        <Loader2
                          data-icon="inline-start"
                          className="animate-spin"
                        />
                      ) : (
                        <Check data-icon="inline-start" />
                      )}
                      Ya respondí
                    </Button>
                  </form>
                </div>
              </div>
              {error?.id === c.id ? (
                <p className="mt-1 text-sm text-red-600">{error.msg}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

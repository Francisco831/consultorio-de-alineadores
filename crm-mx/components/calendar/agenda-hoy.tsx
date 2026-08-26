// La agenda del día de Google Calendar, con el brief del doctor pegado a cada
// llamada: la idea es que nadie tenga que abrir la ficha antes de atender.
//
// Es server component a propósito: no tiene estado ni formularios, solo links.
// Los eventos SIN doctor igual se muestran (una reunión interna, un turno
// personal): el valor de la agenda es que esté completa, no que esté filtrada.

import Link from "next/link";
import { MessageCircle, Phone } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { waLink, telLink } from "@/lib/phone";
import { cn } from "@/lib/utils";

export type EventoAgenda = {
  id: string;
  titulo: string;
  inicio: string;
  fin: string | null;
  todo_el_dia: boolean;
  doctor: {
    id: string;
    nombre: string;
    phone: string | null;
    whatsapp: string | null;
  } | null;
  /** Las 3 oraciones de briefDoctor(). null cuando el evento no tiene doctor. */
  brief: string[] | null;
};

// el CRM vive en México: la hora se muestra SIEMPRE en ese huso, aunque quien
// mire esté en Buenos Aires (Pancho) y el server corra en UTC
const HORA_MX = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function franja(ev: EventoAgenda): string {
  if (ev.todo_el_dia) return "Todo el día";
  const desde = HORA_MX.format(new Date(ev.inicio));
  if (!ev.fin) return desde;
  return `${desde}–${HORA_MX.format(new Date(ev.fin))}`;
}

export function AgendaHoy({ eventos }: { eventos: EventoAgenda[] }) {
  if (eventos.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Agenda de hoy
      </h2>
      <ul className="divide-y rounded-lg border">
        {eventos.map((ev) => {
          const wa = ev.doctor ? waLink(ev.doctor.whatsapp ?? ev.doctor.phone) : null;
          const tel = ev.doctor ? telLink(ev.doctor.phone ?? ev.doctor.whatsapp) : null;
          return (
            <li key={ev.id} className="flex gap-3 p-3">
              <span className="w-24 shrink-0 pt-0.5 text-sm tabular-nums text-muted-foreground">
                {franja(ev)}
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{ev.titulo}</p>
                    {ev.doctor ? (
                      <Link
                        href={`/doctores/${ev.doctor.id}`}
                        className="text-xs text-muted-foreground hover:underline"
                      >
                        Ficha de {ev.doctor.nombre}
                      </Link>
                    ) : null}
                  </div>
                  {wa || tel ? (
                    <div className="flex shrink-0 gap-1">
                      {wa ? (
                        <a
                          href={wa}
                          target="_blank"
                          rel="noreferrer"
                          title="WhatsApp"
                          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                        >
                          <MessageCircle className="h-4 w-4" />
                        </a>
                      ) : null}
                      {tel ? (
                        <a
                          href={tel}
                          title="Llamar"
                          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                        >
                          <Phone className="h-4 w-4" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {ev.brief?.length ? (
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {ev.brief.map((oracion, i) => (
                      <li key={i}>{oracion}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

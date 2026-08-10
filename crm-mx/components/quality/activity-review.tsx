// Cola de clasificación de interacciones: ¿hubo conversación real o fue un toque?
//
// El tipo de actividad NO alcanza para decidirlo (una llamada puede ser "te
// llamo la semana que viene" y un WhatsApp puede ser la discusión completa de un
// caso), así que la migración 0022 dejó todo el histórico en UNKNOWN. Mientras
// siga UNKNOWN, el reloj de contacto significativo no corre — y ausencia de
// registro no es ausencia de contacto.
//
// Server Component: botones = submits de un <form> con server action.

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { classifyActivity } from "@/lib/actions/quality";
import { formatDate } from "@/lib/format";
import { ACTIVITY_TYPE_LABELS, type ActivityType } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ActivityReviewRow {
  id: string;
  doctor_id: string | null;
  doctor_nombre: string | null;
  type: string;
  occurred_at: string;
  summary: string | null;
  outcome: string | null;
}

const OPTIONS: { value: string; label: string; title: string }[] = [
  {
    value: "MEANINGFUL",
    label: "Conversación real",
    title:
      "Se habló de algo sustantivo: un caso, una objeción, una propuesta, una capacitación, un problema o una próxima acción",
  },
  {
    value: "LOW_TOUCH",
    label: "Toque",
    title: "Saludo, recordatorio, invitación masiva: no resetea el reloj de contacto",
  },
  {
    value: "UNKNOWN",
    label: "No se puede saber",
    title: "Queda registrado que se revisó y el texto no alcanza para decidirlo",
  },
];

function typeLabel(type: string): string {
  return ACTIVITY_TYPE_LABELS[type as ActivityType] ?? type;
}

export function ActivityReview({
  rows,
  pending,
}: {
  rows: ActivityReviewRow[];
  pending: number | null;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No queda ninguna interacción sin clasificar.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {pending != null
          ? `${pending.toLocaleString("es-MX")} interacciones sin clasificar`
          : "Pendientes sin medir"}
        {" · "}
        mostrando {rows.length}, las más recientes primero.
      </p>
      <ul className="divide-y rounded-lg border">
        {rows.map((a) => (
          <li
            key={a.id}
            className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {a.doctor_id ? (
                  <Link
                    href={`/doctores/${a.doctor_id}`}
                    className="font-medium hover:underline"
                  >
                    {a.doctor_nombre ?? "Doctor sin nombre"}
                  </Link>
                ) : (
                  <span className="font-medium">Sin doctor</span>
                )}
                <span className="text-muted-foreground">{typeLabel(a.type)}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(a.occurred_at)}
                </span>
              </div>
              <p className="line-clamp-2 max-w-2xl text-xs text-muted-foreground">
                {a.summary ?? "Sin resumen cargado"}
                {a.outcome ? ` — ${a.outcome}` : ""}
              </p>
            </div>

            <form action={classifyActivity} className="flex flex-wrap gap-1.5">
              <input type="hidden" name="activity_id" value={a.id} />
              {OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="submit"
                  name="engagement_quality"
                  value={o.value}
                  title={o.title}
                  className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
                >
                  {o.label}
                </button>
              ))}
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}

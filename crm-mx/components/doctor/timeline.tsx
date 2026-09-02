import {
  Phone,
  MessageCircle,
  MapPin,
  Users,
  Stethoscope,
  Mail,
  StickyNote,
  CalendarHeart,
  FolderOpen,
  ArrowRightLeft,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EditarActividad } from "@/components/doctor/editar-actividad";
import { formatDate, relativeDays } from "@/lib/format";

export interface TimelineEvent {
  id: string;
  kind: string; // activity_type | 'caso' | 'cambio'
  date: string;
  title: string;
  detail?: string | null;
  actor?: string;
  isDemo?: boolean;
  /**
   * La nota se corrigió después de cargarse (migración 0051). Va aparte de
   * `editable` a propósito: la señal tiene que verse también en las notas de
   * otro, que son justo las que Pancho lee para saber cómo viene el equipo.
   */
  edited?: boolean;
  /**
   * Presente solo en las actividades que escribió quien está mirando la ficha:
   * es lo que hace falta para corregirlas sin salir del renglón. Ausente en los
   * hitos de casos, en los cambios auditados, en las notas de otra persona y en
   * las que trajo el sync sin autor — a esas la base no las deja tocar.
   */
  editable?: {
    /** el id de `activities`, sin el prefijo `a-` con el que se arma `id` */
    activityId: string;
    summary: string | null;
    outcome: string | null;
  };
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  llamada: Phone,
  whatsapp: MessageCircle,
  visita: MapPin,
  reunion: Users,
  revision_clinica: Stethoscope,
  email: Mail,
  nota: StickyNote,
  keepday: CalendarHeart,
  caso: FolderOpen,
  cambio: ArrowRightLeft,
};

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Sin interacciones registradas todavía. Registrá la primera con
        “Actividad” en las acciones rápidas.
      </p>
    );
  }
  return (
    <ol className="relative space-y-0 border-l pl-0">
      {events.map((e) => {
        const Icon = ICONS[e.kind] ?? StickyNote;
        return (
          // `group` es lo que hace aparecer el lápiz al pasar por el renglón
          <li key={e.id} className="group relative flex gap-3 py-2.5 pl-5">
            <span className="absolute -left-[9px] top-3 flex h-[18px] w-[18px] items-center justify-center rounded-full border bg-background">
              <Icon className="h-2.5 w-2.5 text-muted-foreground" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm">{e.title}</span>
                {e.isDemo ? (
                  <Badge
                    variant="outline"
                    className="h-4 px-1 text-[10px] font-normal text-muted-foreground"
                  >
                    demo
                  </Badge>
                ) : null}
              </div>
              {e.detail ? (
                <p className="text-sm text-muted-foreground">{e.detail}</p>
              ) : null}
              <p
                className="text-xs text-muted-foreground/80"
                title={formatDate(e.date)}
              >
                {relativeDays(e.date)}
                {e.actor ? ` · ${e.actor}` : ""}
                {/* sobrio y en el mismo gris que la fecha: avisa que el texto
                    cambió, no acusa a nadie */}
                {e.edited ? " · corregido" : ""}
              </p>
            </div>
            {e.editable ? (
              <EditarActividad
                actividadId={e.editable.activityId}
                summary={e.editable.summary}
                outcome={e.editable.outcome}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

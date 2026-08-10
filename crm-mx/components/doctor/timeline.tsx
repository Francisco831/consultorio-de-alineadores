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
import { formatDate, relativeDays } from "@/lib/format";

export interface TimelineEvent {
  id: string;
  kind: string; // activity_type | 'caso' | 'cambio'
  date: string;
  title: string;
  detail?: string | null;
  actor?: string;
  isDemo?: boolean;
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
          <li key={e.id} className="relative flex gap-3 py-2.5 pl-5">
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
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

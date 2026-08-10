// Chip de agente AI — server-safe (sin estado). Color por agente, mismo idioma
// visual que los badges de lifecycle/categoría de lib/format.ts.

import { Badge } from "@/components/ui/badge";
import { AGENT_LABELS, type AgentKey } from "@/lib/ai/types";
import { cn } from "@/lib/utils";

const AGENT_STYLES: Record<AgentKey, string> = {
  // SERVICE/TRUST primero: el rojo marca urgencia de servicio
  doctor_success:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-900",
  retention_reactivation:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-900",
  activation:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-900",
  growth:
    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-900",
  clinical_education:
    "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-400 dark:border-violet-900",
  accreditation:
    "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950 dark:text-cyan-400 dark:border-cyan-900",
  acquisition:
    "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  commercial_director:
    "bg-[#001d57] text-white border-[#001d57] dark:bg-[#cbf2fe] dark:text-[#001d57] dark:border-[#cbf2fe]",
  orchestrator: "bg-muted text-muted-foreground border-transparent",
};

export function AgentBadge({
  agent,
  className,
  title,
}: {
  agent: AgentKey;
  className?: string;
  title?: string;
}) {
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        "h-4.5 px-1.5 text-[10px] font-medium tracking-wide",
        AGENT_STYLES[agent],
        className
      )}
    >
      {AGENT_LABELS[agent]}
    </Badge>
  );
}

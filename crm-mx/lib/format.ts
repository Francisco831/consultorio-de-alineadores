import type { DoctorCategoria, LifecycleStage } from "@/lib/types";

const DAY_MS = 86_400_000;

/** "hace 3 días", "hace 2 meses", "hoy" */
export function relativeDays(date: string | null): string {
  if (!date) return "—";
  const days = Math.floor((Date.now() - Date.parse(date)) / DAY_MS);
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;
  const months = Math.floor(days / 30);
  if (months < 12) return `hace ${months} ${months === 1 ? "mes" : "meses"}`;
  const years = Math.floor(days / 365);
  return `hace ${years} ${years === 1 ? "año" : "años"}`;
}

export function daysSince(date: string | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - Date.parse(date)) / DAY_MS);
}

export function formatDate(date: string | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatMXN(amount: number | null): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 0,
  }).format(amount);
}

/** clases tailwind por categoría — color mínimo, comunica jerarquía */
export const CATEGORIA_STYLES: Record<DoctorCategoria, string> = {
  SIN_CATEGORIA: "bg-muted text-muted-foreground border-transparent",
  SILVER: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  GOLD: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-900",
  PLATINUM: "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950 dark:text-cyan-400 dark:border-cyan-900",
  BLACK: "bg-zinc-900 text-zinc-50 border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100",
  ELITE:
    "bg-[#eaf6fe] text-[#001d57] border-[#cbf2fe] dark:bg-[#0e2a5c] dark:text-[#cbf2fe] dark:border-[#1d3f7e]",
};

/** Etapas de producción Noloco → lenguaje del negocio.
 *  I_1 = 1ª etapa del tratamiento (el ÚNICO que cuenta como caso nuevo). */
export function formatEtapa(etapa: string | null): string {
  if (!etapa) return "—";
  const m = etapa.match(/^I_(\d)(_BIS)?$/);
  if (m) return `${m[1]}ª etapa${m[2] ? " (bis)" : ""}`;
  const map: Record<string, string> = {
    CONTENCION: "Contención",
    SUPERPOSICION: "Superposición",
    PASIVAS: "Pasivas",
  };
  return map[etapa] ?? etapa;
}

export function formatTipoTratamiento(tipo: string | null): string {
  if (!tipo) return "—";
  const map: Record<string, string> = {
    ESTANDAR: "Estándar",
    CONTENCION: "Contención",
    SUPERPOSICION: "Superposición",
    PASIVAS: "Pasivas",
  };
  return map[tipo] ?? tipo;
}

export const CATEGORIA_LABELS: Record<DoctorCategoria, string> = {
  SIN_CATEGORIA: "Sin categoría",
  SILVER: "Silver",
  GOLD: "Gold",
  PLATINUM: "Platinum",
  BLACK: "Black",
  ELITE: "Elite",
};

/** el color del lifecycle comunica riesgo/estado, no decoración.
 *  Universo A (no acreditado) en gris→azul; universo B en azul→verde→naranja→rojo. */
const STYLE_GRIS = "bg-muted text-muted-foreground border-transparent";
const STYLE_AZUL = "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-900";
const STYLE_CELESTE = "bg-[#eaf6fe] text-[#001d57] border-[#cbf2fe] dark:bg-[#0e2a5c] dark:text-[#cbf2fe] dark:border-[#1d3f7e]";
const STYLE_VERDE = "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-900";
const STYLE_NARANJA = "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-900";
const STYLE_ROJO = "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-900";

export const LIFECYCLE_STYLES: Record<LifecycleStage, string> = {
  prospecto: STYLE_GRIS,
  contactado: STYLE_GRIS,
  calificacion: STYLE_AZUL,
  interes_acreditacion: STYLE_AZUL,
  acreditacion_agendada: STYLE_CELESTE,
  acreditado: STYLE_CELESTE,
  en_activacion: STYLE_AZUL,
  activado: STYLE_CELESTE,
  activo: STYLE_VERDE,
  growth: STYLE_VERDE,
  en_riesgo: STYLE_NARANJA,
  dormido: STYLE_ROJO,
  reactivado: STYLE_VERDE,
  perdido: STYLE_GRIS,
  acreditacion_pendiente: STYLE_CELESTE,
  acreditado_no_activado: STYLE_AZUL,
};

/** badge central del negocio: en qué universo está el doctor */
export const ACREDITACION_STYLES = {
  si: STYLE_CELESTE,
  no: STYLE_NARANJA,
} as const;

/** verde ≥70, amarillo 40-69, rojo <40 */
export function healthColor(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 70) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 40) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

// El NIVEL DE INTERACCIÓN con soporte (migración 0060): el segundo eje de la
// lista de doctores, independiente del estado (0058). El estado dice si el
// doctor manda casos; este nivel dice si además hay conversación persona a
// persona con la línea de soporte (+54 9 11 2374-0762) o si el vínculo es solo
// transaccional. La casilla la calcula la base en doctors.interaccion con los
// umbrales de automation_rules (key interaccion_soporte), que el equipo edita
// en /ajustes. Acá viven los umbrales por defecto y cómo leerlos, el texto que
// explica los números y la sugerencia que sale de cruzar los dos ejes. Nada de
// esto decide: describe.
import {
  ACTIVITY_TYPE_LABELS,
  type ActivityType,
  type Doctor,
  type Interaccion,
  type Segmento,
} from "@/lib/types";
import { diasEntre, hace } from "@/lib/segmento";

/** La fila de automation_rules que guarda los umbrales. */
export const INTERACCION_RULE_KEY = "interaccion_soporte";

export interface ParamsInteraccion {
  /** Ventana hacia atrás, en días. */
  dias: number;
  /** Línea de soporte, solo dígitos (formato de profiles.periskope_org_phone).
   *  null = cuentan los chats de todas las líneas. */
  linea: string | null;
  /** Mínimos para que los mensajes solos hagan "real": del doctor, nuestros y
   *  días distintos con mensajes. Los tres a la vez. */
  min_del_doctor: number;
  min_nuestros: number;
  min_dias: number;
  /** Contactos registrados que alcanzan solos para "real". 0 = no alcanzan. */
  min_contactos: number;
  /** Qué actividades cuentan como contacto persona a persona. */
  tipos_contacto: ActivityType[];
}

/** Los valores iniciales de 0060 —y la red si la fila no está o viene rota—.
 *  'revision_clinica' queda afuera a propósito (es un pedido de modificación
 *  sobre un caso: transaccional), y 'whatsapp' también (los mensajes ya se
 *  cuentan uno por uno). Mismo criterio que TIPOS_CONTACTO en lib/atribucion.ts. */
export const PARAMS_INTERACCION_DEFAULT: ParamsInteraccion = {
  dias: 90,
  linea: "5491123740762",
  min_del_doctor: 3,
  min_nuestros: 3,
  min_dias: 2,
  min_contactos: 1,
  tipos_contacto: ["llamada", "videollamada", "reunion", "visita", "keepday"],
};

const TIPOS_VALIDOS = Object.keys(ACTIVITY_TYPE_LABELS) as ActivityType[];

function entero(v: unknown, def: number, min: number, max: number): number {
  if (v === null || v === undefined || v === "") return def;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Los params tal como están en la base (o como llegan de un formulario) →
 * completos y válidos. Es la MISMA lectura que hace recompute_interaccion():
 * lo que falta o no es número toma el default, lo que se pasa de rango se
 * recorta, la línea se queda con los dígitos y los tipos con los que existen.
 * Un array vacío de tipos es una elección ("los contactos no cuentan"), no un
 * hueco: se respeta.
 */
export function leerParamsInteraccion(raw: unknown): ParamsInteraccion {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = PARAMS_INTERACCION_DEFAULT;
  const lineaDigitos = r.linea === null || r.linea === undefined
    ? d.linea
    : String(r.linea).replace(/\D/g, "") || null;
  const tipos = Array.isArray(r.tipos_contacto)
    ? (r.tipos_contacto
        .map((t) => String(t))
        .filter((t): t is ActivityType => (TIPOS_VALIDOS as string[]).includes(t)))
    : d.tipos_contacto;
  return {
    dias: entero(r.dias, d.dias, 1, 3650),
    linea: lineaDigitos && lineaDigitos.length >= 11 && lineaDigitos.length <= 15 ? lineaDigitos : lineaDigitos ? d.linea : null,
    min_del_doctor: entero(r.min_del_doctor, d.min_del_doctor, 0, 9999),
    min_nuestros: entero(r.min_nuestros, d.min_nuestros, 0, 9999),
    min_dias: entero(r.min_dias, d.min_dias, 0, 3650),
    min_contactos: entero(r.min_contactos, d.min_contactos, 0, 9999),
    tipos_contacto: Array.from(new Set(tipos)),
  };
}

/** "…0762": cómo se nombra una línea en el resto del CRM. */
export function lineaCorta(linea: string | null): string {
  return linea ? `…${linea.slice(-4)}` : "todas las líneas";
}

type DoctorInteraccion = Pick<
  Doctor,
  | "interaccion"
  | "wa_del_doctor"
  | "wa_nuestros"
  | "wa_dias"
  | "contactos_registrados"
  | "ultimo_wa_at"
>;

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/**
 * Los números de los que sale el nivel, en una línea, para que quien lo lee
 * pueda verificarlo:
 *   "12 mensajes del doctor y 8 nuestros en 3 días · 1 contacto registrado
 *    en 90 días · último WhatsApp hace 2 días"
 *   "sin mensajes por la línea de soporte · sin contactos registrados en 90 días"
 * `hoy` es la fecha de México (lib/dates.ts), nunca la del servidor.
 */
export function explicarInteraccion(
  d: DoctorInteraccion,
  params: Pick<ParamsInteraccion, "dias">,
  hoy: string
): string {
  if (!d.interaccion) return "Todavía sin calcular";
  const partes: string[] = [];
  if (d.wa_del_doctor + d.wa_nuestros > 0) {
    partes.push(
      `${plural(d.wa_del_doctor, "mensaje", "mensajes")} del doctor y ${plural(d.wa_nuestros, "nuestro", "nuestros")} en ${plural(d.wa_dias, "día", "días")}`
    );
  } else {
    partes.push("sin mensajes por la línea de soporte");
  }
  partes.push(
    d.contactos_registrados > 0
      ? `${plural(d.contactos_registrados, "contacto registrado", "contactos registrados")}`
      : "sin contactos registrados"
  );
  let texto = `${partes.join(" · ")} en ${params.dias} días`;
  if (d.ultimo_wa_at) {
    texto += ` · último WhatsApp ${hace(diasEntre(d.ultimo_wa_at, hoy))}`;
  }
  return texto;
}

/**
 * El cruce de los dos ejes: qué hacer con este doctor y por qué, en una línea
 * "Acción · lectura". Es función fija de la casilla —como SEGMENTO_ACCION— y
 * por eso vive acá y no en una columna. Las tres casillas del pedido de Pancho
 * (8/9/2026) son las que más importan:
 *   activo   × sin interacción real → fortalecer el vínculo (solo transaccional)
 *   inactivo × sin contacto         → prioridad de acercamiento
 *   inactivo × real                 → el problema no es de vínculo: otra causa
 */
export const SUGERENCIA_CRUCE: Record<Segmento, Record<Interaccion, string>> = {
  activo: {
    real: "Mantener · manda casos y conversa con soporte",
    puntual: "Fortalecer el vínculo · manda casos, el contacto con soporte es puntual",
    sin_contacto:
      "Fortalecer el vínculo · solo transaccional: manda casos sin conversación con soporte",
  },
  lapsed: {
    real: "Indagar otra causa · hay vínculo con soporte, pero dejó de mandar casos",
    puntual: "Retomar la conversación · dejó de mandar casos y el contacto es puntual",
    sin_contacto: "Acercamiento prioritario · dejó de mandar casos y no hay contacto con soporte",
  },
  beginner: {
    real: "Acompañar hasta el primer caso · recién acreditado y en conversación",
    puntual: "Acompañar más de cerca · recién acreditado, contacto puntual",
    sin_contacto: "Acompañar ya · recién acreditado y sin contacto con soporte",
  },
  inactivo: {
    real: "Indagar otra causa · buena interacción con soporte: el problema no es de vínculo",
    puntual: "Entender qué necesita · no manda casos y el contacto es puntual",
    sin_contacto:
      "Acercamiento prioritario · no manda casos ni tiene contacto con soporte: entender qué necesita o qué está fallando",
  },
};

export function sugerenciaCruce(
  segmento: Segmento | null,
  interaccion: Interaccion | null
): string {
  if (!segmento || !interaccion) return "Todavía sin calcular";
  return SUGERENCIA_CRUCE[segmento][interaccion];
}

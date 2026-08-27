// Brief de 3 oraciones para leer JUSTO ANTES de una llamada: quién es, qué pasó
// y con qué abrir. Lo consume la agenda del día (components/calendar/agenda-hoy).

import { todayMX } from "@/lib/dates";
import { CATEGORIA_LABELS } from "@/lib/format";
import {
  LIFECYCLE_LABELS,
  type DoctorCategoria,
  type LifecycleStage,
} from "@/lib/types";

export type DatosBrief = {
  nombre: string;
  categoria: DoctorCategoria | null;
  city: string | null;
  state: string | null;
  zona: string | null;
  case_count: number | null;
  new_case_count: number | null;
  last_contact_at: string | null;
  avg_interval_days: number | null;
  instagram: string | null;
  specialty: string | null;
  uses_aligners: boolean | null;
  estimated_cases_month: number | null;
  why_interesting: string | null;
  competitor_brands: string[] | null;
  /** Tratamientos que más manda (Estandar, Superposicion…), del más al menos */
  tiposTratamiento: string[] | null;
  /**
   * Cuántos casos de cada tipo comercial: Kids, Teens, Full, Medium, Fast
   * (cases.tipo_caso, migración 0013). Kids y Teens son SEGMENTOS DE PACIENTE;
   * Full/Medium/Fast son duraciones de tratamiento. Por eso el brief solo afirma
   * lo de niños y adolescentes: decir "el resto son adultos" sería una deducción,
   * y encima el campo viene de la ficha de entregas, no del sync — está en 792
   * de 1.050 casos MX. Los números son un PISO, nunca el total.
   */
  tiposCaso: Record<string, number> | null;
  /** Eventos de KeepSmiling a los que asistió (tabla events, vía event_attendees) */
  eventos: { titulo: string; fecha: string }[] | null;
  /** Cumpleaños (doctors.birth_date). Año 1900 = no se sabe, solo día y mes. */
  birth_date: string | null;
  /** Notas libres escritas a mano por el equipo (doctors.observaciones, 0048) */
  observaciones: string | null;
  lifecycle_stage: LifecycleStage | null;
};

/**
 * Convierte un instante ISO a su fecha CALENDARIO en México (YYYY-MM-DD).
 * No está en lib/dates.ts porque ese módulo responde "qué día es hoy acá"; esto
 * traduce un instante cualquiera, que es otra pregunta. Sin esto, un contacto de
 * las 19:00 de México cuenta como del día siguiente (UTC) y el "hace N días"
 * sale corrido.
 */
function fechaMX(iso: string): string {
  // Un YYYY-MM-DD pelado YA es una fecha calendario (así llega events.fecha, que
  // es `date`): pasarlo por new Date() lo lee como medianoche UTC y en México
  // retrocede un día. Se devuelve tal cual.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
  }).format(new Date(iso));
}

/** Días completos entre una fecha ISO y hoy en México. null si no parsea. */
function diasDesde(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const aUTC = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
  return Math.round((aUTC(todayMX()) - aUTC(fechaMX(iso))) / 86_400_000);
}

/** "hoy" · "ayer" · "hace 12 días" · "en 3 días" (para eventos futuros) */
function haceCuanto(dias: number): string {
  if (dias === 0) return "hoy";
  if (dias === 1) return "ayer";
  if (dias < 0) return `en ${-dias} día${dias === -1 ? "" : "s"}`;
  return `hace ${dias} días`;
}

/** Une trozos en una oración: "a, b y c." Sin trozos devuelve "". */
function oracion(trozos: string[]): string {
  const xs = trozos.filter((t) => t.length > 0);
  if (xs.length === 0) return "";
  const texto = xs.join(", ");
  return texto.endsWith(".") ? texto : `${texto}.`;
}

/**
 * Los tipos de tratamiento vienen de Noloco en mayúsculas ("ESTANDAR",
 * "SUPERPOSICION"): tal cual quedan gritando en el medio de la oración.
 */
function capitalizar(s: string): string {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** Los casos estimados por mes vienen con decimales (1.1, 0.5): coma y sin cola */
const NUMERO_MX = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 1 });

/**
 * Edad a partir del cumpleaños. null si no se sabe el año (cargado como 1900,
 * que es la convención de la migración 0040) o si la fecha no parsea.
 */
function edadDe(birth: string | null): number | null {
  if (!birth || !/^\d{4}-\d{2}-\d{2}/.test(birth)) return null;
  const anio = +birth.slice(0, 4);
  if (anio <= 1900) return null;
  const hoy = todayMX();
  let edad = +hoy.slice(0, 4) - anio;
  if (hoy.slice(5) < birth.slice(5, 10)) edad -= 1;
  return edad > 0 && edad < 110 ? edad : null;
}

/** Días hasta el próximo cumpleaños. null si no hay fecha. */
function diasAlCumple(birth: string | null): number | null {
  if (!birth || !/^\d{4}-\d{2}-\d{2}/.test(birth)) return null;
  const hoy = todayMX();
  const anioHoy = +hoy.slice(0, 4);
  // 29/2 en año no bisiesto: se compara contra el 28
  const md = birth.slice(5, 10) === "02-29" ? "02-28" : birth.slice(5, 10);
  const aUTC = (ymd: string) =>
    Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
  let prox = aUTC(`${anioHoy}-${md}`);
  if (prox < aUTC(hoy)) prox = aUTC(`${anioHoy + 1}-${md}`);
  return Math.round((prox - aUTC(hoy)) / 86_400_000);
}

/** Recorta un texto libre de la ficha para que no coma media pantalla */
function recortar(s: string, max = 140): string {
  const t = s.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * EL BRIEF NO PASA POR LA IA — A PROPÓSITO (decisión 26/8/26).
 * Se arma con reglas: es determinista (el mismo doctor da siempre el mismo
 * texto), sale en microsegundos y no cuesta un peso. Un brief que se lee 30
 * segundos antes de atender una llamada no puede depender de una API que a veces
 * tarda 4 segundos, ni puede alucinar un dato sobre un doctor real con la persona
 * ya en la línea. La IA del CRM sigue donde tiene sentido (recomendaciones,
 * morning brief); acá no.
 *
 * REGLA DURA: cada oración se arma SOLO con los datos presentes. Si falta un
 * dato, la oración se ACORTA — nunca se rellena con un supuesto, un promedio ni
 * un "probablemente". Cuando no hay nada que decir, el brief lo dice con todas
 * las letras ("Poca información cargada…") en vez de inventar una excusa para
 * llamar: es preferible que Rocío sepa que va a ciegas a que crea que sabe algo.
 *
 * Devuelve SIEMPRE 3 oraciones: 1) quién es, 2) qué pasó, 3) con qué abrir.
 */
export function briefDoctor(d: DatosBrief): string[] {
  return [quienEs(d), quePaso(d), conQueAbrir(d)];
}

// ---------- 1. QUIÉN ES ----------
function quienEs(d: DatosBrief): string {
  const trozos: string[] = [d.nombre.trim()];

  const categoria =
    d.categoria && d.categoria !== "SIN_CATEGORIA" ? CATEGORIA_LABELS[d.categoria] : null;
  const lugar = d.city ?? d.state ?? d.zona ?? null;
  if (categoria && lugar) trozos.push(`${categoria} de ${lugar}`);
  else if (categoria) trozos.push(categoria);
  else if (lugar) trozos.push(`de ${lugar}`);

  // volumen: lo REAL manda; si todavía no mandó nada, lo estimado y si usa
  // alineadores, que es lo único que se sabe de un prospecto
  const casos = d.case_count ?? 0;
  if (casos > 0) {
    trozos.push(`${casos} caso${casos === 1 ? "" : "s"}`);
    if (d.new_case_count) {
      trozos.push(`${d.new_case_count} nuevo${d.new_case_count === 1 ? "" : "s"}`);
    }
  } else {
    // sin casos, lo que define al doctor es en qué etapa del journey está
    if (d.lifecycle_stage) trozos.push(LIFECYCLE_LABELS[d.lifecycle_stage].toLowerCase());
    if (d.estimated_cases_month) {
      const n = d.estimated_cases_month;
      trozos.push(`estima ${NUMERO_MX.format(n)} caso${n === 1 ? "" : "s"} por mes`);
    }
    else if (d.uses_aligners === true) trozos.push("ya trabaja con alineadores");
    else if (d.uses_aligners === false) trozos.push("todavía no trabaja con alineadores");
    else if (d.case_count === 0) trozos.push("sin casos todavía");
  }

  // segmento de paciente: solo se afirma lo que el dato dice (Kids/Teens). El
  // resto NO se llama "adultos" — sería deducción, y el campo está incompleto.
  const tc = d.tiposCaso ?? {};
  const segmentos: string[] = [];
  if (tc.Kids) segmentos.push(`${tc.Kids} de niños`);
  if (tc.Teens) segmentos.push(`${tc.Teens} de adolescentes`);
  if (segmentos.length) trozos.push(`entre ellos ${segmentos.join(" y ")}`);

  if (d.specialty) trozos.push(d.specialty.toLowerCase());
  const edad = edadDe(d.birth_date);
  if (edad) trozos.push(`${edad} años`);
  if (d.instagram) trozos.push(`@${d.instagram.replace(/^@/, "")}`);

  // solo el nombre = la ficha está vacía, y hay que decirlo
  if (trozos.length === 1) return `${d.nombre.trim()}: la ficha no tiene categoría, ubicación ni casos cargados.`;
  return oracion(trozos);
}

// ---------- 2. QUÉ PASÓ ----------
function quePaso(d: DatosBrief): string {
  const trozos: string[] = [];

  const dias = diasDesde(d.last_contact_at);
  if (dias !== null) trozos.push(`Último contacto ${haceCuanto(dias)}`);

  if (d.avg_interval_days) {
    trozos.push(`ritmo de un caso cada ${Math.round(d.avg_interval_days)} días`);
  }

  const tipos = (d.tiposTratamiento ?? []).filter(Boolean).slice(0, 3).map(capitalizar);
  if (tipos.length === 1) trozos.push(`manda ${tipos[0]}`);
  else if (tipos.length > 1) {
    trozos.push(`manda ${tipos.slice(0, -1).join(", ")} y ${tipos[tipos.length - 1]}`);
  }

  const evento = ultimoEvento(d);
  if (evento) {
    const cuando = diasDesde(evento.fecha);
    trozos.push(
      cuando === null ? `estuvo en ${evento.titulo}` : `estuvo en ${evento.titulo} (${haceCuanto(cuando)})`
    );
  }

  if (trozos.length === 0) return "Sin contactos, casos ni eventos registrados en el CRM.";
  return oracion(trozos);
}

/** El evento más reciente que YA pasó (los futuros no son historia todavía) */
function ultimoEvento(d: DatosBrief): { titulo: string; fecha: string } | null {
  const pasados = (d.eventos ?? [])
    .filter((e) => e?.titulo && e?.fecha && (diasDesde(e.fecha) ?? -1) >= 0)
    .sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  return pasados[0] ?? null;
}

// ---------- 3. CON QUÉ ABRIR ----------
function conQueAbrir(d: DatosBrief): string {
  return oracion([conQueAbrirBase(d), colaCumple(d)].filter(Boolean).map((t) => t.replace(/\.$/, "")));
}

/**
 * El cumpleaños no es la razón para llamar, pero es EL dato de color: si cae en
 * los próximos días, quien atiende tiene que saberlo antes de cortar. Va como
 * cola de la tercera oración, no como reemplazo.
 */
function colaCumple(d: DatosBrief): string {
  const dias = diasAlCumple(d.birth_date);
  if (dias === null || dias > 7) return "";
  if (dias === 0) return "OJO: cumple años HOY";
  if (dias === 1) return "OJO: cumple años mañana";
  return `OJO: cumple años en ${dias} días`;
}

function conQueAbrirBase(d: DatosBrief): string {
  // 0. lo que una PERSONA se tomó el trabajo de anotar gana sobre cualquier
  //    regla que deduzca el sistema (doctors.observaciones, migración 0048)
  if (d.observaciones?.trim()) {
    return `De tus notas: ${recortar(d.observaciones)}.`;
  }

  // 1. atrasado contra SU PROPIO ritmo. Se compara el último contacto contra
  //    avg_interval_days porque son las dos únicas señales de cadencia que
  //    entran al brief; el margen del 50% evita gritar "atrasado" por dos días.
  const dias = diasDesde(d.last_contact_at);
  const ritmo = d.avg_interval_days ? Math.round(d.avg_interval_days) : null;
  if (dias !== null && ritmo && dias > ritmo * 1.5) {
    return `Viene atrasado contra su propio ritmo (${dias} días sin contacto contra ${ritmo} habituales): preguntale qué lo frenó.`;
  }

  // 2. lo que ya sabemos que le interesa, escrito por quien lo cargó
  if (d.why_interesting?.trim()) {
    return `Abrí por acá: ${recortar(d.why_interesting)}.`;
  }

  // 3. un evento reciente es la excusa más natural que existe
  const evento = ultimoEvento(d);
  const diasEvento = evento ? diasDesde(evento.fecha) : null;
  if (evento && diasEvento !== null && diasEvento <= 60) {
    return `Preguntale cómo le fue en ${evento.titulo} (${haceCuanto(diasEvento)}).`;
  }

  // 4. si trabaja con otra marca, la comparación abre sola
  const marcas = (d.competitor_brands ?? []).filter(Boolean);
  if (marcas.length > 0) {
    return `Trabaja con ${marcas.join(" y ")}: entrá por la comparación contra KeepSmiling.`;
  }

  // 5. hay ficha, pero ninguna palanca puntual. OJO: acá NO va "poca información
  //    cargada" — decirle eso de un doctor con 46 casos y contacto de la semana
  //    pasada es exactamente la clase de frase falsa que este brief evita.
  if (dias !== null && ritmo) {
    return "Viene al día con su propio ritmo: preguntale cómo viene el mes.";
  }
  const hayFicha =
    dias !== null ||
    ritmo !== null ||
    (d.case_count ?? 0) > 0 ||
    (d.tiposTratamiento?.length ?? 0) > 0 ||
    Object.keys(d.tiposCaso ?? {}).length > 0 ||
    (d.eventos?.length ?? 0) > 0;
  if (hayFicha) return "Sin nada puntual anotado: preguntale cómo viene el mes.";

  // 6. no hay nada. Decirlo, no inventarlo.
  return "Poca información cargada: arrancá preguntando cómo viene el mes.";
}

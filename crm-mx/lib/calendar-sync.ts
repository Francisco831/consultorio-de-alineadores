// Sync del Google Calendar de una persona → tabla calendar_events, para que la
// agenda del día del CRM sepa a qué doctor corresponde cada llamada.
//
// La fuente es el Apps Script que cada uno despliega en SU cuenta
// (gas-calendar.gs): el CRM no habla con Google, habla con esa URL + secreto.
// Ver docs/CALENDAR.md y el comentario de arriba de gas-calendar.gs para el
// porqué de no usar OAuth.
//
// EL VÍNCULO CON EL DOCTOR NO ADIVINA. Primero el mail de los invitados contra
// doctors.email (match exacto, es el único que no puede estar equivocado);
// después el apellido en el título. Si dos doctores empatan, doctor_id queda en
// null: un brief del doctor equivocado es peor que no tener brief.
//
// Idempotente: la clave es (profile_id, google_event_id), así que correrlo cada
// hora reescribe las mismas filas. Se guarda SIEMPRE el evento crudo en `raw` y
// de dónde salió el vínculo en `match_source`, para poder auditar y para poder
// recalcular el match sin volver a pegarle a Google.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/scripts/lib/fetch-all";
import { norm } from "@/lib/actividades-sync";
import { canonEmail } from "@/scripts/lib/phone";

/** Lo que devuelve gas-calendar.gs */
export type EventoGas = {
  id: string;
  titulo: string | null;
  inicio: string;
  fin: string | null;
  todoElDia: boolean;
  invitados: string[] | null;
  descripcion: string | null;
  ubicacion: string | null;
};

export type ReporteCalendar = {
  leidos: number;
  upserteados: number;
  con_doctor: number;
  sin_doctor: number;
};

type DoctorMatch = { id: string; nombre: string; email: string | null };

// CUÁL TOKEN ES EL APELLIDO: NO SE SABE. Medido contra la base el 26/8/26, los
// doctores están cargados de las dos formas — "Flores Heredia Mayra Sofia"
// (apellido primero, como los trajo Noloco) y "Mayra Ramos Martinez" (nombre
// primero, como los tipeó alguien), más un montón en MAYÚSCULAS. Cualquier regla
// del tipo "el primer token es el apellido" convierte a media base en "doctores
// apellidados Mayra".
//
// Por eso no se busca EL apellido: se cuenta cuántos tokens del nombre aparecen
// en el título y gana el que más tenga, siempre que gane solo. Con
// "Call Flores Heredia Mayra": Flores Heredia Mayra Sofia acierta 3 y Heredia
// Salgado Mayra Gabriela acierta 2 — hay ganador. Con "Llamada con Mayra"
// aciertan treinta con 1 cada uno: empate, y entonces doctor_id queda null.

/** Tokens del nombre que sirven para buscar. Menos de 4 letras ("de", "dra",
 *  "paz") aparecen sueltas en cualquier título y solo traen falsos positivos. */
const MIN_TOKEN = 4;

/** Un ÚNICO acierto tiene que ser una palabra larga: "paul" o "sofia" sueltos en
 *  un título ("Comida con Paul") no alcanzan para vincular una ficha. */
const MIN_TOKEN_SOLO = 6;

// Palabras que NO son un nombre, aunque estén dentro del campo `nombre`. Hay
// fichas cargadas a mano como "Dra Natalia Ciocale y equipo" o "EMILIANO MAYA
// EVENTOS Y FLORES": sin esta lista, el evento "Reunión de equipo" vinculaba a
// esa doctora y la llamada interna arrancaba con el brief de otra persona
// (falso positivo real, encontrado probando contra la base el 26/8/26).
const RUIDO = new Set([
  "equipo", "reunion", "junta", "llamada", "videollamada", "video", "consulta",
  "control", "seguimiento", "dentista", "clinica", "consultorio", "zoom", "meet",
  "google", "almuerzo", "comida", "cena", "cumpleanos", "revision", "caso",
  "casos", "acreditacion", "paciente", "pacientes", "personal", "entrevista",
  "capacitacion", "curso", "charla", "evento", "eventos", "keepday",
  "keepsmiling", "referida", "referido", "prueba", "turno", "cita",
  "presentacion", "demo", "ortodoncia", "ortodoncista", "doctora", "doctor",
]);

/** Tokens ÚNICOS y útiles del nombre. El Set no es cosmético: "Martínez
 *  Martínez" contaba dos aciertos por la misma palabra y le empataba a
 *  "Meza Martínez", que había acertado dos DISTINTAS. */
function tokensNombre(nombre: string): Set<string> {
  return new Set(
    norm(nombre)
      .split(" ")
      .filter((t) => t.length >= MIN_TOKEN && !RUIDO.has(t))
  );
}

/** ¿Aparece `palabra` como palabra entera dentro del título ya normalizado? */
function contienePalabra(tituloNorm: string, palabra: string): boolean {
  return ` ${tituloNorm} `.includes(` ${palabra} `);
}

/**
 * Doctor del evento. Devuelve el id y de dónde salió, o null en los dos casos
 * en los que NO se sabe: no matcheó nadie, o matcheó más de uno.
 */
export function resolverDoctor(
  ev: EventoGas,
  porEmail: Map<string, DoctorMatch>,
  doctores: DoctorMatch[]
): { doctorId: string | null; matchSource: string | null } {
  // 1. mail del invitado — exacto, sin interpretación
  for (const inv of ev.invitados ?? []) {
    const clave = canonEmail(inv);
    const d = clave ? porEmail.get(clave) : null;
    if (d) return { doctorId: d.id, matchSource: "email" };
  }

  // 2. nombre en el título: gana el que más tokens acierte, y solo si gana solo
  const titulo = norm(ev.titulo ?? "");
  if (!titulo) return { doctorId: null, matchSource: null };
  let mejor = 0;
  let ganadores: DoctorMatch[] = [];
  for (const d of doctores) {
    const aciertos = [...tokensNombre(d.nombre)].filter((t) => contienePalabra(titulo, t));
    if (aciertos.length === 0) continue;
    if (aciertos.length === 1 && aciertos[0].length < MIN_TOKEN_SOLO) continue;
    if (aciertos.length > mejor) {
      mejor = aciertos.length;
      ganadores = [d];
    } else if (aciertos.length === mejor) {
      ganadores.push(d);
    }
  }
  if (ganadores.length === 1) {
    return { doctorId: ganadores[0].id, matchSource: "titulo" };
  }
  return { doctorId: null, matchSource: null };
}

export async function sincronizarCalendar(
  db: SupabaseClient,
  url: string,
  secret: string,
  profileId: string,
  log: (s: string) => void
): Promise<ReporteCalendar> {
  const res = await fetch(`${url}?secret=${encodeURIComponent(secret)}`);
  const texto = await res.text();
  if (!res.ok || !texto.trimStart().startsWith("{")) {
    // el Apps Script contesta "no" en texto plano cuando el secreto no coincide,
    // y HTML cuando la implementación quedó privada: los dos casos caen acá
    throw new Error(
      `Apps Script respondió raro (HTTP ${res.status}): ${texto.slice(0, 120)}`
    );
  }
  const payload = JSON.parse(texto) as { generado?: string; eventos?: EventoGas[] };
  const eventos = (payload.eventos ?? []).filter((e) => e?.id && e?.inicio);
  log(`calendar: ${eventos.length} eventos leídos (generado ${payload.generado ?? "?"})`);
  if (eventos.length === 0) return { leidos: 0, upserteados: 0, con_doctor: 0, sin_doctor: 0 };

  // UNA query para toda la base de doctores, no una por invitado: son ~7k filas
  // y los eventos de una quincena pueden traer decenas de mails
  const doctores = await fetchAll<DoctorMatch>(db, "doctors", "id, nombre, email");
  const porEmail = new Map<string, DoctorMatch>();
  for (const d of doctores) {
    const clave = canonEmail(d.email);
    // el primero gana: si dos fichas comparten mail es un duplicado a fusionar,
    // no algo que este sync deba resolver
    if (clave && !porEmail.has(clave)) porEmail.set(clave, d);
  }

  const filas = eventos.map((ev) => {
    const { doctorId, matchSource } = resolverDoctor(ev, porEmail, doctores);
    return {
      profile_id: profileId,
      google_event_id: ev.id,
      // Calendar deja poner eventos sin título; la columna es NOT NULL
      titulo: (ev.titulo ?? "").trim() || "(sin título)",
      inicio: ev.inicio,
      fin: ev.fin,
      todo_el_dia: Boolean(ev.todoElDia),
      doctor_id: doctorId,
      match_source: matchSource,
      raw: ev as unknown as Record<string, unknown>,
    };
  });

  let upserteados = 0;
  for (let i = 0; i < filas.length; i += 500) {
    const { data, error } = await db
      .from("calendar_events")
      .upsert(filas.slice(i, i + 500), { onConflict: "profile_id,google_event_id" })
      .select("id");
    if (error) throw new Error(`upsert calendar_events: ${error.message}`);
    upserteados += data?.length ?? 0;
  }

  // OJO: lo que se canceló en Google queda en la tabla hasta que alguien lo
  // borre — este sync solo agrega y actualiza. Si algún día molesta, la ventana
  // es conocida (de ahora a +14 días) y se puede limpiar lo que no vino.
  const con_doctor = filas.filter((f) => f.doctor_id).length;
  log(`calendar: ${upserteados} eventos al día · ${con_doctor} con doctor · ${filas.length - con_doctor} sin doctor`);
  return {
    leidos: eventos.length,
    upserteados,
    con_doctor,
    sin_doctor: filas.length - con_doctor,
  };
}

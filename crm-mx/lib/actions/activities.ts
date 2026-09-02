"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function logActivity(formData: FormData) {
  const doctorId = String(formData.get("doctor_id"));
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const occurredRaw = String(formData.get("occurred_at") ?? "").trim();
  const { error } = await supabase.from("activities").insert({
    doctor_id: doctorId,
    opportunity_id: String(formData.get("opportunity_id") ?? "") || null,
    type: String(formData.get("type") ?? "nota"),
    summary: String(formData.get("summary") ?? "").trim() || null,
    outcome: String(formData.get("outcome") ?? "").trim() || null,
    occurred_at: occurredRaw
      ? new Date(occurredRaw).toISOString()
      : new Date().toISOString(),
    created_by: user.id,
  });
  if (error) return { error: error.message };

  // el último contacto del doctor se actualiza al vuelo (el motor lo recalcula igual)
  await supabase
    .from("doctors")
    .update({ last_contact_at: new Date().toISOString() })
    .eq("id", doctorId);

  revalidatePath(`/doctores/${doctorId}`);
  // la carga rápida del panel personal también refresca sus tiles y listas
  revalidatePath("/panel");
  return { ok: true };
}

/**
 * Corregir una actividad ya cargada (migración 0051).
 *
 * Pedido de Pancho el 31/8: "necesito en el CRM poder modificar las notas, por
 * ejemplo Rocío subió una y la quiere modificar". Hasta hoy un typo se
 * "arreglaba" cargando otra actividad encima, que duplica la fila en el timeline
 * y en los conteos del mes.
 *
 * Las dos reglas que eligió él —la corrige QUIEN LA ESCRIBIÓ, y no se borra— las
 * hace cumplir la base, no este archivo: el trigger `activities_edicion_guard`
 * de 0051 deja pasar solo el texto y solo al autor. Acá no se chequea rol ni
 * autoría: se manda el cambio y se muestra lo que conteste Postgres.
 */

// Mismo tope que las observaciones del doctor (doctors.ts): es una nota de lo
// que pasó en una llamada, no un informe. El resultado es la línea de abajo del
// timeline —entra en un <Input>—, así que se le da bastante menos.
// OJO: los dos topes están repetidos en components/doctor/editar-actividad.tsx
// para frenar el pegado antes de mandar. Un archivo "use server" solo puede
// exportar funciones async, así que no hay forma de compartirlos desde acá; si
// tocás uno, tocá el otro.
const MAX_SUMMARY = 2000;
const MAX_OUTCOME = 500;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function editarActividad(formData: FormData) {
  const id = String(formData.get("id") ?? "").trim();
  // Se valida la forma del id antes de tocar la base: si no es un uuid, Postgres
  // corta con "invalid input syntax for type uuid" y eso termina impreso en el
  // diálogo. Un id así no lo escribe nadie a mano, es un bug nuestro; que se vea
  // como una falla nuestra y no como un error de quien está corrigiendo.
  if (!UUID_RE.test(id)) {
    return { error: "No se sabe qué actividad corregir" };
  }

  const summary = String(formData.get("summary") ?? "").trim();
  const outcome = String(formData.get("outcome") ?? "").trim();

  // El resumen no puede quedar vacío. Vaciarlo sería borrar la nota por la
  // ventana, y Pancho pidió explícitamente corregir SIN borrar: la fila
  // seguiría contando en el mes y en el timeline, pero ya sin decir qué pasó.
  // Vale también para la actividad que nació sin resumen: pedirle el texto a
  // quien la está corrigiendo no le saca nada a nadie.
  if (!summary) {
    return { error: "Poné qué pasó: una nota sin texto no es una corrección" };
  }
  if (summary.length > MAX_SUMMARY) {
    return { error: "Es una nota, no un informe: máximo 2.000 caracteres" };
  }
  if (outcome.length > MAX_OUTCOME) {
    return { error: "El resultado es una línea: máximo 500 caracteres" };
  }

  const supabase = await createClient();

  // La AUTORÍA la sigue decidiendo la base: quién está logueado lo resuelve
  // auth.uid() adentro del guard, y `edited_at`/`edited_by` los estampa ella.
  // Acá no se chequea autoría ni rol. Esta guardia es solo por el mensaje: con
  // el token vencido PostgREST no devuelve cero filas, devuelve error, y el
  // `return { error: error.message }` de abajo le pondría "JWT expired" en el
  // diálogo a alguien que lo único que tiene que hacer es volver a entrar.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };

  const { data, error } = await supabase
    .from("activities")
    .update({ summary, outcome: outcome || null })
    .eq("id", id)
    .select("id, doctor_id");

  if (error) {
    // El guard de 0051 corta con `raise exception` sin SQLSTATE, que en PL/pgSQL
    // es P0001 (raise_exception). Ese mensaje ya viene escrito en castellano y
    // pensado para que lo lea Rocío ("Esta nota la escribió otra persona…"), así
    // que se muestra tal cual en vez de taparlo con un genérico.
    return { error: error.message };
  }
  if (!data?.length)
    return { error: "No se pudo guardar: tu rol no tiene permiso para corregir notas" };

  // El doctor sale del select y no del formulario: el cliente no tiene por qué
  // decidir qué ficha refrescamos.
  const doctorId = data[0].doctor_id;
  revalidatePath(`/doctores/${doctorId}`);
  // /panel no muestra solo conteos: la lista de reuniones del mes imprime el
  // summary y el outcome enteros, así que sin esto queda leyéndose el texto
  // viejo. /calidad hace lo mismo con la cola de interacciones sin clasificar,
  // y ahí el texto es lo único con lo que alguien decide si hubo conversación.
  revalidatePath("/panel");
  revalidatePath("/calidad");
  // El registro día por día del equipo imprime summary y outcome pegados
  // (lib/actividad-equipo.ts): sin esto la nota corregida se sigue leyendo vieja
  // justo en la pantalla donde Pancho mira qué hizo cada uno. El calendario
  // mensual queda afuera: ahí solo se cuentan filas, y una corrección no suma a
  // esa cuenta (la marca `cuentaEnElDia` la excluye).
  revalidatePath("/equipo/actividad");
  return { ok: true };
}

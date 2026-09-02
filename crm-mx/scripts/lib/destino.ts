// Guard de destino para TODO script que escriba en la base.
//
// Por qué existe: hasta ahora el único script que anunciaba y confirmaba su
// destino era scripts/db-migrate.ts. Los otros ~15 —los importadores, el seed y
// los tres que BORRAN filas— abrían la base con lo que hubiera en
// NEXT_PUBLIC_SUPABASE_URL, sin mirar supabase/environments.json, sin decir
// contra qué proyecto estaban por escribir y sin preguntar nada. Con el bloque de
// producción activo en .env.local, `npx tsx scripts/limpiar-basura.ts` borraba
// filas de la base con 7.034 doctores reales en silencio.
//
// La regla de entornos NO se reimplementa acá: sale de resolverEntorno()
// (./migrate-core), que es la misma que usa el runner de migraciones y la que
// está cubierta por scripts/db-migrate.test.ts. Un segundo criterio sería
// exactamente el problema que este archivo viene a cerrar.

import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolverEntorno, type Entorno } from "./migrate-core";

const REGISTRO = resolve(__dirname, "../../supabase/environments.json");

export class DestinoRechazado extends Error {}

export function leerRegistroEntornos(): Record<string, string> {
  if (!existsSync(REGISTRO)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRO, "utf8")) as Record<string, string>;
  } catch (e) {
    throw new DestinoRechazado(
      `supabase/environments.json no es JSON válido: ${(e as Error).message}`
    );
  }
}

/** El ref que sale de la URL, que es la base contra la que el script va a escribir. */
export function refDeLaUrl(url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""): string {
  return url.replace(/^https?:\/\//, "").split(".")[0];
}

export interface OpcionesDestino {
  /** Qué va a hacer el script, en una línea. Se imprime antes de preguntar. */
  accion: string;
  /**
   * true para los que BORRAN o pisan datos: exigen confirmación escrita incluso
   * en desarrollo. Perder la base de desarrollo también cuesta un día de trabajo.
   */
  destructivo?: boolean;
  /** --yes. Nunca alcanza para producción ni para un destino desconocido. */
  auto?: boolean;
  /**
   * El ref contra el que el script REALMENTE va a escribir, cuando no es el de la
   * URL. Lo pasan los scripts que conectan por `pg`: scripts/lib/pg.ts resuelve
   * `SUPABASE_PROJECT_REF ?? url`, así que para ellos esa variable no miente y no
   * hay que rechazarla — hay que confirmar contra ella.
   */
  refEfectivo?: string;
  /**
   * La confirmación escrita, pero pasada como argumento (`--confirmar <ref>`) en
   * vez de tipeada en la terminal. Existe para GitHub Actions, donde no hay TTY:
   * la persona escribe el ref en el formulario del workflow y el runner lo recibe
   * acá. La vara es LA MISMA que en la terminal —hay que conocer y escribir el
   * ref exacto—, solo cambia por dónde entra. `--yes` sigue sin alcanzar para
   * producción ni para lo destructivo.
   */
  refConfirmado?: string;
}

export interface DestinoResuelto {
  ref: string;
  entorno: Entorno;
}

// ---------------------------------------------------------------------------
// Decisiones puras (mismo criterio que ./migrate-core: lo que decide se prueba)
// ---------------------------------------------------------------------------

/**
 * Detecta el destino ambiguo. Devuelve el mensaje si hay que frenar, o null.
 *
 * `refEfectivo` lo pasan los scripts que conectan por `pg` y que SÍ honran
 * SUPABASE_PROJECT_REF: para ellos la variable no miente y no hay ambigüedad.
 */
export function refAmbiguo(
  refDeLaUrl: string,
  refPedidoEnv: string | undefined,
  refEfectivo: string | undefined
): string | null {
  if (refEfectivo) return null;
  if (!refPedidoEnv || refPedidoEnv === refDeLaUrl) return null;
  return (
    `Destino ambiguo, no se escribe nada.\n` +
    `  SUPABASE_PROJECT_REF pide  : ${refPedidoEnv}\n` +
    `  NEXT_PUBLIC_SUPABASE_URL es: ${refDeLaUrl}\n\n` +
    `  Este script escribe con supabase-js, que usa la URL — así que iba a\n` +
    `  escribir en "${refDeLaUrl}" mientras vos pedías "${refPedidoEnv}".\n` +
    `  Apuntá la URL (y la service key) al proyecto que querés, o sacá\n` +
    `  SUPABASE_PROJECT_REF del comando.`
  );
}

/**
 * Si hay que pedir que tipeen el ref. Solo la corrida de todos los días
 * —desarrollo, acción no destructiva— pasa sin preguntar.
 */
export function necesitaConfirmacion(
  entorno: Entorno,
  exigeConfirmacionManual: boolean,
  destructivo: boolean | undefined
): boolean {
  return exigeConfirmacionManual || entorno !== "desarrollo" || !!destructivo;
}

/**
 * ¿La confirmación escrita que llegó por argumento vale como la tipeada?
 * Solo si es EXACTAMENTE el ref: ni un prefijo, ni con espacios, ni "yes".
 */
export function refConfirmadoValido(
  ref: string,
  refConfirmado: string | undefined
): boolean {
  return typeof refConfirmado === "string" && refConfirmado.trim() === ref && ref !== "";
}

/**
 * Anuncia el destino y exige confirmación proporcional al riesgo. Llamar SIEMPRE
 * antes de la primera escritura.
 */
export async function confirmarDestino(
  o: OpcionesDestino
): Promise<DestinoResuelto> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url && !o.refEfectivo) {
    throw new DestinoRechazado(
      "Falta NEXT_PUBLIC_SUPABASE_URL: no se puede saber contra qué base se escribiría."
    );
  }
  const ref = o.refEfectivo ?? refDeLaUrl(url);

  // LA TRAMPA QUE ESTE GUARD EXISTE PARA CERRAR.
  //
  // docs/PUESTA_AL_DIA_PROD.md documenta `SUPABASE_PROJECT_REF=<ref> npx tsx
  // scripts/...` como la forma de apuntar a producción. Pero esa variable la leen
  // SOLO scripts/lib/pg.ts y el runner de migraciones; los scripts que usan
  // supabase-js —todos los importadores— la ignoran y escriben donde diga la URL.
  //
  // O sea: quien seguía el procedimiento oficial creía estar escribiendo en
  // producción y escribía en desarrollo, sin un solo mensaje que lo desmintiera.
  // Con dos herramientas leyendo variables distintas, el silencio es lo peligroso:
  // acá se corta en vez de elegir una.
  const ambiguo = refAmbiguo(
    refDeLaUrl(url),
    process.env.SUPABASE_PROJECT_REF,
    o.refEfectivo
  );
  if (ambiguo) throw new DestinoRechazado(ambiguo);

  const destino = resolverEntorno(ref, leerRegistroEntornos(), process.env.SUPABASE_DEV_REF);

  console.log("");
  console.log("  Base destino");
  console.log(`    project_ref : ${ref}`);
  console.log(`    entorno     : ${destino.entorno.toUpperCase()}  (${destino.fuente})`);
  console.log(`    acción      : ${o.accion}${o.destructivo ? "  ⚠ DESTRUCTIVA" : ""}`);
  console.log("");

  // Desarrollo y no destructivo: es el caso de todos los días, no se pregunta.
  if (!necesitaConfirmacion(destino.entorno, destino.exigeConfirmacionManual, o.destructivo)) {
    return { ref, entorno: destino.entorno };
  }

  if (o.auto) {
    console.log(
      destino.entorno === "produccion"
        ? "  --yes NO alcanza acá: el destino es PRODUCCIÓN.\n"
        : o.destructivo
          ? "  --yes NO alcanza acá: la acción borra o pisa datos.\n"
          : "  --yes NO alcanza acá: el destino no está identificado.\n"
    );
  }
  // La confirmación escrita puede venir como argumento (GitHub Actions): tiene
  // que ser el ref exacto. Un valor distinto no cae a la pregunta interactiva,
  // corta: si alguien pasó --confirmar con otro ref, estaba pensando en otra base.
  if (o.refConfirmado !== undefined) {
    if (refConfirmadoValido(ref, o.refConfirmado)) {
      console.log(`  Confirmación escrita recibida por argumento (${ref}).\n`);
      return { ref, entorno: destino.entorno };
    }
    throw new DestinoRechazado(
      `--confirmar no coincide con el destino (${ref}). No se escribió nada.`
    );
  }

  if (!process.stdin.isTTY) {
    throw new DestinoRechazado(
      "Destino no confirmado y no hay terminal interactiva. No se escribió nada."
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const r = (await rl.question(`  Escribí el ref para confirmar (${ref}): `)).trim();
  rl.close();
  if (r !== ref) {
    throw new DestinoRechazado("El ref no coincide. No se escribió nada.");
  }
  console.log("");
  return { ref, entorno: destino.entorno };
}

/**
 * Envoltorio para el `main()` de los scripts: convierte un destino rechazado en un
 * mensaje limpio y código 4, sin volcar un stack que hace parecer que fue un bug.
 */
export function salirConDestinoRechazado(e: unknown): never {
  if (e instanceof DestinoRechazado) {
    console.error(`\n  ${e.message}\n`);
    process.exit(4);
  }
  throw e;
}

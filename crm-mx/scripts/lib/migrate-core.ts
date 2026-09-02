// Decisiones puras del runner de migraciones, separadas para poder probarlas.
//
// Todo lo de este archivo es una función sin efectos: sin red, sin disco, sin
// process.exit. Es a propósito. El incidente del 10/8/2026 (ver
// supabase/HOTFIX_LOG.md) fue una decisión mal tomada —"esta base es desarrollo,
// aplico sin preguntar"— dentro de una función que también conectaba y escribía,
// así que no había forma de probarla sin tocar una base.
//
// Se prueba con `npm test` (scripts/db-migrate.test.ts).

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Modos
// ---------------------------------------------------------------------------

export type Modo =
  | "print-target"
  | "check-connection"
  | "dry-run"
  | "ensayo"
  | "apply"
  | "sembrar";
export const MODOS: readonly Modo[] = [
  "print-target",
  "check-connection",
  "dry-run",
  "ensayo",
  "apply",
  "sembrar",
] as const;

export const QUE_HACE: Record<Modo, string> = {
  "print-target": "solo imprime el destino, no se conecta",
  "check-connection": "se conecta e informa, no corre SQL",
  "dry-run": "corre el SQL en una transacción y SIEMPRE hace rollback",
  ensayo: "corre TODAS las pendientes en UNA transacción y la revierte al final",
  apply: "APLICA los cambios de forma permanente",
  sembrar: "MARCA migraciones como aplicadas SIN ejecutarlas",
};

/** Los modos que no dejan nada escrito. Sirve para no tener que enumerarlos a mano. */
export const MODOS_SIN_ESCRITURA: readonly Modo[] = [
  "print-target",
  "check-connection",
  "dry-run",
  "ensayo",
] as const;

/**
 * El modo por defecto es --dry-run: correr el runner "a ver qué hace" no puede
 * escribir. Pedir dos modos es casi siempre un error de tipeo, así que se rechaza
 * en vez de elegir uno.
 */
export function resolverModo(args: string[]): { modo: Modo } | { error: string } {
  const pedidos = MODOS.filter((m) => args.includes(`--${m}`));
  if (pedidos.length > 1) {
    return { error: `Modos incompatibles: ${pedidos.map((m) => `--${m}`).join(" ")}. Elegí uno.` };
  }
  return { modo: pedidos[0] ?? "dry-run" };
}

// ---------------------------------------------------------------------------
// Identificación del entorno
// ---------------------------------------------------------------------------

/**
 * Contra el pooler de Supabase, quien elige el proyecto es el USUARIO
 * (`postgres.<ref>`), no el host. Si alguien define SUPABASE_DB_USER a mano, la
 * conexión puede terminar en otro proyecto mientras el runner anuncia el ref que
 * salió de NEXT_PUBLIC_SUPABASE_URL. Sería posible aplicar en producción con el
 * cartel de "DESARROLLO" en pantalla.
 *
 * Manda el usuario, porque es el que decide de verdad.
 */
export function refEfectivo(
  refDeLaUrl: string,
  dbUser?: string
): { ref: string; discrepancia: string | null } {
  const delUsuario = dbUser?.startsWith("postgres.") ? dbUser.slice("postgres.".length) : null;
  if (!delUsuario || delUsuario === refDeLaUrl) return { ref: refDeLaUrl, discrepancia: null };
  return {
    ref: delUsuario,
    discrepancia:
      `SUPABASE_DB_USER apunta a "${delUsuario}" y la URL a "${refDeLaUrl}". ` +
      "Contra el pooler manda el usuario: se usa el del usuario.",
  };
}

export type Entorno = "desarrollo" | "produccion" | "desconocido";

export interface Destino {
  entorno: Entorno;
  /** De dónde salió la respuesta, para poder imprimirlo y auditarlo. */
  fuente: string;
  /** Si es true, --yes NO alcanza: hace falta confirmación interactiva. */
  exigeConfirmacionManual: boolean;
}

/**
 * El host del pooler es idéntico para dev y prod (los dos proyectos viven en
 * ca-central-1), así que el único discriminante es el `ref`.
 *
 * Un ref que no está registrado NO se asume desarrollo. Se trata como desconocido
 * y exige confirmación escrita aunque venga --yes: `--yes` existe para CI, y CI
 * corre contra bases registradas.
 *
 * PRODUCCIÓN exige confirmación SIEMPRE, venga o no --yes. La versión anterior
 * devolvía false para los dos entornos declarados, así que registrar producción en
 * environments.json —hecho justamente para protegerla— desactivaba su protección:
 * `--apply --yes` contra el ref de producción escribía sin preguntar nada. El único
 * destino que quedaba protegido era el que nadie había declarado.
 */
export function resolverEntorno(
  ref: string,
  registro: Record<string, string>,
  devRefEnv?: string
): Destino {
  const declarado = registro[ref];
  if (declarado === "desarrollo" || declarado === "produccion") {
    return {
      entorno: declarado,
      fuente: "supabase/environments.json",
      exigeConfirmacionManual: declarado === "produccion",
    };
  }
  if (declarado != null) {
    return {
      entorno: "desconocido",
      fuente: `supabase/environments.json declara "${declarado}", que no es un entorno válido`,
      exigeConfirmacionManual: true,
    };
  }
  if (devRefEnv && devRefEnv === ref) {
    return {
      entorno: "desarrollo",
      fuente: "SUPABASE_DEV_REF (registralo en supabase/environments.json)",
      exigeConfirmacionManual: false,
    };
  }
  return {
    entorno: "desconocido",
    fuente: "el ref no está registrado en supabase/environments.json",
    exigeConfirmacionManual: true,
  };
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

/**
 * SHA-256 del contenido, con los finales de línea normalizados a \n.
 *
 * Se normaliza para que un archivo que pasó por un editor con CRLF no se reporte
 * como modificado. La contracara: el checksum identifica el CONTENIDO LÓGICO del
 * archivo, no sus bytes exactos.
 */
export function checksum(contenido: string): string {
  return createHash("sha256").update(contenido.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Descubrimiento y orden de las migraciones
// ---------------------------------------------------------------------------

/**
 * Los rollbacks NO son migraciones. Vivían en supabase/migrations/ y una corrida
 * sin argumentos los levantaba: aplicaba 0027 y a continuación su propio rollback,
 * en orden alfabético. Ahora viven en supabase/rollbacks/, y además se filtran acá
 * por si alguno vuelve a aparecer.
 */
export function esArchivoDeMigracion(nombre: string): boolean {
  return /\.sql$/i.test(nombre) && !esRollback(nombre);
}

/**
 * Un rollback NO se anota en el ledger. Anotarlo tiene dos consecuencias feas:
 *  - queda registrado como "migración aplicada", que es lo contrario de lo que hizo;
 *  - el rollback de 0028 borra `ops.schema_migrations`, así que el insert posterior
 *    falla, aborta la transacción y revierte el propio rollback: por el camino
 *    documentado era imposible de correr.
 */
export function esRollback(ruta: string): boolean {
  return /_rollback\.sql$/i.test(ruta) || /(^|[/\\])rollbacks[/\\]/.test(ruta);
}

/**
 * La migración que un rollback deshace, por convención de nombre:
 * `0051_editar_notas_rollback.sql` → `0051_editar_notas.sql`. Es la fila que hay
 * que sacar del ledger al correrlo; si el nombre no sigue la convención, null y
 * el runner avisa en vez de adivinar.
 */
export function migracionQueDeshace(ruta: string): string | null {
  const nombre = claveLedger(ruta);
  const m = nombre.match(/^(\d+_.+)_rollback\.sql$/i);
  return m ? `${m[1]}.sql` : null;
}

/**
 * La clave del ledger es el NOMBRE del archivo, no la ruta que se tipeó.
 * `supabase/migrations/0001_x.sql` y `./supabase/migrations/0001_x.sql` son la
 * misma migración; con la ruta cruda quedaban dos filas y la segunda se re-aplicaba.
 */
export function claveLedger(ruta: string): string {
  return ruta.split(/[/\\]/).pop() ?? ruta;
}

/** El valor que sigue a un flag (`--hasta 0027` → "0027"), o undefined si no está. */
export function valorDeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Los archivos nombrados explícitamente: todo lo que no es un flag ni el valor de
 * un flag que lleva valor. Hasta el 2/9/2026 esto se hacía con
 * `a !== args[iHasta + 1]` y, sin `--hasta`, `iHasta + 1` era 0: el PRIMER
 * argumento quedaba excluido. `db-migrate.ts 0027.sql --apply` aplicaba todas las
 * pendientes en vez de ese archivo. Se sabía que "funcionaba" solo porque los
 * docs ponían el flag antes del archivo.
 */
export function archivosExplicitos(args: string[], flagsConValor: string[]): string[] {
  const valores = new Set<number>();
  for (const flag of flagsConValor) {
    const i = args.indexOf(flag);
    if (i >= 0 && i + 1 < args.length) valores.add(i + 1);
  }
  return args.filter((a, i) => !a.startsWith("--") && !valores.has(i));
}

/** Prefijo numérico de una migración, o null si no tiene. */
export function prefijo(nombre: string): number | null {
  const m = claveLedger(nombre).match(/^\d+/);
  return m ? parseInt(m[0], 10) : null;
}

export interface OrdenMigraciones {
  orden: string[];
  /** Prefijos numéricos repetidos: el orden entre ellos es ambiguo. */
  prefijosDuplicados: string[];
  /** Archivos sin prefijo numérico: no se puede saber dónde van. */
  sinPrefijo: string[];
}

/**
 * Ordena por el prefijo numérico, no alfabéticamente: con `.sort()` a secas,
 * `0100_x.sql` va antes que `0099_x.sql` en cuanto el proyecto pase de 99
 * migraciones. Además delata prefijos repetidos, que hacen el orden ambiguo.
 */
export function ordenarMigraciones(nombres: string[]): OrdenMigraciones {
  const migraciones = nombres.filter(esArchivoDeMigracion);
  const sinPrefijo = migraciones.filter((n) => !/^\d+/.test(n)).sort();
  const conPrefijo = migraciones.filter((n) => /^\d+/.test(n));

  const porPrefijo = new Map<number, string[]>();
  for (const n of conPrefijo) {
    const p = parseInt(n.match(/^\d+/)![0], 10);
    porPrefijo.set(p, [...(porPrefijo.get(p) ?? []), n]);
  }

  const prefijosDuplicados = [...porPrefijo.entries()]
    .filter(([, archivos]) => archivos.length > 1)
    .map(([p]) => String(p).padStart(4, "0"))
    .sort();

  const orden = [...porPrefijo.keys()]
    .sort((a, b) => a - b)
    .flatMap((p) => porPrefijo.get(p)!.slice().sort());

  return { orden, prefijosDuplicados, sinPrefijo };
}

// ---------------------------------------------------------------------------
// Comparación contra el ledger
// ---------------------------------------------------------------------------

export type EstadoArchivo =
  /** No está en el ledger: hay que aplicarla. */
  | { estado: "pendiente" }
  /** Está en el ledger con el mismo checksum: no hacer nada. */
  | { estado: "aplicada" }
  /** Está en el ledger con OTRO checksum: el archivo cambió después de aplicarse. */
  | { estado: "divergente"; checksumLedger: string; checksumArchivo: string };

/**
 * Una migración que cambió después de haberse aplicado es el error más caro de
 * este tipo de herramienta: el archivo dice una cosa y la base tiene otra, y nada
 * lo delata hasta que alguien recrea la base desde cero y no le da igual. Por eso
 * es un estado propio y frena la corrida.
 */
export function compararConLedger(
  checksumArchivo: string,
  checksumLedger: string | undefined
): EstadoArchivo {
  if (checksumLedger == null) return { estado: "pendiente" };
  if (checksumLedger === checksumArchivo) return { estado: "aplicada" };
  return { estado: "divergente", checksumLedger, checksumArchivo };
}

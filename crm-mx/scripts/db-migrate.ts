/**
 * Corre las migraciones SQL contra el Postgres de Supabase (via pooler, session mode).
 *
 *   SUPABASE_DB_PASSWORD=... npx tsx scripts/db-migrate.ts [archivo.sql ...] [modo] [--yes]
 *
 * MODOS (elegir uno; sin ninguno, el modo es --dry-run)
 *   --print-target      Imprime a qué base apuntaría y termina. NO se conecta.
 *   --check-connection  Se conecta, informa servidor/base/ledger y termina. NO corre SQL.
 *   --dry-run           Corre cada migración pendiente en su propia transacción y
 *                       SIEMPRE hace rollback. Nada queda escrito. Valida archivos
 *                       SUELTOS: una que dependa de la anterior falla acá.
 *   --ensayo            Corre TODAS las pendientes en UNA transacción y la revierte al
 *                       final. Es el que valida la CADENA — el modo a usar antes de
 *                       poner al día una base atrasada. Nada queda escrito.
 *   --apply             Aplica de verdad. Es la ÚNICA forma de escribir schema.
 *   --sembrar --hasta N Marca como aplicadas, SIN ejecutarlas, las migraciones hasta
 *                       el prefijo N. Es para bases que ya tenían migraciones aplicadas
 *                       antes de que existiera el ledger. Ver "siembra" abajo.
 *
 *   --yes               Omite la confirmación del destino. Solo sirve si el ref está
 *                       registrado en supabase/environments.json.
 *   --permitir-divergencia
 *                       Aplica igual una migración cuyo archivo cambió después de
 *                       haberse aplicado.
 *
 * LA SIEMBRA, Y POR QUÉ NO ES OPCIONAL
 * El ledger nace vacío. Contra una base que YA tiene migraciones aplicadas —que es el
 * caso de desarrollo, con 0001..0027 puestas— un ledger vacío significa "no hay nada
 * aplicado", y el runner intenta re-aplicar todo desde 0001. No termina en desastre
 * sino en error, porque `0001_extensions_enums.sql` hace `create type ... as enum`
 * (Postgres no admite `if not exists` ahí) y muere con "already exists" en el archivo
 * 1 de 28. Pero deja el ledger mintiendo.
 *
 * Por eso: en una base preexistente, PRIMERO se siembra y después se usa.
 *
 *   npx tsx scripts/db-migrate.ts --sembrar --hasta 0027
 *
 * La siembra no ejecuta una sola línea de SQL de migración: solo escribe las filas del
 * ledger. Es una afirmación sobre el pasado, así que el runner la muestra entera y
 * pide confirmación.
 *
 * QUÉ GARANTIZA
 *  - Cada archivo corre dentro de UNA transacción, junto con la fila del ledger que lo
 *    declara aplicado. O quedan las dos cosas o no queda ninguna.
 *  - Lo ya aplicado se saltea (idempotencia por ledger, no por confiar en que cada
 *    migración sea idempotente: casi ninguna lo es).
 *  - Si un archivo cambió después de aplicarse, la corrida frena.
 *  - Los rollbacks NO se anotan en el ledger: no son migraciones.
 *
 * POR QUÉ --apply ES OBLIGATORIO
 * El 10/8/2026 se aplicó 0027 a la base de desarrollo sin querer: se corrió este script
 * para probar el aviso de destino, el ref coincidía con SUPABASE_DEV_REF, la confirmación
 * se saltó y el archivo se aplicó (ver supabase/HOTFIX_LOG.md). Sin --apply, no escribe.
 *
 * Variables:
 *   SUPABASE_PROJECT_REF (default: ref de NEXT_PUBLIC_SUPABASE_URL en .env.local)
 *   SUPABASE_DB_PASSWORD (obligatoria salvo en --print-target)
 *   SUPABASE_DB_HOST     (si se conoce; si no, prueba las regiones comunes)
 *   SUPABASE_DB_USER     (contra el pooler, ESTE es el que elige el proyecto)
 *   SUPABASE_DEV_REF     (compatibilidad; lo suyo es registrarlo en environments.json)
 */
import { Client } from "pg";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { config } from "dotenv";
import {
  archivosExplicitos,
  checksum,
  claveLedger,
  compararConLedger,
  esRollback,
  migracionQueDeshace,
  ordenarMigraciones,
  prefijo,
  QUE_HACE,
  refEfectivo,
  resolverEntorno,
  resolverModo,
  valorDeFlag,
  type Modo,
} from "./lib/migrate-core";
import { refConfirmadoValido } from "./lib/destino";

config({ path: ".env.local" });

const DIR_MIGRACIONES = "supabase/migrations";
const REGISTRO_ENTORNOS = "supabase/environments.json";
/** La migración que crea el propio ledger. Se aplica sola, antes que el resto. */
const ARCHIVO_LEDGER = join(DIR_MIGRACIONES, "0028_migration_ledger.sql");

const urlEnv = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const refDeclarado =
  process.env.SUPABASE_PROJECT_REF ?? urlEnv.replace("https://", "").split(".")[0];
const { ref, discrepancia } = refEfectivo(refDeclarado, process.env.SUPABASE_DB_USER);
const password = process.env.SUPABASE_DB_PASSWORD;

const REGIONS = [
  // dev vive en ca-central-1 y prod en us-east-2: NO comparten región, aunque una
  // versión anterior de este comentario decía que sí. Contra prod eso son varios
  // intentos fallidos antes de acertar; se saltean con SUPABASE_DB_HOST.
  // El pooler es IPv4 (la conexión directa db.<ref> es IPv6-only).
  "ca-central-1",
  "us-east-2",
  "us-east-1", "us-east-2", "us-west-1", "sa-east-1",
  "us-west-2", "eu-west-1", "eu-central-1",
];
const candidates = process.env.SUPABASE_DB_HOST
  ? [process.env.SUPABASE_DB_HOST]
  : REGIONS.flatMap((r) => [`aws-0-${r}.pooler.supabase.com`, `aws-1-${r}.pooler.supabase.com`]);

/** Errores esperables: se reportan y fijan el código de salida, sin matar el proceso. */
class SalidaLimpia extends Error {
  constructor(public codigo: number, mensaje: string) {
    super(mensaje);
  }
}

function leerRegistroEntornos(): Record<string, string> {
  if (!existsSync(REGISTRO_ENTORNOS)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRO_ENTORNOS, "utf8")) as Record<string, string>;
  } catch (e) {
    throw new SalidaLimpia(1, `${REGISTRO_ENTORNOS} no es JSON válido: ${(e as Error).message}`);
  }
}

async function connect(): Promise<Client> {
  for (const host of candidates) {
    const client = new Client({
      host,
      port: 5432, // session mode: necesario para DDL/prepared
      database: "postgres",
      // directo (db.<ref>...) usa "postgres"; el pooler usa "postgres.<ref>"
      user:
        process.env.SUPABASE_DB_USER ??
        (host.startsWith("db.") ? "postgres" : `postgres.${ref}`),
      password,
      // TODO(P2): sin verificación de certificado. Es la conexión por la que viajan
      // la contraseña y el schema entero. Verificarla necesita el CA de Supabase;
      // queda anotado como deuda, no se cambia acá para no ampliar este diff.
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 6000,
    });
    try {
      await client.connect();
      console.log(`✓ conectado via ${host}`);
      return client;
    } catch (e) {
      const msg = (e as Error).message;
      // "Tenant or user not found" = región equivocada; password mal = XX000/28P01
      console.log(`  ${host}: ${msg.slice(0, 80)}`);
      await client.end().catch(() => {});
      if (/password/i.test(msg)) throw new SalidaLimpia(2, "La contraseña de la DB fue rechazada.");
    }
  }
  throw new SalidaLimpia(2, "No se pudo conectar en ninguna región candidata.");
}

/** Anuncia el destino y, si va a escribir, exige confirmación proporcional al riesgo. */
async function confirmarDestino(
  files: string[],
  modo: Modo,
  auto: boolean,
  refConfirmado: string | undefined
): Promise<void> {
  const destino = resolverEntorno(ref, leerRegistroEntornos(), process.env.SUPABASE_DEV_REF);

  console.log("");
  console.log("  Base destino");
  console.log(`    project_ref : ${ref}          ← el discriminante real`);
  if (discrepancia) console.log(`    ⚠ ${discrepancia}`);
  console.log(`    host        : ${process.env.SUPABASE_DB_HOST ?? "(autodetecta la región)"}`);
  console.log(`    usuario     : ${process.env.SUPABASE_DB_USER ?? `postgres.${ref}`}`);
  console.log(`    entorno     : ${destino.entorno.toUpperCase()}  (${destino.fuente})`);
  console.log(`    modo        : --${modo}  (${QUE_HACE[modo]})`);
  console.log(`    archivos    : ${files.length}${files.length <= 3 ? ` (${files.join(", ")})` : ""}`);
  console.log("");

  // Los modos que no escriben no necesitan confirmación: ese es el punto de tenerlos.
  if (modo !== "apply" && modo !== "sembrar") return;
  // La siembra afirma que algo ya pasó. Se confirma siempre, incluso en desarrollo.
  if (modo === "apply" && destino.entorno === "desarrollo" && !discrepancia) return;
  if (auto && !destino.exigeConfirmacionManual && !discrepancia && modo === "apply") {
    console.log("  --yes: confirmación omitida.\n");
    return;
  }

  if (auto && (destino.exigeConfirmacionManual || discrepancia)) {
    console.log(
      destino.entorno === "produccion" && !discrepancia
        ? "  --yes NO alcanza acá: el destino es PRODUCCIÓN.\n"
        : "  --yes NO alcanza acá: el destino no está identificado sin ambigüedad.\n"
    );
  }
  // La confirmación escrita puede llegar por argumento (`--confirmar <ref>`): es
  // lo que usa el workflow de GitHub Actions, donde no hay terminal. La vara es
  // la misma que tipearla —el ref exacto— y un valor distinto corta en vez de
  // caer a la pregunta: quien pasó otro ref estaba pensando en otra base.
  if (refConfirmado !== undefined) {
    if (!refConfirmadoValido(ref, refConfirmado)) {
      throw new SalidaLimpia(4, `--confirmar no coincide con el destino (${ref}). No se aplicó nada.`);
    }
    console.log(`  Confirmación escrita recibida por argumento (${ref}).\n`);
    return;
  }
  if (!process.stdin.isTTY) {
    throw new SalidaLimpia(4, "Destino no confirmado y no hay terminal interactiva.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const r = (await rl.question(`  Escribí el ref para confirmar (${ref}): `)).trim();
  rl.close();
  if (r !== ref) throw new SalidaLimpia(4, "El ref no coincide. No se aplicó nada.");
  console.log("");
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

async function existeLedger(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ existe: boolean }>(
    "select to_regclass('ops.schema_migrations') is not null as existe"
  );
  return rows[0].existe;
}

async function leerLedger(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    "select filename, checksum from ops.schema_migrations"
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

const SQL_REGISTRAR = `
  insert into ops.schema_migrations (filename, checksum, applied_by, duration_ms)
  values ($1, $2, coalesce($4, session_user), $3)
  on conflict (filename) do update
    set checksum = excluded.checksum,
        applied_at = now(),
        applied_by = excluded.applied_by,
        duration_ms = excluded.duration_ms`;

/**
 * Aplica un archivo y anota el ledger EN LA MISMA TRANSACCIÓN.
 * En seco, la transacción termina en rollback y no queda ni el efecto ni la fila.
 */
async function aplicarArchivo(
  client: Client,
  ruta: string,
  sql: string,
  seco: boolean,
  conLedger: boolean,
  /** Si el archivo es un rollback: la migración que deshace, para sacarla del ledger. */
  deshaceA: string | null = null
): Promise<void> {
  const inicio = performance.now();
  await client.query("begin");
  try {
    await client.query(sql); // protocolo simple: multi-statement OK
    if (conLedger) {
      const ms = Math.round(performance.now() - inicio);
      await client.query(SQL_REGISTRAR, [claveLedger(ruta), checksum(sql), ms, null]);
    }
    // Un rollback que deja la fila en el ledger miente dos veces: --check-connection
    // dice "aplicada" y --apply la saltea para siempre. Va en la misma transacción
    // que el SQL del rollback: o se deshacen las dos cosas o ninguna.
    if (deshaceA) {
      await client.query("delete from ops.schema_migrations where filename = $1", [deshaceA]);
    }
    await client.query(seco ? "rollback" : "commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

/**
 * Corre TODAS las migraciones pendientes dentro de UNA transacción, y la revierte.
 *
 * POR QUÉ HACE FALTA UN MODO APARTE. `--dry-run` revierte cada archivo antes de
 * pasar al siguiente, así que valida archivos sueltos y no cadenas: una migración
 * que use una columna creada por la anterior falla ahí aunque la secuencia completa
 * sea perfecta. Eso es justo lo que pasa al poner al día una base atrasada —el caso
 * en que más falta hace saber de antemano si va a andar— y el motivo por el que
 * `docs/OPERACION.md` tenía que aclarar que los errores del dry-run son esperables.
 * Un modo de verificación cuyos errores hay que aprender a ignorar no verifica nada.
 *
 * Acá el rollback es uno solo, al final. El SQL se ejecuta de verdad contra el
 * schema y los datos reales, cada archivo ve lo que dejó el anterior, las
 * autoverificaciones de cada migración corren, y no queda nada escrito.
 *
 * Lo que este modo NO prueba: que la cadena sea rápida (una transacción larga toma
 * locks; contra una base en uso conviene una ventana tranquila), ni nada que dependa
 * de un commit intermedio.
 */
async function ensayoCadena(
  client: Client,
  files: string[],
  ledger: Map<string, string>,
  explicitos: boolean
): Promise<void> {
  const pendientes = files.filter((f) => {
    if (esRollback(f)) return false;
    if (explicitos) return true;
    const sql = readFileSync(f, "utf8");
    return compararConLedger(checksum(sql), ledger.get(claveLedger(f))).estado !== "aplicada";
  });

  console.log("  --ensayo: las pendientes corren en UNA sola transacción, que se revierte al");
  console.log("  final. Cada archivo ve lo que dejó el anterior, así que esto sí prueba la");
  console.log("  cadena completa contra el schema y los datos reales. No queda nada escrito.\n");

  if (pendientes.length === 0) {
    console.log("✓ No hay pendientes: no hay cadena que ensayar.");
    return;
  }

  await client.query("begin");
  let hechas = 0;
  try {
    for (const f of pendientes) {
      process.stdout.write(`→ ${f} ... `);
      await client.query(readFileSync(f, "utf8"));
      console.log("OK");
      hechas++;
    }
  } catch (e) {
    console.log("ERROR");
    await client.query("rollback").catch(() => {});
    throw new SalidaLimpia(
      3,
      `${(e as Error).message}\n` +
        `  Falló en la ${hechas + 1} de ${pendientes.length} (${pendientes[hechas]}).\n` +
        "  Se revirtió la transacción entera: la base quedó exactamente como estaba."
    );
  }
  await client.query("rollback");
  console.log(
    `\n✓ Las ${pendientes.length} pendientes corren limpio encadenadas. Todo revertido.`
  );
  console.log("  Para aplicarlas de verdad: --apply");
}

/** Informa contra qué se está hablando de verdad, sin correr ninguna migración. */
async function informarConexion(client: Client): Promise<void> {
  const { rows } = await client.query<{
    servidor: string; base: string; usuario: string; rol: string; ahora: string;
  }>(`select version()          as servidor,
             current_database() as base,
             session_user       as usuario,
             current_user       as rol,
             now()::text        as ahora`);
  const r = rows[0];
  console.log("");
  console.log("  Conexión");
  console.log(`    servidor : ${r.servidor.split(" on ")[0]}`);
  console.log(`    base     : ${r.base}`);
  console.log(`    usuario  : ${r.usuario}  (rol efectivo: ${r.rol})`);
  console.log(`    hora     : ${r.ahora}`);

  if (await existeLedger(client)) {
    const { rows: l } = await client.query<{ n: string; ultima: string | null }>(
      `select count(*)::text as n,
              (select filename from ops.schema_migrations
                order by applied_at desc, filename desc limit 1) as ultima
         from ops.schema_migrations`
    );
    console.log(`    ledger   : ${l[0].n} migración(es) registrada(s), última: ${l[0].ultima ?? "—"}`);
  } else {
    console.log("    ledger   : NO EXISTE");
    console.log("               base nueva      → --apply lo crea y aplica todo");
    console.log("               base preexistente → sembrar primero (--sembrar --hasta N)");
  }
  console.log("");
}

/** Crea el ledger si falta. Devuelve si quedó disponible para escribir. */
async function asegurarLedger(client: Client, seco: boolean): Promise<boolean> {
  if (await existeLedger(client)) return true;
  if (!existsSync(ARCHIVO_LEDGER)) return false;
  console.log(`\n  El ledger no existe. Aplicando primero ${ARCHIVO_LEDGER}`);
  const sqlLedger = readFileSync(ARCHIVO_LEDGER, "utf8");
  await aplicarArchivo(client, ARCHIVO_LEDGER, sqlLedger, seco, false);
  if (seco) {
    console.log("  → OK (revertido; el resto corre sin ledger)\n");
    return false;
  }
  // La fila de 0028 no puede ir en su propia transacción: la tabla no existía al
  // abrirla. Se anota inmediatamente después.
  await client.query(SQL_REGISTRAR, [claveLedger(ARCHIVO_LEDGER), checksum(sqlLedger), null, null]);
  console.log("  → OK\n");
  return true;
}

// ---------------------------------------------------------------------------
// Siembra
// ---------------------------------------------------------------------------

async function sembrar(
  client: Client,
  files: string[],
  hasta: number,
  auto: boolean,
  refConfirmado: string | undefined
) {
  const aSembrar = files.filter((f) => {
    const p = prefijo(f);
    return p != null && p <= hasta;
  });
  if (aSembrar.length === 0) {
    throw new SalidaLimpia(1, `Ninguna migración con prefijo <= ${hasta}.`);
  }

  await asegurarLedger(client, false);
  const ledger = await leerLedger(client);
  const nuevas = aSembrar.filter((f) => !ledger.has(claveLedger(f)));

  console.log("  Se van a marcar como aplicadas, SIN ejecutarlas:\n");
  for (const f of nuevas) console.log(`    ${claveLedger(f)}`);
  if (nuevas.length < aSembrar.length) {
    console.log(`\n  (${aSembrar.length - nuevas.length} ya estaban en el ledger)`);
  }
  if (nuevas.length === 0) {
    console.log("\n✓ No hay nada que sembrar: el ledger ya las tiene todas.");
    return;
  }
  console.log(
    "\n  Esto es una AFIRMACIÓN SOBRE EL PASADO: estás diciendo que estas migraciones\n" +
      "  ya corrieron en esta base. Si alguna no corrió, el runner no la va a aplicar nunca.\n"
  );

  if (!auto) {
    // Sin terminal (GitHub Actions) la confirmación escrita es el ref exacto por
    // `--confirmar`: afirmar que algo ya corrió en ESA base exige nombrarla.
    if (refConfirmado !== undefined) {
      if (!refConfirmadoValido(ref, refConfirmado)) {
        throw new SalidaLimpia(4, `--confirmar no coincide con el destino (${ref}). No se sembró nada.`);
      }
      console.log(`  Confirmación escrita recibida por argumento (${ref}).\n`);
    } else {
      if (!process.stdin.isTTY) throw new SalidaLimpia(4, "La siembra necesita confirmación.");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const r = (await rl.question(`  Escribí "sembrar" para confirmar: `)).trim();
      rl.close();
      if (r !== "sembrar") throw new SalidaLimpia(4, "Cancelado. No se sembró nada.");
      console.log("");
    }
  }

  await client.query("begin");
  try {
    for (const f of nuevas) {
      const sql = readFileSync(f, "utf8");
      await client.query(SQL_REGISTRAR, [claveLedger(f), checksum(sql), null, "siembra"]);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
  console.log(`✓ ${nuevas.length} migración(es) sembrada(s) en ${ref}. No se ejecutó ningún SQL.`);
  console.log("  Verificá con --check-connection y seguí con --dry-run.");
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const r = resolverModo(args);
  if ("error" in r) throw new SalidaLimpia(1, r.error);
  const modo = r.modo;
  const auto = args.includes("--yes");
  const permitirDivergencia = args.includes("--permitir-divergencia");
  const hastaRaw = valorDeFlag(args, "--hasta");
  const hasta = hastaRaw !== undefined ? parseInt(hastaRaw, 10) : NaN;
  const refConfirmado = valorDeFlag(args, "--confirmar");
  const explicit = archivosExplicitos(args, ["--hasta", "--confirmar"]);

  if (!ref) throw new SalidaLimpia(1, "Falta SUPABASE_PROJECT_REF o NEXT_PUBLIC_SUPABASE_URL");
  if (!password && modo !== "print-target") throw new SalidaLimpia(1, "Falta SUPABASE_DB_PASSWORD");
  if (modo === "sembrar" && !Number.isFinite(hasta)) {
    throw new SalidaLimpia(1, "--sembrar necesita --hasta N (por ejemplo: --sembrar --hasta 0027)");
  }

  let files: string[];
  if (explicit.length > 0) {
    files = explicit;
  } else {
    const { orden, prefijosDuplicados, sinPrefijo } = ordenarMigraciones(
      readdirSync(DIR_MIGRACIONES)
    );
    if (prefijosDuplicados.length > 0) {
      throw new SalidaLimpia(
        1,
        `Prefijos repetidos en ${DIR_MIGRACIONES}: ${prefijosDuplicados.join(", ")}. ` +
          "El orden entre ellos es ambiguo."
      );
    }
    if (sinPrefijo.length > 0) {
      throw new SalidaLimpia(1, `Sin prefijo numérico: ${sinPrefijo.join(", ")}.`);
    }
    files = orden.map((f) => join(DIR_MIGRACIONES, f));
  }

  await confirmarDestino(files, modo, auto, refConfirmado);
  if (modo === "print-target") return;

  const client = await connect();
  try {
    // Un ALTER TABLE detrás de una transacción larga de la app esperaría el lock
    // para siempre y, mientras tanto, frenaría a todo el que venga después. Con
    // tope, el runner falla rápido y se reintenta en un momento tranquilo.
    await client.query("set lock_timeout = '10s'");
    if (modo === "apply" || modo === "sembrar") {
      // Un solo runner escribiendo por vez (dos corridas a la vez —una desde la
      // Mac y otra desde GitHub Actions— aplicarían el mismo archivo dos veces).
      const { rows } = await client.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('crm-mx-migrate')) as ok"
      );
      if (!rows[0].ok) {
        throw new SalidaLimpia(7, "Otra corrida del runner tiene el candado sobre esta base. Esperá a que termine.");
      }
    }
    if (modo === "check-connection") return await informarConexion(client);
    if (modo === "sembrar") return await sembrar(client, files, hasta, auto, refConfirmado);

    const seco = modo === "dry-run" || modo === "ensayo";

    // Los rollbacks nunca tocan el ledger, así que tampoco justifican crearlo.
    const soloRollbacks = files.every(esRollback);

    // ESTE CHEQUEO VA ANTES DE CUALQUIER ESCRITURA, incluida la del propio ledger.
    //
    // Un ledger vacío contra una base que YA tiene migraciones aplicadas termina
    // re-ejecutando 0001, que no es re-ejecutable (`create type … as enum` no admite
    // `if not exists`): muere con "already exists" en el archivo 1 de 28.
    //
    // La pregunta no es cuántas filas tiene el ledger sino si la base ya está migrada,
    // y eso se puede comprobar: si existe `public.doctors`, las migraciones corrieron.
    // Así una base nueva de verdad no necesita ningún flag extra.
    //
    // Ponerlo después de crear el ledger fue un error real: una corrida que el runner
    // iba a rechazar igual alcanzaba a escribir el schema `ops` antes de rechazarla.
    // Un runner no puede escribir nada antes de decidir si tiene que correr.
    if (!soloRollbacks && files.length > 3 && explicit.length === 0) {
      // Dos consultas y no una: Postgres resuelve `ops.schema_migrations` al parsear,
      // así que nombrarla cuando todavía no existe hace fallar la consulta entera.
      const { rows } = await client.query<{ migrada: boolean; hay_tabla: boolean }>(
        `select to_regclass('public.doctors') is not null           as migrada,
                to_regclass('ops.schema_migrations') is not null    as hay_tabla`
      );
      let filas = 0;
      if (rows[0].hay_tabla) {
        const r2 = await client.query<{ n: number }>(
          "select count(*)::int as n from ops.schema_migrations"
        );
        filas = r2.rows[0].n;
      }
      if (rows[0].migrada && filas <= 1) {
        throw new SalidaLimpia(
          6,
          `Esta base ya está migrada (existe public.doctors) pero el ledger tiene ${filas} fila(s).\n` +
            "  Correr las 28 migraciones encima fallaría en 0001 y no probaría nada.\n\n" +
            "  Sembrá el ledger primero, con lo que ya esté aplicado en ESTA base:\n" +
            "    npx tsx scripts/db-migrate.ts --sembrar --hasta 0027\n\n" +
            "  (--sembrar no ejecuta SQL de migración: solo anota el ledger.)"
        );
      }
    }

    const hayLedger = soloRollbacks
      ? await existeLedger(client)
      : await asegurarLedger(client, seco);

    const ledger = hayLedger ? await leerLedger(client) : new Map<string, string>();
    if (!hayLedger && !soloRollbacks) {
      console.log("  ⚠ Sin ledger: no se puede saber qué está aplicado ni registrar nada.\n");
    }

    if (modo === "ensayo") {
      return await ensayoCadena(client, files, ledger, explicit.length > 0);
    }

    if (seco) {
      console.log("  --dry-run: cada archivo corre dentro de una transacción que termina");
      console.log("  en ROLLBACK. El SQL se ejecuta de verdad, pero no queda nada escrito.");
      console.log("  Ojo: como cada archivo se revierte, una migración que dependa de la");
      console.log("  anterior va a fallar acá aunque la cadena completa sea correcta.");
      console.log("  Para probar la cadena entera de una vez: --ensayo\n");
    }

    let aplicados = 0;
    let salteados = 0;

    for (const f of files) {
      const sql = readFileSync(f, "utf8");
      const rollback = esRollback(f);
      const estado = compararConLedger(checksum(sql), ledger.get(claveLedger(f)));

      // Nombrar un archivo explícitamente es pedir que se re-aplique.
      if (!rollback && estado.estado === "aplicada" && explicit.length === 0) {
        salteados++;
        continue;
      }
      if (!rollback && estado.estado === "divergente" && !permitirDivergencia) {
        throw new SalidaLimpia(
          5,
          `${f} cambió después de haberse aplicado.\n` +
            `    ledger : ${estado.checksumLedger.slice(0, 16)}…\n` +
            `    archivo: ${estado.checksumArchivo.slice(0, 16)}…\n` +
            "  La base y el archivo no dicen lo mismo. Revisá el diff antes de seguir.\n" +
            "  Si el cambio es intencional y seguro de re-aplicar: --permitir-divergencia"
        );
      }

      const etiqueta =
        rollback ? " (rollback, no se anota en el ledger)"
        : estado.estado === "divergente" ? " (divergente, forzada)"
        : estado.estado === "aplicada" ? " (re-aplicada)"
        : "";
      process.stdout.write(`→ ${f}${etiqueta} ... `);
      try {
        await aplicarArchivo(
          client,
          f,
          sql,
          seco,
          hayLedger && !rollback,
          rollback && hayLedger ? migracionQueDeshace(f) : null
        );
        console.log(seco ? "OK (revertido)" : "OK");
        aplicados++;
      } catch (e) {
        console.log("ERROR");
        throw new SalidaLimpia(
          3,
          `${(e as Error).message}\n  La transacción se revirtió: esta migración no quedó a medias.`
        );
      }
    }

    const resumen = `${aplicados} aplicada(s)${salteados > 0 ? `, ${salteados} ya estaban` : ""}`;
    if (seco) {
      console.log(`\n✓ ${resumen} en seco sobre ${ref}. No se escribió nada.`);
      console.log("  Para aplicarlas de verdad, repetí el comando con --apply.");
    } else {
      console.log(`\n✓ ${resumen} sobre ${ref}`);
      if (!hayLedger) console.log("  Sin ledger: anotá la corrida en supabase/HOTFIX_LOG.md.");
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  if (e instanceof SalidaLimpia) {
    console.error(`✗ ${e.message}`);
    process.exitCode = e.codigo;
    return;
  }
  console.error(e);
  process.exitCode = 9;
});

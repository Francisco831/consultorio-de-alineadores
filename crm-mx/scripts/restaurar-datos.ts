/**
 * Restaura un volcado de scripts/backup-datos.ts en una base. Es la otra mitad
 * del respaldo: un backup que nunca se restauró es una hipótesis, no un plan.
 *
 *   npx tsx scripts/restaurar-datos.ts --desde <dir> [--con-auth] [--confirmar <ref>] [--yes]
 *
 * QUÉ HACE. Vacía TODAS las tablas de `public` del destino y carga los .ndjson
 * del directorio, en UNA transacción: si algo falla a la mitad, la base queda
 * como estaba. Con `--con-auth` reemplaza además auth.users y auth.identities
 * (hace falta en un proyecto nuevo —profiles.id apunta a auth.users y Supabase
 * no deja crear cuentas con un id elegido— y sirve para que desarrollo tenga las
 * mismas cuentas que producción).
 *
 * ES DESTRUCTIVA: pide el ref escrito siempre, también en desarrollo
 * (scripts/lib/destino.ts). En GitHub Actions no hay terminal: el ref va por
 * `--confirmar`, con la misma vara. Contra producción solo tiene sentido en un
 * desastre real, y ahí también hay que escribir el ref.
 *
 * REQUISITO. El destino tiene que estar al menos tan adelante como el volcado en
 * migraciones (se compara ops.schema_migrations con el manifiesto). Las columnas
 * se cargan por intersección: lo que el volcado trae y el destino no tiene se
 * ignora; lo que el destino tiene y el volcado no, queda con su default.
 *
 * CÓMO CARGA. `session_replication_role = replica` mientras entra la data: apaga
 * triggers (audit, recompute, guards, cupo) y las FK, así el orden de las tablas
 * no importa y no se recalcula nada durante la carga. Al final se comparan los
 * conteos con el manifiesto, y recién si cierran se confirma.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import type { Client } from "pg";
import { connectDb, projectRef } from "./lib/pg";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

const LOTE = 1000;

interface Manifiesto {
  project_ref: string;
  fecha: string;
  tablas: Record<string, number>;
  filas_totales: number;
  migraciones_aplicadas: string[] | null;
}

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function columnasCargables(db: Client, schema: string, tabla: string): Promise<string[]> {
  // Las columnas generadas (auth.users.confirmed_at, auth.identities.email) no
  // aceptan un valor: se dejan afuera y Postgres las calcula.
  const { rows } = await db.query<{ c: string }>(
    `select column_name as c
       from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_generated <> 'ALWAYS'
      order by ordinal_position`,
    [schema, tabla]
  );
  return rows.map((r) => r.c);
}

function leerNdjson(archivo: string): Record<string, unknown>[] {
  return readFileSync(archivo, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function cargar(
  db: Client,
  schema: string,
  tabla: string,
  filas: Record<string, unknown>[]
): Promise<number> {
  if (filas.length === 0) return 0;
  const destino = await columnasCargables(db, schema, tabla);
  const enVolcado = new Set(Object.keys(filas[0]));
  const cols = destino.filter((c) => enVolcado.has(c));
  const ignoradas = [...enVolcado].filter((c) => !destino.includes(c));
  if (ignoradas.length) {
    console.log(`      (${tabla}: el destino no tiene ${ignoradas.join(", ")} — se ignoran)`);
  }
  const lista = cols.map((c) => `"${c}"`).join(", ");
  // jsonb_populate_recordset resuelve los tipos (enums, arrays, jsonb, fechas)
  // a partir de la definición de la tabla: no hay que tipear nada a mano.
  const sql = `insert into "${schema}"."${tabla}" (${lista})
               select ${lista} from jsonb_populate_recordset(null::"${schema}"."${tabla}", $1::jsonb)`;
  let n = 0;
  for (let i = 0; i < filas.length; i += LOTE) {
    const lote = filas.slice(i, i + LOTE);
    await db.query(sql, [JSON.stringify(lote)]);
    n += lote.length;
  }
  return n;
}

async function main() {
  const dir = argValor("--desde");
  if (!dir || !existsSync(join(dir, "manifiesto.json"))) {
    throw new Error("Falta --desde <directorio con manifiesto.json>");
  }
  const conAuth = process.argv.includes("--con-auth");
  const forzarSchema = process.argv.includes("--forzar-schema");
  // --ensayo: hace TODO (vaciar, cargar, verificar conteos) y revierte al final.
  // Es la prueba de que el volcado se puede restaurar sin dejar nada escrito.
  const ensayo = process.argv.includes("--ensayo");
  const manifiesto = JSON.parse(readFileSync(join(dir, "manifiesto.json"), "utf8")) as Manifiesto;

  const tablasPublic = Object.keys(manifiesto.tablas).filter((t) => !t.startsWith("auth."));
  const filasPublic = tablasPublic.reduce((a, t) => a + manifiesto.tablas[t], 0);

  await confirmarDestino({
    accion:
      `restaurar ${dir} (${filasPublic.toLocaleString("es-AR")} filas de ${manifiesto.project_ref}, ` +
      `${manifiesto.fecha.slice(0, 16)}) — VACÍA public${conAuth ? " y las cuentas de auth" : ""}` +
      (ensayo ? "  [ENSAYO: se revierte todo al final]" : ""),
    // en ensayo no queda nada escrito: no es destructivo y no pide el ref
    destructivo: !ensayo,
    auto: process.argv.includes("--yes"),
    refEfectivo: projectRef(),
    refConfirmado: argValor("--confirmar"),
  }).catch(salirConDestinoRechazado);

  const db = await connectDb();
  try {
    // 1. el destino tiene que tener el schema del volcado (o más nuevo)
    const { rows: ledger } = await db.query<{ f: string }>(
      "select filename as f from ops.schema_migrations"
    );
    const aplicadas = new Set(ledger.map((r) => r.f));
    const faltan = (manifiesto.migraciones_aplicadas ?? []).filter((m) => !aplicadas.has(m));
    if (faltan.length && !forzarSchema) {
      throw new Error(
        `El destino no tiene ${faltan.length} migración(es) que el volcado sí tenía ` +
          `(${faltan.slice(0, 3).join(", ")}…). Aplicalas primero con db-migrate, ` +
          `o pasá --forzar-schema a conciencia.`
      );
    }

    const { rows: existentes } = await db.query<{ t: string }>(`
      select table_name as t from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`);
    const enDestino = new Set(existentes.map((r) => r.t));
    const sinDestino = tablasPublic.filter((t) => !enDestino.has(t));
    if (sinDestino.length && !forzarSchema) {
      throw new Error(
        `El volcado trae tablas que el destino no tiene: ${sinDestino.join(", ")}. ` +
          `Esa data se perdería. Aplicá las migraciones o pasá --forzar-schema.`
      );
    }
    const soloDestino = existentes.map((r) => r.t).filter((t) => !(t in manifiesto.tablas));
    if (soloDestino.length) {
      console.log(`  ⚠ tablas del destino que el volcado no trae (quedan vacías): ${soloDestino.join(", ")}`);
    }

    console.log(`\n  Restaurando en ${projectRef()} …\n`);
    await db.query("begin");
    // Sin triggers ni FK durante la carga: el orden no importa y nada recalcula.
    await db.query("set local session_replication_role = 'replica'");
    // Las tablas se vacían todas juntas para que ninguna quede referenciando lo
    // viejo. CASCADE por las FK que apuntan a public desde otro schema (por
    // ejemplo la foto ops.geo_0049_backup): TRUNCATE las exige en la misma orden.
    const todas = existentes.map((r) => `"public"."${r.t}"`).join(", ");
    await db.query(`truncate table ${todas} cascade`);

    const cargadas: Record<string, number> = {};
    for (const t of tablasPublic) {
      if (!enDestino.has(t)) continue;
      const filas = leerNdjson(join(dir, `${t}.ndjson`));
      cargadas[t] = await cargar(db, "public", t, filas);
      console.log(`    ${t.padEnd(24)} ${String(cargadas[t]).padStart(7)} filas`);
    }

    if (conAuth) {
      // Las sesiones abiertas del destino se invalidan: los ids de usuario cambian.
      for (const t of ["refresh_tokens", "sessions", "mfa_factors", "one_time_tokens", "identities", "users"]) {
        await db.query(`delete from "auth"."${t}"`).catch((e: Error) => {
          if (!/does not exist/.test(e.message)) throw e;
        });
      }
      for (const t of ["users", "identities"]) {
        const archivo = join(dir, `auth.${t}.ndjson`);
        if (!existsSync(archivo)) {
          throw new Error(`--con-auth: el volcado no trae auth.${t}.ndjson`);
        }
        const filas = leerNdjson(archivo);
        cargadas[`auth.${t}`] = await cargar(db, "auth", t, filas);
        console.log(`    ${`auth.${t}`.padEnd(24)} ${String(cargadas[`auth.${t}`]).padStart(7)} filas`);
      }
    }

    await db.query("set local session_replication_role = 'origin'");

    // 2. los conteos tienen que cerrar contra el manifiesto, tabla por tabla
    const desvios: string[] = [];
    for (const [t, esperado] of Object.entries(cargadas)) {
      const [schema, tabla] = t.includes(".") ? t.split(".") : ["public", t];
      const { rows } = await db.query<{ n: string }>(`select count(*) as n from "${schema}"."${tabla}"`);
      const real = Number(rows[0].n);
      if (real !== esperado || esperado !== manifiesto.tablas[t]) {
        desvios.push(`${t}: manifiesto ${manifiesto.tablas[t]}, cargadas ${esperado}, en base ${real}`);
      }
    }
    if (desvios.length) {
      await db.query("rollback");
      throw new Error(`Los conteos no cierran, se revirtió todo:\n    ${desvios.join("\n    ")}`);
    }
    const total = Object.values(cargadas).reduce((a, b) => a + b, 0);
    if (ensayo) {
      await db.query("rollback");
      console.log(`\n  ✓ ENSAYO OK: ${Object.keys(cargadas).length} tablas · ${total.toLocaleString("es-AR")} filas cargaron y los conteos cierran. Todo revertido.`);
      return;
    }
    await db.query("commit");
    await db.query("analyze");

    console.log(`\n  ✓ Restaurado: ${Object.keys(cargadas).length} tablas · ${total.toLocaleString("es-AR")} filas, conteos verificados.`);
    console.log(`    Los scores ya vienen en el volcado; el pg_cron nocturno los vuelve a calcular igual.`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});

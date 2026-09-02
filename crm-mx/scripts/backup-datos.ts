/**
 * Volcado de datos de una base del CRM. Solo lee.
 *
 *   npx tsx scripts/backup-datos.ts                    # a ~/crm-mx-backups/<ref>-<fecha>/
 *   npx tsx scripts/backup-datos.ts --destino /otra/ruta
 *
 * POR QUÉ EXISTE. Los dos proyectos de Supabase están en plan Free, que **no incluye
 * respaldos**: ni diarios ni point-in-time. Hasta que eso cambie, esto es lo único que
 * hay antes de una migración. Ver docs/OPERACION.md.
 *
 * QUÉ ES Y QUÉ NO ES.
 *  - Es un volcado de **datos**: cada tabla de `public` a un archivo NDJSON (una fila
 *    por línea), más un manifiesto con conteos, versión del servidor y fecha.
 *  - **No** es un `pg_dump`: no lleva schema, roles, policies ni secuencias. El schema
 *    de esta base son las migraciones de `supabase/migrations/`, y el manifiesto anota
 *    hasta cuál está aplicada, así que la recuperación es: crear base → correr las
 *    migraciones hasta ese número → recargar estos archivos.
 *  - Va por conexión directa a Postgres, no por PostgREST: no hay tope de 1.000 filas.
 *
 * DÓNDE ESCRIBE. Fuera del repositorio, a propósito: el volcado tiene 7.034 doctores
 * con teléfono y nombres de paciente. No debe terminar en git por accidente.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "dotenv";
import { connectDb, projectRef } from "./lib/pg";

config({ path: ".env.local" });

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const ref = projectRef();
  const sello = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const base = argValor("--destino") ?? join(homedir(), "crm-mx-backups");
  const dir = join(base, `${ref}-${sello}`);
  mkdirSync(dir, { recursive: true });

  console.log(`\n  Volcado de datos`);
  console.log(`    base    : ${ref}`);
  console.log(`    destino : ${dir}\n`);

  const db = await connectDb();
  try {
    const { rows: version } = await db.query<{ v: string }>("select version() as v");
    const { rows: tablas } = await db.query<{ t: string }>(`
      select table_name as t
        from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by 1
    `);

    const conteos: Record<string, number> = {};
    // Vuelca una tabla a <schema>.<tabla>.ndjson (las de public van sin prefijo,
    // que es el nombre que scripts/restaurar-datos.ts espera). Ordena por la
    // clave primaria si la hay, para que dos volcados de la misma base sean
    // comparables línea a línea.
    const volcar = async (schema: string, t: string, archivoNombre: string) => {
      const { rows: pk } = await db.query<{ c: string }>(`
        select a.attname as c
          from pg_index i
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = '${schema}.${t}'::regclass and i.indisprimary
         order by a.attnum
      `);
      const orden = pk.length ? ` order by ${pk.map((r) => `"${r.c}"`).join(", ")}` : "";
      const { rows } = await db.query(`select * from "${schema}"."${t}"${orden}`);

      const archivo = join(dir, `${archivoNombre}.ndjson`);
      writeFileSync(archivo, "");
      for (const fila of rows) appendFileSync(archivo, JSON.stringify(fila) + "\n");
      conteos[archivoNombre] = rows.length;
      console.log(`    ${archivoNombre.padEnd(24)} ${String(rows.length).padStart(7)} filas`);
    };

    for (const { t } of tablas) await volcar("public", t, t);

    // Las cuentas. Sin esto el volcado no alcanza para levantar el CRM en un
    // proyecto nuevo: profiles.id apunta a auth.users(id) y Supabase no deja
    // crear un usuario con un id elegido por API. Van con su hash de contraseña,
    // que es justamente lo que permite que la gente siga entrando después de una
    // restauración. Si el rol de conexión no puede leerlas, se avisa y se sigue:
    // un respaldo sin cuentas es peor que ninguno, pero no por eso se aborta.
    for (const t of ["users", "identities"]) {
      try {
        await volcar("auth", t, `auth.${t}`);
      } catch (e) {
        console.log(`    ⚠ auth.${t}: no se pudo volcar (${(e as Error).message})`);
      }
    }

    // Hasta qué migración está esta base, si tiene ledger. Sin él se anota null:
    // adivinarlo sería peor que no decirlo.
    let ledger: string[] | null = null;
    const { rows: existe } = await db.query<{ e: boolean }>(
      "select to_regclass('ops.schema_migrations') is not null as e"
    );
    if (existe[0].e) {
      const { rows } = await db.query<{ f: string }>(
        "select filename as f from ops.schema_migrations order by filename"
      );
      ledger = rows.map((r) => r.f);
    }

    const total = Object.values(conteos).reduce((a, b) => a + b, 0);
    writeFileSync(
      join(dir, "manifiesto.json"),
      JSON.stringify(
        {
          project_ref: ref,
          fecha: new Date().toISOString(),
          servidor: version[0].v,
          tablas: conteos,
          filas_totales: total,
          migraciones_aplicadas: ledger,
          nota:
            "Volcado de DATOS, no de schema. Para recuperar: crear la base, correr " +
            "supabase/migrations hasta la última de migraciones_aplicadas, y cargar " +
            "este directorio con scripts/restaurar-datos.ts (--con-auth si el proyecto " +
            "es nuevo y hay que traer las cuentas).",
        },
        null,
        2
      )
    );

    console.log(`\n  ✓ ${tablas.length} tablas · ${total.toLocaleString("es-AR")} filas`);
    console.log(`    manifiesto: ${join(dir, "manifiesto.json")}`);
    if (!ledger) console.log(`    ⚠ esta base no tiene ledger: no se pudo anotar hasta qué migración está`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});

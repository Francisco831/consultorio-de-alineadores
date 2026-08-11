/**
 * Compara el schema de las dos bases. Solo lee catálogos: no toca datos.
 *
 *   npx tsx scripts/diff-entornos.ts
 *   npx tsx scripts/diff-entornos.ts --a <ref> --b <ref>
 *
 * POR QUÉ EXISTE. Las dos bases divergieron sin que nadie se enterara: producción
 * quedó en la migración 0021 mientras desarrollo llegaba a la 0028, y las dos tenían
 * los mismos 7.034 doctores reales, así que desde afuera parecían iguales. El criterio
 * G5 del checklist Go/No-Go ("el schema de producción coincide con el de desarrollo")
 * no se puede sostener con una afirmación: necesita una salida que se pueda volver a
 * generar. Esto es esa salida.
 *
 * Sale con código 1 si hay diferencias, así que sirve como chequeo, no solo como
 * informe. Compara tablas, columnas (con tipo y nulabilidad), funciones (con firma) y
 * policies. No compara datos, índices ni constraints.
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { connectDb } from "./lib/pg";

config({ path: ".env.local" });

const REGISTRO = "supabase/environments.json";

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Los refs salen del registro de entornos, así que no hay que escribirlos a mano. */
function refsPorDefecto(): { a: string; b: string } {
  const reg = JSON.parse(readFileSync(REGISTRO, "utf8")) as Record<string, string>;
  const porEntorno = (e: string) =>
    Object.entries(reg).find(([k, v]) => !k.startsWith("_") && v === e)?.[0];
  const dev = porEntorno("desarrollo");
  const prod = porEntorno("produccion");
  if (!dev || !prod) {
    throw new Error(
      `${REGISTRO} no tiene registrados los dos entornos. Pasá --a <ref> --b <ref>.`
    );
  }
  return { a: dev, b: prod };
}

interface Inventario {
  tablas: Set<string>;
  columnas: Set<string>;
  funciones: Set<string>;
  policies: Set<string>;
}

async function inventario(ref: string): Promise<Inventario> {
  process.env.SUPABASE_PROJECT_REF = ref;
  // El host se autodetecta por región; las dos bases NO están en la misma.
  delete process.env.SUPABASE_DB_HOST;
  const db = await connectDb();
  try {
    const set = async (sql: string) =>
      new Set((await db.query<{ k: string }>(sql)).rows.map((r) => r.k));
    return {
      tablas: await set(`
        select table_name as k from information_schema.tables
         where table_schema='public' and table_type='BASE TABLE'`),
      // El tipo y la nulabilidad van en la clave: una columna que existe en las dos
      // pero con distinto tipo es una diferencia, y de las que rompen en runtime.
      columnas: await set(`
        select table_name||'.'||column_name||' '||data_type||
               case when is_nullable='YES' then ' null' else ' not null' end as k
          from information_schema.columns where table_schema='public'`),
      funciones: await set(`
        select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as k
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public'`),
      policies: await set(`
        select tablename||' · '||policyname as k from pg_policies where schemaname='public'`),
    };
  } finally {
    await db.end();
  }
}

const soloEn = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();

async function main() {
  const porDefecto = refsPorDefecto();
  const refA = argValor("--a") ?? porDefecto.a;
  const refB = argValor("--b") ?? porDefecto.b;

  console.log(`\n  Diff de schema\n    A: ${refA}\n    B: ${refB}\n`);
  const a = await inventario(refA);
  const b = await inventario(refB);

  let diferencias = 0;
  const comparar = (titulo: string, ka: Set<string>, kb: Set<string>) => {
    const enA = soloEn(ka, kb);
    const enB = soloEn(kb, ka);
    diferencias += enA.length + enB.length;
    const marca = enA.length + enB.length === 0 ? "✓" : "✗";
    console.log(`  ${marca} ${titulo}: ${ka.size} en A · ${kb.size} en B`);
    for (const x of enA) console.log(`      solo en A: ${x}`);
    for (const x of enB) console.log(`      solo en B: ${x}`);
  };

  comparar("tablas", a.tablas, b.tablas);
  comparar("columnas", a.columnas, b.columnas);
  comparar("funciones", a.funciones, b.funciones);
  comparar("policies", a.policies, b.policies);

  if (diferencias === 0) {
    console.log(`\n✓ Los dos schemas coinciden. (G5)`);
    return;
  }
  console.log(`\n✗ ${diferencias} diferencia(s). Los schemas NO coinciden.`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(2);
});

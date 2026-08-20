// Guarda en meta.seq el número de fila original de cada movimiento sembrado.
// Hace falta porque el costeo de cuotas del script viejo depende del ORDEN de las
// filas (la primera que menciona una cuota se la lleva), y sin este dato no se
// puede reproducir su resultado ni auditar por qué una cuota se costeó y otra no.
//
// Uso: npx tsx scripts/backfill-seq.ts --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { Client } from "pg";
import { argFlags } from "./lib/service-client";
import { KeyBuilder } from "../lib/import/keys";

config({ path: resolve(__dirname, "../.env.local") });

type MovAR = {
  fecha: string; tab: string; paciente: string | null;
  ars: number; usd: number; motivo: string | null;
};

async function main() {
  const flags = argFlags();
  const filas: MovAR[] = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/movimientos_ar_2026.json"), "utf8")
  );

  // reconstruye las MISMAS external_key que generó el seed, en el mismo orden
  const keys = new KeyBuilder();
  const orden: Array<{ key: string; seq: number }> = [];
  let seq = 0;
  for (const m of filas) {
    for (const currency of ["ARS", "USD"] as const) {
      const monto = currency === "ARS" ? m.ars : m.usd;
      if ((monto ?? 0) === 0) continue;
      orden.push({
        key: keys.build("caja", m.tab, m.fecha, m.paciente, m.ars, m.usd, m.motivo, currency),
        seq,
      });
    }
    seq++;   // el número de FILA original, compartido por sus patas
  }
  console.log(`${orden.length} claves reconstruidas de ${filas.length} filas`);

  if (flags.dryRun) { console.log("DRY-RUN (sin --apply no escribe)."); return; }

  // UNA sola sentencia: 878 updates de a uno contra Supabase remoto tardan minutos
  const c = new Client({
    host: process.env.SUPABASE_DB_HOST, port: 5432,
    user: `postgres.${process.env.SUPABASE_PROJECT_REF}`,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: "postgres", ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  console.log(`  destino: ${process.env.SUPABASE_PROJECT_REF}`);
  try {
    const res = await c.query(
      `update movements m
          set meta = m.meta || jsonb_build_object('seq', v.seq)
         from (select unnest($1::text[]) as key, unnest($2::int[]) as seq) v
        where m.external_key = v.key`,
      [orden.map((o) => o.key), orden.map((o) => o.seq)]
    );
    console.log(`✓ ${res.rowCount} movimientos con su orden original`);
    if (res.rowCount !== orden.length) {
      console.error(`✗ se esperaban ${orden.length}: el seed y este script divergieron`);
      process.exit(1);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

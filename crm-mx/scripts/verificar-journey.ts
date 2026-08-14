/**
 * Verifica que la Conversión 1 siga funcionando después del guard de 0019.
 *
 * El guard (doctors_guard) bloquea que un usuario escriba is_accredited a mano.
 * La acreditación legítima la hace el trigger de journey al mover el kanban.
 * Los dos son BEFORE triggers y Postgres los ejecuta en orden ALFABÉTICO:
 * doctors_guard_trg  <  doctors_journey_trg  → el guard ve el UPDATE original
 * (donde is_accredited no cambió) y deja pasar; después journey lo acredita.
 *
 * Este script lo prueba de verdad: crea un prospecto, lo mueve a 'acreditado'
 * simulando la sesión de un usuario (app.system apagado) y verifica el efecto.
 * Al final borra todo lo que creó.
 *
 *   SUPABASE_DB_HOST=… SUPABASE_PROJECT_REF=… npx tsx scripts/verificar-journey.ts
 */
import { Client } from "pg";
import { config } from "dotenv";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

const ref =
  process.env.SUPABASE_PROJECT_REF ??
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace("https://", "").split(".")[0];
const host = process.env.SUPABASE_DB_HOST ?? "aws-0-ca-central-1.pooler.supabase.com";

async function main() {
  await confirmarDestino({
    accion: "crear y borrar un doctor de prueba para verificar los triggers del journey",
    destructivo: true,
    refEfectivo: ref,
    auto: process.argv.includes("--yes"),
  });
  const db = new Client({
    host,
    port: 5432,
    database: "postgres",
    user: host.startsWith("db.") ? "postgres" : `postgres.${ref}`,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await db.connect();

  const { rows: trg } = await db.query(
    `select tgname from pg_trigger
     where tgrelid = 'doctors'::regclass and not tgisinternal
     order by tgname`
  );
  console.log("triggers de doctors (orden de ejecución):");
  for (const t of trg) console.log("   ", t.tgname);
  const g = trg.findIndex((t) => t.tgname === "doctors_guard_trg");
  const j = trg.findIndex((t) => t.tgname === "doctors_journey_trg");
  console.log(
    g < j
      ? "✓ el guard corre ANTES que journey (la Conversión 1 puede acreditar)"
      : "✗ ORDEN INVERTIDO: journey acreditaría y el guard lo rechazaría"
  );

  // ---- prueba real end-to-end ----
  const { rows: ins } = await db.query(
    `insert into doctors (nombre, lifecycle_stage, acquisition_stage, is_demo)
     values ('ZZ Prueba Journey', 'contactado', 'contactado', true)
     returning id, is_accredited`
  );
  const id = ins[0].id;
  console.log(`\nprospecto de prueba creado (is_accredited=${ins[0].is_accredited})`);

  // simula la sesión de un usuario: app.system explícitamente apagado
  await db.query(`select set_config('app.system', 'off', false)`);
  try {
    await db.query(
      `update doctors set is_accredited = true where id = $1`,
      [id]
    );
    console.log("✗ el guard NO bloqueó la escritura directa de is_accredited");
  } catch (e) {
    console.log(`✓ guard bloqueó la escritura directa: "${(e as Error).message}"`);
  }

  await db.query(
    `update doctors set acquisition_stage = 'acreditado' where id = $1`,
    [id]
  );
  const { rows: after } = await db.query(
    `select is_accredited, accredited_at, lifecycle_stage, activation_stage
     from doctors where id = $1`,
    [id]
  );
  const a = after[0];
  console.log(
    a.is_accredited && a.accredited_at
      ? `✓ CONVERSIÓN 1 OK — acreditado el ${new Date(a.accredited_at).toISOString().slice(0, 10)}, lifecycle=${a.lifecycle_stage}, activación=${a.activation_stage}`
      : `✗ la conversión NO se registró: ${JSON.stringify(a)}`
  );

  await db.query(`select set_config('app.system', 'on', false)`);
  await db.query(`delete from doctors where id = $1`, [id]);
  console.log("prospecto de prueba borrado");
  await db.end();
}

main().catch((e) => {
  salirConDestinoRechazado(e);
  console.error("Falló:", e);
  process.exit(1);
});

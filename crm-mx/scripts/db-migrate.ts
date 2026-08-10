/**
 * Corre las migraciones SQL contra el Postgres de Supabase (via pooler, session mode).
 *
 *   SUPABASE_DB_PASSWORD=... npx tsx scripts/db-migrate.ts [archivo1.sql ...]
 *
 * Sin args corre supabase/migrations/*.sql en orden. Variables:
 *   SUPABASE_PROJECT_REF (default: ref de NEXT_PUBLIC_SUPABASE_URL en .env.local)
 *   SUPABASE_DB_HOST     (si se conoce; si no, prueba las regiones comunes)
 */
import { Client } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ref = process.env.SUPABASE_PROJECT_REF ?? url.replace("https://", "").split(".")[0];
const password = process.env.SUPABASE_DB_PASSWORD;
if (!ref || !password) {
  console.error("Faltan SUPABASE_PROJECT_REF/NEXT_PUBLIC_SUPABASE_URL o SUPABASE_DB_PASSWORD");
  process.exit(1);
}

const REGIONS = [
  "ca-central-1", // ambos proyectos viven acá; el pooler es IPv4 (la directa db.<ref> es IPv6-only)
  "us-east-1", "us-east-2", "us-west-1", "sa-east-1",
  "us-west-2", "eu-west-1", "eu-central-1",
];
const candidates = process.env.SUPABASE_DB_HOST
  ? [process.env.SUPABASE_DB_HOST]
  : REGIONS.flatMap((r) => [`aws-0-${r}.pooler.supabase.com`, `aws-1-${r}.pooler.supabase.com`]);

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
      if (/password/i.test(msg)) {
        console.error("✗ La contraseña de la DB fue rechazada.");
        process.exit(2);
      }
    }
  }
  console.error("✗ No se pudo conectar en ninguna región candidata.");
  process.exit(2);
}

async function main() {
  const files =
    process.argv.length > 2
      ? process.argv.slice(2)
      : readdirSync("supabase/migrations")
          .filter((f) => f.endsWith(".sql"))
          .sort()
          .map((f) => join("supabase/migrations", f));

  const client = await connect();
  for (const f of files) {
    const sql = readFileSync(f, "utf8");
    process.stdout.write(`→ ${f} ... `);
    try {
      await client.query(sql); // protocolo simple: multi-statement OK
      console.log("OK");
    } catch (e) {
      console.log("ERROR");
      console.error((e as Error).message);
      await client.end();
      process.exit(3);
    }
  }
  await client.end();
  console.log("✓ migraciones aplicadas");
}

main();

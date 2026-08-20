// Conexión directa a Postgres para los scripts de verificación.
//
// El pooler en modo sesión (puerto 5432) es necesario para DDL y para
// `set local role`, que es como se prueban las policies sin crear usuarios.
//
// TODO(P2): scripts/db-migrate.ts tiene su propia copia de esta lógica. Unificar
// las dos es parte de BAJ-14; no se hace ahora para no ampliar el diff del
// runner justo antes de usarlo para el hotfix de permisos.

import { Client } from "pg";

const REGIONS = [
  "ca-central-1", // los dos proyectos viven acá
  "us-east-1", "us-east-2", "us-west-1", "sa-east-1",
  "us-west-2", "eu-west-1", "eu-central-1",
];

export function projectRef(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return process.env.SUPABASE_PROJECT_REF ?? url.replace("https://", "").split(".")[0];
}

/** Conecta probando las regiones del pooler. Nunca imprime la contraseña. */
export async function connectDb(): Promise<Client> {
  const ref = projectRef();
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!ref || !password) {
    throw new Error(
      "Faltan SUPABASE_PROJECT_REF/NEXT_PUBLIC_SUPABASE_URL o SUPABASE_DB_PASSWORD"
    );
  }
  const hosts = process.env.SUPABASE_DB_HOST
    ? [process.env.SUPABASE_DB_HOST]
    : REGIONS.flatMap((r) => [
        `aws-0-${r}.pooler.supabase.com`,
        `aws-1-${r}.pooler.supabase.com`,
      ]);

  for (const host of hosts) {
    const client = new Client({
      host,
      port: 5432,
      database: "postgres",
      user:
        process.env.SUPABASE_DB_USER ??
        (host.startsWith("db.") ? "postgres" : `postgres.${ref}`),
      password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 6000,
    });
    try {
      await client.connect();
      return client;
    } catch (e) {
      await client.end().catch(() => {});
      if (/password/i.test((e as Error).message)) {
        throw new Error("La contraseña de la base fue rechazada");
      }
    }
  }
  throw new Error("No se pudo conectar en ninguna región candidata");
}

/**
 * Corre `fn` dentro de una transacción y SIEMPRE hace ROLLBACK.
 * Es la única forma de probar policies y guards sin escribir en la base.
 */
export async function enTransaccionRevertida<T>(
  client: Client,
  fn: () => Promise<T>
): Promise<T> {
  await client.query("begin");
  try {
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

/**
 * Se hace pasar por un usuario autenticado, sin crear ninguna cuenta.
 *
 * Verifica que el cambio de rol haya ocurrido. `set local role` FUERA de una
 * transacción no falla: no hace nada y emite un warning. Si eso pasara sin que nadie
 * lo note, los chequeos seguirían corriendo como `postgres`, que es dueño de las
 * tablas y BYPASSA RLS — o sea que medirían lo contrario de lo que dicen medir y
 * darían todo en verde.
 */
export async function comoAutenticado(client: Client, sub: string): Promise<void> {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub, role: "authenticated" }),
  ]);
  const { rows } = await client.query<{ rol: string }>("select current_user as rol");
  if (rows[0].rol !== "authenticated") {
    throw new Error(
      `comoAutenticado(): el rol quedó en "${rows[0].rol}". ` +
        "¿Se llamó fuera de una transacción? Sin el cambio de rol, RLS no aplica."
    );
  }
}

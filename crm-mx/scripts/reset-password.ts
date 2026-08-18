/**
 * Resetea la contraseña de uno o varios usuarios del CRM.
 *
 *   npx tsx scripts/reset-password.ts francisco@keepsmiling.com.ar
 *   npx tsx scripts/reset-password.ts juan@... rocio@... --password
 *
 * Sin --password genera una al azar por usuario y la imprime UNA vez.
 * Con --password la pide por teclado y se la pone a TODOS los mails de la lista
 * (útil para dar de alta al equipo con una contraseña conocida que después cambian).
 *
 * La contraseña se pide por prompt y no como argumento a propósito: un argumento
 * queda escrito en el historial del shell (~/.bash_history) y ahí no se borra solo.
 *
 * Existe porque no hay flujo de recuperación en la app: las contraseñas iniciales
 * las imprime create-users.ts una sola vez, y si esa terminal se pierde no queda
 * ninguna forma de entrar (18/8/2026: le pasó al ADMIN).
 *
 * No crea usuarios ni toca la allowlist: para eso está create-users.ts.
 */
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { config } from "dotenv";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: resolve(__dirname, "../.env.local") });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

/** Mínimo de Supabase Auth. Si es más corta, la API rechaza con un error críptico. */
const MIN_LARGO = 6;

async function pedirPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error("--password necesita una terminal interactiva para pedirla.");
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const p = (await rl.question("  Contraseña para todos estos usuarios: ")).trim();
  rl.close();
  if (p.length < MIN_LARGO) {
    console.error(`La contraseña tiene que tener al menos ${MIN_LARGO} caracteres.`);
    process.exit(2);
  }
  return p;
}

async function main() {
  const args = process.argv.slice(2);
  const compartida = args.includes("--password");
  const emails = args
    .filter((a) => !a.startsWith("--"))
    .map((a) => a.trim().toLowerCase());

  if (!emails.length || emails.some((e) => !e.includes("@"))) {
    console.error("Uso: npx tsx scripts/reset-password.ts <email> [<email>…] [--password]");
    process.exit(2);
  }

  await confirmarDestino({
    accion: `resetear la contraseña de ${emails.join(", ")}`,
    auto: args.includes("--yes"),
  });

  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;

  // Resolver TODOS los mails antes de escribir: si uno no existe, es mejor
  // enterarse antes de haber cambiado la mitad.
  const encontrados = emails.map((email) => ({
    email,
    user: data.users.find((u) => (u.email ?? "").toLowerCase() === email),
  }));
  const faltantes = encontrados.filter((x) => !x.user).map((x) => x.email);
  if (faltantes.length) {
    console.error(`No existe ningún usuario con: ${faltantes.join(", ")}`);
    console.error("Los usuarios se crean con scripts/create-users.ts.");
    process.exit(1);
  }

  const password = compartida ? await pedirPassword() : null;

  console.log("");
  for (const { email, user } of encontrados) {
    const nueva = password ?? randomBytes(9).toString("base64url");
    const { error: updErr } = await db.auth.admin.updateUserById(user!.id, {
      password: nueva,
    });
    if (updErr) {
      console.error(`  ${email} — FALLÓ: ${updErr.message}`);
      continue;
    }
    console.log(
      compartida
        ? `  ✓ ${email}`
        : `  ✓ ${email} — contraseña: ${nueva}`
    );
  }
  console.log("");
  if (compartida) {
    console.log("  Todos quedaron con la contraseña que escribiste recién.");
  } else {
    console.log("  Las contraseñas se muestran UNA sola vez: anotalas ahora.");
  }
  console.log("  Las sesiones abiertas siguen vivas: cambiar la contraseña no las cierra.");
}

main().catch(salirConDestinoRechazado);

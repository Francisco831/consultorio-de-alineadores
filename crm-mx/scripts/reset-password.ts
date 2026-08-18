/**
 * Resetea la contraseña de UN usuario del CRM y la imprime UNA vez.
 *
 *   npx tsx scripts/reset-password.ts francisco@keepsmiling.com.ar
 *
 * Existe porque no hay flujo de recuperación en la app: las contraseñas
 * iniciales las imprime create-users.ts una sola vez, y si esa terminal se
 * pierde, no queda ninguna forma de entrar (18/8/2026: le pasó al ADMIN).
 *
 * Solo toca al usuario del mail pedido. No crea usuarios ni toca la allowlist:
 * para eso está create-users.ts.
 */
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: resolve(__dirname, "../.env.local") });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

async function main() {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    console.error("Uso: npx tsx scripts/reset-password.ts <email>");
    process.exit(2);
  }

  await confirmarDestino({
    accion: `resetear la contraseña de ${email}`,
    auto: process.argv.includes("--yes"),
  });

  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const user = data.users.find(
    (u) => (u.email ?? "").toLowerCase() === email
  );
  if (!user) {
    console.error(`No existe ningún usuario con el mail ${email}.`);
    console.error("Los usuarios se crean con scripts/create-users.ts.");
    process.exit(1);
  }

  const password = randomBytes(9).toString("base64url");
  const { error: updErr } = await db.auth.admin.updateUserById(user.id, {
    password,
  });
  if (updErr) throw updErr;

  console.log("");
  console.log(`  ${email} — contraseña nueva (se muestra UNA sola vez):`);
  console.log("");
  console.log(`      ${password}`);
  console.log("");
  console.log("  Las sesiones abiertas de este usuario siguen vivas: cambiar la");
  console.log("  contraseña no las cierra.");
}

main().catch(salirConDestinoRechazado);

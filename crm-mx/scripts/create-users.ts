/**
 * Crea los usuarios del equipo en Supabase Auth (invite-only, sin signup público).
 *
 *   npx tsx scripts/create-users.ts
 *
 * Idempotente: si el mail ya existe, lo saltea.
 * Las contraseñas iniciales se imprimen UNA vez — cambiarlas al primer login.
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

const USERS = [
  { email: "francisco@keepsmiling.com.ar", nombre: "Pancho", rol: "ADMIN" },
  { email: "juan@keepsmiling.com.ar", nombre: "Juan", rol: "SALES" },
  { email: "rocio@keepsmiling.com.ar", nombre: "Rocío", rol: "CLINICAL" },
  { email: "itzel@keepsmiling.com.ar", nombre: "Itzel", rol: "SALES" },
];

async function main() {
  await confirmarDestino({
    accion: "crear los usuarios del CRM en auth",
    auto: process.argv.includes("--yes"),
  });
  const { data: existing } = await db.auth.admin.listUsers({ perPage: 1000 });
  const have = new Set(existing?.users.map((u) => u.email));
  for (const u of USERS) {
    if (have.has(u.email)) {
      console.log(`${u.email} ya existe, salteado`);
      continue;
    }
    const password = randomBytes(9).toString("base64url");
    const { data: created, error } = await db.auth.admin.createUser({
      email: u.email,
      password,
      email_confirm: true,
      user_metadata: { nombre: u.nombre },
      // rol va en app_metadata: solo el admin API puede setearlo (el signup público no)
      app_metadata: { rol: u.rol },
    });
    if (error) throw error;
    // GoTrue aplica app_metadata DESPUÉS del insert que dispara handle_new_user,
    // así que el trigger ve rol vacío → VIEWER. Se fija acá explícitamente
    // (service role = is_system, el guard de profiles lo permite).
    const { error: rolErr } = await db
      .from("profiles")
      .update({ rol: u.rol, nombre: u.nombre })
      .eq("id", created.user.id);
    if (rolErr) throw rolErr;
    console.log(`${u.email} creado (${u.rol}) — contraseña inicial: ${password}`);
  }
}

main().catch((e) => {
  salirConDestinoRechazado(e);
  console.error(e);
  process.exit(1);
});

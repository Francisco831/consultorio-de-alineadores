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

// El equipo real. Itzel salió de esta lista: se dio de baja (scripts/remove-itzel.ts)
// y ya no está en auth.users. Mientras figuraba acá el script la salteaba en
// silencio; desde la allowlist (0031) el alta de un mail no invitado FALLA, así que
// dejarla habría convertido cada corrida en un error.
//
// Para sumar a alguien: primero agregarlo a auth_allowlist, después correr esto.
// Sin el primer paso, el trigger rechaza el alta con un mensaje explícito.
const USERS = [
  { email: "francisco@keepsmiling.com.ar", nombre: "Pancho", rol: "ADMIN" },
  { email: "juan@keepsmiling.com.ar", nombre: "Juan", rol: "SALES" },
  { email: "rocio@keepsmiling.com.ar", nombre: "Rocío", rol: "CLINICAL" },
];

async function main() {
  await confirmarDestino({
    accion: "crear los usuarios del CRM en auth",
    auto: process.argv.includes("--yes"),
  });
  const { data: existing } = await db.auth.admin.listUsers({ perPage: 1000 });
  const have = new Set(existing?.users.map((u) => u.email));

  // Invitar ANTES de crear. Desde 0031 hay un guard en handle_new_user: un alta
  // cuyo mail no esté en auth_allowlist aborta la transacción del alta. Este script
  // es la herramienta de invitación del equipo, así que hace los dos pasos en el
  // orden correcto en vez de fallar y hacer que alguien los descubra.
  //
  // Importa además por un caso que no es obvio: en una base NUEVA la allowlist se
  // siembra vacía (no hay usuarios de dónde sembrarla) y el guard queda permisivo
  // para poder arrancar. Si este script no cargara la lista, quedaría vacía para
  // siempre y el guard nunca se activaría. Con esto, la primera corrida la puebla y
  // a partir de ahí el guard aplica de verdad.
  const { error: alErr } = await db
    .from("auth_allowlist")
    .upsert(
      USERS.map((u) => ({ email: u.email, note: "equipo del CRM (create-users.ts)" })),
      { onConflict: "email", ignoreDuplicates: true }
    );
  if (alErr && !/does not exist|no existe/i.test(alErr.message)) throw alErr;
  if (alErr) {
    // base anterior a 0031: no hay allowlist que cargar y el alta no la necesita
    console.log("auth_allowlist no existe todavía (0031 sin aplicar): se saltea la invitación");
  } else {
    console.log(`allowlist: ${USERS.length} mail(s) invitados`);
  }

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

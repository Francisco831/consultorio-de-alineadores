/**
 * Prueba la Conversión 1 por el camino REAL: sesión de usuario autenticado
 * (anon key + login), que es como escribe la app.
 *
 * Con una conexión de servicio auth.uid() es NULL ⇒ is_system() = true ⇒ ni el
 * guard ni el trigger de journey se aplican. Por eso hay que loguearse para
 * probar de verdad que:
 *   1. el guard de 0019 BLOQUEA escribir is_accredited a mano, y
 *   2. mover el kanban a 'acreditado' SÍ dispara la Conversión 1.
 *
 *   npx tsx scripts/verificar-journey-usuario.ts <email> <password>
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("uso: npx tsx scripts/verificar-journey-usuario.ts <email> <password>");
  process.exit(1);
}

async function main() {
  // el service client solo crea y limpia el doctor de prueba
  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const user = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
  const { error: authErr } = await user.auth.signInWithPassword({ email, password });
  if (authErr) throw authErr;
  console.log(`sesión iniciada como ${email}`);

  const { data: ins, error: insErr } = await svc
    .from("doctors")
    .insert({
      nombre: "ZZ Prueba Journey",
      lifecycle_stage: "contactado",
      acquisition_stage: "contactado",
      is_demo: true,
    })
    .select("id, is_accredited")
    .single();
  if (insErr) throw insErr;
  console.log(`prospecto de prueba creado (is_accredited=${ins.is_accredited})`);

  // 1. escritura directa del campo: tiene que rebotar
  const { error: guardErr } = await user
    .from("doctors")
    .update({ is_accredited: true })
    .eq("id", ins.id);
  console.log(
    guardErr
      ? `✓ el guard bloqueó la escritura directa — "${guardErr.message}"`
      : "✗ el guard NO bloqueó la escritura directa de is_accredited"
  );

  // 2. el camino legítimo: mover el kanban
  const { error: moveErr } = await user
    .from("doctors")
    .update({ acquisition_stage: "acreditado" })
    .eq("id", ins.id);
  if (moveErr) console.log(`✗ no se pudo mover el kanban: ${moveErr.message}`);

  const { data: after } = await svc
    .from("doctors")
    .select("is_accredited, accredited_at, lifecycle_stage, activation_stage")
    .eq("id", ins.id)
    .single();
  console.log(
    after?.is_accredited && after?.accredited_at
      ? `✓ CONVERSIÓN 1 OK — acreditado ${after.accredited_at}, lifecycle=${after.lifecycle_stage}, activación=${after.activation_stage}`
      : `✗ la conversión NO se registró: ${JSON.stringify(after)}`
  );

  await svc.from("doctors").delete().eq("id", ins.id);
  console.log("prospecto de prueba borrado");
}

main().catch((e) => {
  console.error("Falló:", e);
  process.exit(1);
});

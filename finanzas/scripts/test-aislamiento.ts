// Verificación de seguridad: la separación entre empresas la impone la BASE.
//
// Crea un usuario ficticio con membresía en UNA sola empresa y comprueba que no
// puede ver ni escribir nada de la otra. Todo corre dentro de una transacción
// que se REVIERTE: no deja usuario, ni membresía, ni movimientos.
//
// Uso: npx tsx scripts/test-aislamiento.ts

import { config } from "dotenv";
import { resolve } from "node:path";
import { Client } from "pg";

config({ path: resolve(__dirname, "../.env.local") });

const UID_TEST = "11111111-1111-1111-1111-111111111111";

async function main() {
  const host = process.env.SUPABASE_DB_HOST;
  const ref = process.env.SUPABASE_PROJECT_REF;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!host || !ref || !password) {
    throw new Error("Faltan SUPABASE_DB_HOST / SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD");
  }
  const c = new Client({
    host, port: 5432, user: `postgres.${ref}`, password,
    database: "postgres", ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  console.log(`\n  Base: ${ref} (${host})\n`);

  const fallas: string[] = [];
  const check = (ok: boolean, label: string, detalle = "") => {
    console.log(`  ${ok ? "✓" : "✗ FALLA"} ${label}${detalle ? ` — ${detalle}` : ""}`);
    if (!ok) fallas.push(label);
  };

  await c.query("begin");
  try {
    await c.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
       values ($1::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','rlstest@local','x',now(),now())`,
      [UID_TEST]
    );
    const { rows: [propia] } = await c.query("select id, slug from companies where slug='ar'");
    const { rows: [ajena] } = await c.query("select id, slug from companies where slug='mx'");
    if (!propia || !ajena) throw new Error("faltan las empresas: correr seed-base");
    await c.query(
      "insert into memberships (user_id, company_id, role) values ($1::uuid,$2::uuid,'operator')",
      [UID_TEST, propia.id]
    );

    // a partir de acá, actuamos como ese usuario
    await c.query("set local role authenticated");
    await c.query(
      `select set_config('request.jwt.claims', json_build_object('sub',$1::text,'role','authenticated')::text, true)`,
      [UID_TEST]
    );

    const { rows: vistos } = await c.query(
      "select co.slug, count(*)::int n from movements m join companies co on co.id=m.company_id group by 1"
    );
    const porEmpresa = Object.fromEntries(vistos.map((r) => [r.slug, r.n]));
    check((porEmpresa[propia.slug] ?? 0) > 0, "ve los movimientos de su empresa", `${porEmpresa[propia.slug] ?? 0} filas`);
    check(!porEmpresa[ajena.slug], "NO ve ni una fila de la otra empresa", `${porEmpresa[ajena.slug] ?? 0} filas`);

    const { rows: [ctas] } = await c.query(
      "select count(*)::int n from accounts a join companies co on co.id=a.company_id where co.slug=$1",
      [ajena.slug]
    );
    check(ctas.n === 0, "NO ve las cuentas de la otra empresa", `${ctas.n} cuentas`);

    const { rows: [emps] } = await c.query("select count(*)::int n from companies");
    check(emps.n === 1, "solo existe su empresa para él", `${emps.n} visible(s)`);

    await c.query("savepoint sp");
    let bloqueado = false;
    let motivo = "";
    try {
      await c.query(
        `insert into movements (company_id, account_id, currency, kind, occurred_on, amount)
         select $1::uuid, a.id, 'MXN', 'income', current_date, 1
           from accounts a where a.company_id = $1::uuid limit 1`,
        [ajena.id]
      );
      const { rows: [n] } = await c.query(
        "select count(*)::int n from movements where company_id=$1::uuid",
        [ajena.id]
      );
      if (n.n === 0) { bloqueado = true; motivo = "no encontró cuentas ajenas (RLS las oculta)"; }
    } catch (e) {
      bloqueado = true;
      motivo = String((e as Error).message).slice(0, 60);
    }
    await c.query("rollback to savepoint sp");
    check(bloqueado, "NO puede escribir en la otra empresa", motivo || "PUDO ESCRIBIR");

    const { rows: [balAjena] } = await c.query(
      "select count(*)::int n from v_account_balances b join companies co on co.id=b.company_id where co.slug=$1",
      [ajena.slug]
    );
    check(balAjena.n === 0, "las vistas tampoco filtran datos ajenos", `${balAjena.n} filas`);
  } finally {
    await c.query("rollback");
    await c.end();
  }

  if (fallas.length) {
    console.error(`\n✗ ${fallas.length} falla(s) de aislamiento. NO usar esta base.\n`);
    process.exit(1);
  }
  console.log("\n✓ Aislamiento OK: la separación entre empresas la impone la base, no la app.\n");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

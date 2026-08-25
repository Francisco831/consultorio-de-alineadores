// Verificación de que el PANEL puede hacer lo que promete.
//
// El recálculo y la corrección de imputaciones dejaron de ser un script de
// terminal (que corre como service_role y se saltea la RLS) para pasar a ser
// botones del panel, que corren con la sesión de Pancho: rol `authenticated` y
// las policies de la 0007/0014/0022. Un grant que falte no se nota en la
// terminal — se nota cuando él aprieta el botón y ve un error críptico.
//
// Todo corre dentro de una transacción que se REVIERTE: no deja nada escrito.
//
// Uso: npx tsx scripts/test-permisos-liquidaciones.ts

import { config } from "dotenv";
import { resolve } from "node:path";
import { Client } from "pg";

config({ path: resolve(__dirname, "../.env.local") });

const UID_TEST = "22222222-2222-2222-2222-222222222222";

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
  const puede = async (label: string, sql: string, params: unknown[] = []) => {
    await c.query("savepoint sp");
    try {
      await c.query(sql, params);
      check(true, label);
    } catch (e) {
      check(false, label, String((e as Error).message).slice(0, 90));
      await c.query("rollback to savepoint sp");
    }
  };

  await c.query("begin");
  try {
    await c.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
       values ($1::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','panel@local','x',now(),now())`,
      [UID_TEST]
    );
    const { rows: [ar] } = await c.query("select id from companies where slug='ar'");
    if (!ar) throw new Error("falta la empresa 'ar': correr seed-base");
    await c.query(
      "insert into memberships (user_id, company_id, role) values ($1::uuid,$2::uuid,'operator')",
      [UID_TEST, ar.id]
    );
    const { rows: [mov] } = await c.query(
      "select id from movements where company_id=$1::uuid and kind='income' and status<>'void' limit 1", [ar.id]
    );
    const { rows: [prof] } = await c.query(
      "select counterparty_id from professionals where company_id=$1::uuid limit 1", [ar.id]
    );
    if (!mov || !prof) throw new Error("faltan movimientos o profesionales para probar");

    // desde acá actuamos como el usuario del panel
    await c.query("set local role authenticated");
    await c.query(
      `select set_config('request.jwt.claims', json_build_object('sub',$1::text,'role','authenticated')::text, true)`,
      [UID_TEST]
    );

    await puede("imputar un cobro a NADIE (queda para la casa)",
      `insert into settlement_imputations (company_id, movement_id, destino, professional_id, reason, revisado)
       values ($1::uuid, $2::uuid, 'casa', null, 'test', true)
       on conflict (movement_id) do update set destino = excluded.destino, reason = excluded.reason`,
      [ar.id, mov.id]);
    await puede("reasignarlo a una doctora",
      `update settlement_imputations set destino = 'profesional', professional_id = $1::uuid
        where movement_id = $2::uuid`,
      [prof.counterparty_id, mov.id]);
    await puede("tildarlo como revisado sin tocar la imputación",
      `update settlement_imputations set revisado = true, revisado_at = now() where movement_id = $1::uuid`,
      [mov.id]);
    await puede("volver a lo que dice la caja (borrar la imputación)",
      `delete from settlement_imputations where movement_id = $1::uuid`, [mov.id]);

    await puede("crear/pisar una liquidación (lo que hace Recalcular)",
      `insert into professional_settlements (company_id, professional_id, period, status, pct, totals)
       values ($1::uuid, $2::uuid, '1999-01', 'draft', 40, '{}'::jsonb)
       on conflict (company_id, professional_id, period)
       do update set totals = excluded.totals, status = 'draft'`,
      [ar.id, prof.counterparty_id]);

    const { rows: [set] } = await c.query(
      `select id from professional_settlements where company_id=$1::uuid and period='1999-01'`, [ar.id]
    );
    await puede("escribir el detalle línea por línea",
      `insert into settlement_items (company_id, settlement_id, movement_id, base_amount, currency, ks_cost)
       values ($1::uuid, $2::uuid, $3::uuid, 1, 'ARS', 0)`,
      [ar.id, set.id, mov.id]);
    await puede("rehacer el detalle (borrar los ítems viejos)",
      `delete from settlement_items where company_id=$1::uuid and movement_id=$2::uuid`, [ar.id, mov.id]);
    await puede("anular una liquidación que se quedó sin cobros",
      `update professional_settlements set status='void', totals='{}'::jsonb where id=$1::uuid`, [set.id]);

    // Y lo que NO tiene que poder: la plata no se borra.
    await c.query("savepoint sp");
    let bloqueado = false;
    try {
      await c.query(`delete from professional_settlements where id=$1::uuid`, [set.id]);
      const { rows: [n] } = await c.query(
        `select count(*)::int n from professional_settlements where id=$1::uuid`, [set.id]);
      bloqueado = n.n > 0;   // sin policy de delete la fila sobrevive, sin error
    } catch { bloqueado = true; }
    await c.query("rollback to savepoint sp");
    check(bloqueado, "NO puede borrar una liquidación (se anula, no se borra)");
  } finally {
    await c.query("rollback");
    await c.end();
  }

  if (fallas.length) {
    console.error(`\n✗ ${fallas.length} permiso(s) faltante(s): el panel iba a fallar en manos de Pancho.\n`);
    process.exit(1);
  }
  console.log("\n✓ El panel puede recalcular e imputar con la sesión del usuario, sin service_role.\n");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

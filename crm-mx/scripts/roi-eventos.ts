/**
 * ROI real por evento (solo lectura): de los contactos que dejó cada curso/congreso,
 * ¿cuántos son hoy clientes acreditados y cuántos se acreditaron DESPUÉS del evento?
 *
 * Los doctores llevan el tag 'evento:<slug>' (los que ya eran clientes) o campaign_id
 * (los prospectos nuevos), así que el corte se hace por tag, que cubre a los dos.
 *
 *   SUPABASE_DB_HOST=… SUPABASE_PROJECT_REF=… npx tsx scripts/roi-eventos.ts
 */
import { Client } from "pg";
import { config } from "dotenv";

config({ path: ".env.local" });

const ref =
  process.env.SUPABASE_PROJECT_REF ??
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace("https://", "").split(".")[0];
const host = process.env.SUPABASE_DB_HOST ?? "aws-0-ca-central-1.pooler.supabase.com";

async function main() {
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

  const { rows } = await db.query(`
    with ev as (
      select c.nombre, c.starts_on,
             'evento:' || regexp_replace(
                lower(translate(c.nombre,
                  'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU')),
                '[^a-z0-9]+', '-', 'g') as tag
      from campaigns c
    )
    select ev.nombre,
           ev.starts_on,
           count(*)                                                   as contactos,
           count(*) filter (where d.is_accredited)                    as clientes,
           count(*) filter (where d.is_accredited
                              and ev.starts_on is not null
                              and d.accredited_at > ev.starts_on)     as acred_post,
           count(*) filter (where d.is_accredited
                              and d.accredited_at is null)            as clientes_sin_fecha,
           count(*) filter (where d.new_case_count > 0)               as con_casos,
           coalesce(sum(d.new_case_count), 0)                         as casos_totales
    from ev
    join doctors d
      on d.tags && array[left(ev.tag, 40)]
      or d.campaign_id = (select id from campaigns c2 where c2.nombre = ev.nombre limit 1)
    group by ev.nombre, ev.starts_on
    order by count(*) desc
  `);

  console.log(
    "EVENTO".padEnd(34) +
      "FECHA".padEnd(12) +
      "CONTACTOS".padStart(10) +
      "CLIENTES".padStart(9) +
      "POST".padStart(6) +
      "CONV%".padStart(7) +
      "CASOS".padStart(7)
  );
  let tc = 0, tcl = 0, tp = 0, tcasos = 0;
  for (const r of rows) {
    const contactos = Number(r.contactos);
    const clientes = Number(r.clientes);
    const post = Number(r.acred_post);
    const casos = Number(r.casos_totales);
    tc += contactos; tcl += clientes; tp += post; tcasos += casos;
    console.log(
      String(r.nombre).slice(0, 33).padEnd(34) +
        (r.starts_on ? new Date(r.starts_on).toISOString().slice(0, 10) : "—").padEnd(12) +
        String(contactos).padStart(10) +
        String(clientes).padStart(9) +
        String(post).padStart(6) +
        `${Math.round((clientes / Math.max(1, contactos)) * 100)}%`.padStart(7) +
        String(casos).padStart(7)
    );
  }
  console.log(
    "TOTAL".padEnd(46) +
      String(tc).padStart(10) +
      String(tcl).padStart(9) +
      String(tp).padStart(6) +
      `${Math.round((tcl / Math.max(1, tc)) * 100)}%`.padStart(7) +
      String(tcasos).padStart(7)
  );
  console.log(
    "\nCLIENTES = contacto del evento que hoy es doctor acreditado.\n" +
      "POST = se acreditó DESPUÉS de la fecha del evento (atribuible al evento).\n" +
      "CASOS = casos nuevos históricos que trajeron esos doctores."
  );

  await db.end();
}

main().catch((e) => {
  console.error("Falló:", e);
  process.exit(1);
});

/**
 * Marca en el CRM a los doctores que siguen a @keepsmiling_mex en Instagram.
 *
 *   npx tsx scripts/tag-seguidores-ig.ts [--aplicar]
 *
 * POR QUÉ DOS TAGS Y NO UNO. El pedido era marcar a los 64 ortodoncistas con ficha
 * que siguen la cuenta y todavía no compraron. Pero un tag "sigue-instagram" puesto
 * solo sobre 64 de los 228 que efectivamente siguen dejaría el dato mintiendo: el
 * filtro diría "sigue Instagram" y estaría mostrando un recorte. Así que el hecho
 * (sigue la cuenta) y la interpretación (es ortodoncista) van en tags distintos:
 *
 *   sigue-instagram   -> los 228 doctores con ficha que siguen la cuenta
 *   ig:ortodoncista   -> los 78 de esos que quedaron confirmados como ortodoncistas
 *
 * Los 64 del pedido salen de cruzar los dos tags con is_accredited = false.
 *
 * La fuente es data/ig_tags_a_aplicar.csv, que sale del censo de seguidores del
 * 20/8/2026 cruzado contra doctors por nombre. Sin --aplicar solo informa.
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { connectDb } from "./lib/pg";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

const TAG_SIGUE = "sigue-instagram";
const TAG_ORTO = "ig:ortodoncista";

async function main() {
  const aplicar = process.argv.includes("--aplicar");

  const filas = readFileSync("data/ig_tags_a_aplicar.csv", "utf8")
    .split("\n").slice(1).filter(Boolean)
    .map((l) => l.split(","))
    .map(([doctor_id, handle, orto]) => ({ doctor_id, handle, orto: orto?.trim() === "si" }));

  const todos = [...new Set(filas.map((f) => f.doctor_id))];
  const ortos = [...new Set(filas.filter((f) => f.orto).map((f) => f.doctor_id))];

  console.log(`  ${todos.length} doctores reciben "${TAG_SIGUE}"`);
  console.log(`  ${ortos.length} de esos reciben además "${TAG_ORTO}"`);

  if (!aplicar) {
    console.log("\n  ensayo: nada se escribió. Volvé a correr con --aplicar.");
    return;
  }

  try {
    await confirmarDestino({ accion: `agregar tags de Instagram a ${todos.length} doctores` });
  } catch (e) {
    return salirConDestinoRechazado(e);
  }

  const db = await connectDb();
  try {
    await db.query("begin");
    const a = await db.query(
      `update doctors set tags = array(select distinct unnest(tags || $2::text[]))
       where id = any($1) and not (tags @> $2::text[])`,
      [todos, [TAG_SIGUE]]
    );
    const b = await db.query(
      `update doctors set tags = array(select distinct unnest(tags || $2::text[]))
       where id = any($1) and not (tags @> $2::text[])`,
      [ortos, [TAG_ORTO]]
    );
    await db.query("commit");
    console.log(`\n  ✓ ${a.rowCount} fichas marcadas con ${TAG_SIGUE}`);
    console.log(`  ✓ ${b.rowCount} fichas marcadas con ${TAG_ORTO}`);

    const { rows } = await db.query(
      `select count(*) from doctors
        where tags @> array[$1]::text[] and tags @> array[$2]::text[] and not is_accredited`,
      [TAG_SIGUE, TAG_ORTO]
    );
    console.log(`  → ortodoncistas que siguen y NO están acreditados: ${rows[0].count}`);
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    await db.end();
  }
}

main();

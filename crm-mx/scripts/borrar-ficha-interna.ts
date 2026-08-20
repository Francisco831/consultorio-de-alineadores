/**
 * Borra del CRM la ficha de @angiebouza, creada por error desde el censo de Instagram.
 *
 * POR QUÉ. Es Angélica Portugal, responsable de DSOs y universidades de KeepSmiling
 * México: personal propio, no una doctora prospecto. El clasificador la leyó como
 * "CD" (Cirujano Dentista) y la propuso como dentista mexicana; el verificador la
 * refutó y dejó la nota, pero el filtro de importación miraba país y acción, no las
 * refutaciones, así que igual entró. El filtro ya se corrigió en el importador.
 *
 * Se borra en vez de marcarse porque una ficha de doctora con el nombre de una
 * empleada ensucia todos los conteos comerciales del área.
 *
 *   npx tsx scripts/borrar-ficha-interna.ts [--aplicar]
 */
import { config } from "dotenv";
import { connectDb } from "./lib/pg";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

const HANDLE = "angiebouza";

async function main() {
  const aplicar = process.argv.includes("--aplicar");
  const db = await connectDb();
  const { rows } = await db.query(
    `select d.id, d.nombre, d.created_at,
            (select count(*) from activities a where a.doctor_id = d.id) as actividades,
            (select count(*) from cases c where c.doctor_id = d.id) as casos
       from doctors d where d.instagram = $1`,
    [HANDLE]
  );
  if (!rows.length) {
    console.log(`  no hay ficha con instagram = ${HANDLE}: nada que hacer.`);
    await db.end();
    return;
  }
  const f = rows[0];
  console.log(`  ficha: ${f.nombre} (creada ${f.created_at})`);
  console.log(`  actividades: ${f.actividades} · casos: ${f.casos}`);
  if (Number(f.actividades) > 0 || Number(f.casos) > 0) {
    console.log("\n  ⚠ tiene historial cargado: NO se borra a ciegas. Revisar a mano.");
    await db.end();
    return;
  }
  if (!aplicar) {
    console.log("\n  ensayo: nada se borró.");
    await db.end();
    return;
  }
  try {
    await confirmarDestino({ accion: `borrar la ficha interna ${f.nombre}` });
  } catch (e) {
    await db.end();
    return salirConDestinoRechazado(e);
  }
  try {
    await db.query(`delete from doctors where id = $1`, [f.id]);
    console.log(`\n  ✓ ficha borrada`);
  } finally {
    await db.end();
  }
}

main();

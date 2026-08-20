/**
 * Suma al CRM los doctores mexicanos que el censo de Instagram NO pudo ver.
 *
 *   npx tsx scripts/import-doctores-bio-ig.ts [--aplicar]
 *
 * EL AGUJERO QUE TAPA. La integración del censo (scripts/import-seguidores-ig.ts)
 * decidió quién era dental leyendo el handle y el nombre de Instagram. Eso deja
 * afuera a cualquier doctor cuya cuenta se llama simplemente como él: "Diana Del
 * Toro" no tiene ninguna palabra dental, y es cirujana dentista con 4.275
 * seguidores. Estos 11 salieron del barrido manual de biografías del 19/8, que sí
 * leyó el perfil de cada uno.
 *
 * TRAEN ALGO QUE LOS OTROS NO: la cantidad de seguidores, que quedó en el tag
 * "ig-seguidores:N". Para decidir a quién tratar como referente eso importa más
 * que la especialidad.
 *
 * Los que ya tenían ficha con otro nombre (Marcela Ríos, Josué Sedano) NO se
 * duplican: su handle va como cuenta alternativa a la ficha que ya existe.
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { connectDb } from "./lib/pg";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

function tsv(path: string) {
  const [head, ...lines] = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const cols = head.split("\t");
  return lines.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [cols[i], v.trim()])));
}

async function main() {
  const aplicar = process.argv.includes("--aplicar");
  const nuevos = tsv("data/ig_bio_a_crear.tsv");
  const alt = tsv("data/ig_bio_alt.tsv");

  console.log(`  ${nuevos.length} fichas nuevas (doctores MX identificados por biografía)`);
  console.log(`  ${alt.length} handles que van como cuenta alternativa a fichas existentes`);
  if (!aplicar) {
    console.log("\n  ensayo: nada se escribió.");
    return;
  }
  try {
    await confirmarDestino({ accion: `crear ${nuevos.length} fichas del barrido de biografías` });
  } catch (e) {
    return salirConDestinoRechazado(e);
  }

  const db = await connectDb();
  try {
    await db.query("begin");
    let creadas = 0;
    for (const n of nuevos) {
      const tags = [
        "sigue-instagram",
        "fuente:censo-ig-2026-08",
        "ig-accion:dm_presentacion",
        `ig-seguidores:${n.seguidores}`,
        Number(n.seguidores) >= 1000 ? "ig-prioridad:alta" : "ig-prioridad:media",
      ];
      const r = await db.query(
        `insert into doctors (nombre, instagram, why_interesting, tags,
                              is_accredited, lifecycle_stage, acquisition_stage)
         values ($1, $2, $3, $4, false, 'prospecto', 'identificado')
         on conflict (instagram) where instagram is not null do nothing
         returning id`,
        [n.nombre, n.handle,
         `Doctor/a MX confirmado por biografía en el barrido del 19/8. ${n.seguidores} seguidores en Instagram.`,
         tags]
      );
      creadas += r.rowCount ?? 0;
    }
    let alts = 0;
    for (const a of alt) {
      const r = await db.query(
        `update doctors set tags = array(select distinct unnest(tags || $2::text[]))
          where nombre = $1`,
        [a.doctor_nombre, [`ig-alt:${a.handle}`, "sigue-instagram"]]
      );
      alts += r.rowCount ?? 0;
    }
    await db.query("commit");
    console.log(`\n  ✓ ${creadas} fichas creadas`);
    console.log(`  ✓ ${alts} fichas existentes con su cuenta alternativa`);
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    await db.end();
  }
}

main();

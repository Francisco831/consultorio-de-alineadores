/**
 * Crea en el CRM los seguidores de @keepsmiling_mex que no tenían ficha.
 *
 *   npx tsx scripts/import-seguidores-ig.ts [--aplicar]
 *
 * DE DÓNDE SALEN. Del censo de seguidores del 20/8/2026: 1.402 cuentas, de las que
 * 461 tenían señal dental. Las que ya cruzaban con una ficha se marcaron con tags
 * (scripts/tag-seguidores-ig.ts). Estas 137 son las que NO existían en el CRM.
 *
 * QUÉ SE DESCARTÓ Y POR QUÉ. De 191 candidatas quedaron 137. Se cayeron 17 cuentas
 * de la red KeepSmiling ARGENTINA (la cuenta mexicana la sigue media Argentina de la
 * marca), 4 de otros países, un fabricante competidor, laboratorios y depósitos que
 * no compran, y una cuenta INTERNA de KeepSmiling México. Ese filtro es la mitad del
 * trabajo: sin él, el CRM de México se llena de doctoras argentinas.
 *
 * EL CANAL ES INSTAGRAM Y NADA MÁS. Ninguna trae teléfono ni mail, así que la ficha
 * nace con el handle en doctors.instagram y sin otro contacto. Por eso entran en
 * 'identificado', que es exactamente lo que son: alguien que existe y a quien todavía
 * nadie le habló.
 *
 * EL PAÍS NO SIEMPRE ESTÁ. 110 de las 137 quedaron con el país sin confirmar porque
 * el nombre de Instagram no lo dice y no pudimos leer las biografías. Van con el tag
 * "pais:por-confirmar" y acción "verificar_pais": es una tarea de un minuto por ficha
 * abriendo el perfil, y hasta que se haga NO hay que gastarles tiempo comercial.
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { connectDb } from "./lib/pg";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

// TSV y no CSV a propósito: las razones traen comillas y comas, y un parser
// casero de CSV se come alguna fila en silencio. Acá ya se rompió una vez.
function tsv(path: string): Record<string, string>[] {
  const [head, ...lines] = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const cols = head.split("\t");
  return lines.map((l) => {
    const vals = l.split("\t");
    return Object.fromEntries(cols.map((c, i) => [c, (vals[i] ?? "").trim()]));
  });
}

async function main() {
  const aplicar = process.argv.includes("--aplicar");
  const filas = tsv("data/ig_prospectos_a_crear.tsv");

  const porPrioridad = filas.reduce<Record<string, number>>((a, f) => {
    a[f.prioridad] = (a[f.prioridad] ?? 0) + 1;
    return a;
  }, {});
  console.log(`  ${filas.length} fichas nuevas: ${JSON.stringify(porPrioridad)}`);
  console.log(`  ${filas.filter((f) => f.specialty).length} con specialty = 'Ortodoncia'`);
  console.log(`  ${filas.filter((f) => f.pais === "DESCONOCIDO").length} con el país sin confirmar`);

  if (!aplicar) {
    console.log("\n  ensayo: nada se escribió. Volvé a correr con --aplicar.");
    return;
  }

  try {
    await confirmarDestino({ accion: `crear ${filas.length} fichas nuevas desde el censo de Instagram` });
  } catch (e) {
    return salirConDestinoRechazado(e);
  }

  const db = await connectDb();
  let creadas = 0;
  const saltadas: string[] = [];
  try {
    await db.query("begin");
    for (const f of filas) {
      const r = await db.query(
        `insert into doctors
           (nombre, instagram, specialty, why_interesting, tags,
            is_accredited, lifecycle_stage, acquisition_stage)
         values ($1, $2, nullif($3,''), nullif($4,''), $5, false, 'prospecto', 'identificado')
         on conflict (instagram) where instagram is not null do nothing
         returning id`,
        [f.nombre, f.handle, f.specialty, f.why, f.tags.split("|")]
      );
      if (r.rowCount) creadas++;
      else saltadas.push(f.handle);
    }
    await db.query("commit");
    console.log(`\n  ✓ ${creadas} fichas creadas`);
    if (saltadas.length) console.log(`  · ${saltadas.length} salteadas (handle ya existía): ${saltadas.join(", ")}`);

    const { rows } = await db.query(
      `select count(*) filter (where tags @> array['ig-prioridad:alta']::text[]) as alta,
              count(*) filter (where tags @> array['pais:por-confirmar']::text[]) as por_confirmar,
              count(*) as total
         from doctors where tags @> array['fuente:censo-ig-2026-08']::text[]`
    );
    console.log(`  → en el CRM: ${rows[0].total} del censo · ${rows[0].alta} prioridad alta · ${rows[0].por_confirmar} país por confirmar`);
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    await db.end();
  }
}

main();

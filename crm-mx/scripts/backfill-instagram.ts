/**
 * Carga el handle de Instagram y la especialidad en las fichas que ya existen.
 *
 *   npx tsx scripts/backfill-instagram.ts [--aplicar]
 *
 * De dónde sale. Del censo de seguidores de @keepsmiling_mex del 20/8/2026
 * (data/ig_tags_a_aplicar.csv) y de la clasificación de especialidad verificada
 * (data/ortodoncistas_seguidores.csv).
 *
 * DOS DECISIONES QUE VALE LA PENA MIRAR:
 *
 * 1. Un doctor puede tener varias cuentas —la personal y la del consultorio— y la
 *    columna guarda una sola (índice único). Se elige la que más se parece al
 *    nombre de la ficha, y las otras NO se tiran: quedan como tag "ig-alt:<handle>".
 *    Perder la cuenta del consultorio sería perder por dónde publica.
 *
 * 2. specialty se escribe SOLO donde la cuenta se declara ortodoncista en el handle
 *    o en el nombre (confianza alta). Los que quedaron por tag de congreso AMO no se
 *    escriben: haber ido a un congreso no es declarar una especialidad, y specialty
 *    es un campo clínico que después alguien va a leer como verdad.
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { connectDb } from "./lib/pg";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

function csv(path: string): Record<string, string>[] {
  const [head, ...lines] = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const cols = head.split(",");
  return lines.map((l) => {
    // parser mínimo con comillas, alcanza para estos archivos
    const vals: string[] = [];
    let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { vals.push(cur); cur = ""; }
      else cur += ch;
    }
    vals.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, (vals[i] ?? "").trim()]));
  });
}

function tokens(s: string): string[] {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/).filter((t) => t.length > 3);
}

async function main() {
  const aplicar = process.argv.includes("--aplicar");
  const filas = csv("data/ig_tags_a_aplicar.csv");
  const orto = new Map(
    csv("data/ortodoncistas_seguidores.csv")
      .filter((r) => r.grupo === "EN CRM")
      .map((r) => [r.handle, r.confianza])
  );

  const db = await connectDb();
  const { rows: docs } = await db.query(
    `select id, nombre from doctors where id = any($1)`,
    [[...new Set(filas.map((f) => f.doctor_id))]]
  );
  const nombre = new Map(docs.map((d) => [d.id, d.nombre as string]));

  // agrupar handles por doctor y elegir el principal
  const porDoc = new Map<string, string[]>();
  for (const f of filas) {
    porDoc.set(f.doctor_id, [...(porDoc.get(f.doctor_id) ?? []), f.handle.toLowerCase()]);
  }

  const principal = new Map<string, string>();
  const alternativos: { doctor_id: string; handle: string }[] = [];
  for (const [id, handles] of porDoc) {
    const toks = tokens(nombre.get(id) ?? "");
    const puntaje = (h: string) =>
      (toks.some((t) => h.includes(t)) ? 2 : 0) + (orto.get(h) === "alta" ? 1 : 0);
    const ordenados = [...handles].sort((a, b) => puntaje(b) - puntaje(a) || a.localeCompare(b));
    principal.set(id, ordenados[0]);
    ordenados.slice(1).forEach((h) => alternativos.push({ doctor_id: id, handle: h }));
  }

  const conEspecialidad = [...new Set(
    filas.filter((f) => orto.get(f.handle) === "alta").map((f) => f.doctor_id)
  )];

  console.log(`  ${principal.size} fichas reciben handle de Instagram`);
  console.log(`  ${alternativos.length} cuentas secundarias van como tag ig-alt:`);
  console.log(`  ${conEspecialidad.length} fichas reciben specialty = 'Ortodoncia'`);

  if (!aplicar) {
    console.log("\n  ensayo: nada se escribió. Volvé a correr con --aplicar.");
    await db.end();
    return;
  }

  try {
    await confirmarDestino({ accion: `cargar Instagram y especialidad en ${principal.size} fichas` });
  } catch (e) {
    await db.end();
    return salirConDestinoRechazado(e);
  }

  let ok = 0, choques: string[] = [];
  try {
    await db.query("begin");
    for (const [id, handle] of principal) {
      try {
        const r = await db.query(
          `update doctors set instagram = $2 where id = $1 and instagram is null`,
          [id, handle]
        );
        ok += r.rowCount ?? 0;
      } catch {
        choques.push(`${handle} (${nombre.get(id) ?? id})`);
      }
    }
    for (const a of alternativos) {
      await db.query(
        `update doctors set tags = array(select distinct unnest(tags || $2::text[])) where id = $1`,
        [a.doctor_id, [`ig-alt:${a.handle}`]]
      );
    }
    const esp = await db.query(
      `update doctors set specialty = 'Ortodoncia' where id = any($1) and specialty is null`,
      [conEspecialidad]
    );
    await db.query("commit");
    console.log(`\n  ✓ ${ok} fichas con handle`);
    console.log(`  ✓ ${alternativos.length} tags ig-alt:`);
    console.log(`  ✓ ${esp.rowCount} fichas con specialty = 'Ortodoncia'`);
    if (choques.length) console.log(`  ⚠ handles rechazados por duplicado: ${choques.join(", ")}`);
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    await db.end();
  }
}

main();

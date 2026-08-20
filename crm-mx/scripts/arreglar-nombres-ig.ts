/**
 * Arregla los nombres genéricos de las fichas creadas desde el censo de Instagram.
 *
 * El importador corta el nombre de Instagram en el primer "|" para sacarle el claim
 * comercial ("Dra. X | Ortodoncia | Invisalign" -> "Dra. X"). Cuando la cuenta pone
 * el oficio ANTES del nombre —"Odontóloga | Consultorio Dental | Cancún"— ese corte
 * deja una ficha que se llama "Odontóloga". Para esos casos vale más el nombre
 * completo de Instagram que el recorte. La lista sale de data/ig_nombres_fix.tsv.
 *
 *   npx tsx scripts/arreglar-nombres-ig.ts [--aplicar]
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { connectDb } from "./lib/pg";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

const GENERICOS =
  /^(odontolog[oa]|ortodonci(a|sta)|dentista|cirujano dentista|clinica dental|consultorio( dental)?|dental|smile|sonrisas?|doctora?|dra?\.?|especialista)$/i;

async function main() {
  const aplicar = process.argv.includes("--aplicar");

  const fix = readFileSync("data/ig_nombres_fix.tsv", "utf8")
    .split("\n").slice(1).filter(Boolean)
    .map((l) => l.split("\t"))
    .map(([handle, nombre]) => ({ handle: handle.trim(), nombre: nombre.trim() }));

  console.log(`  ${fix.length} fichas a renombrar:`);
  fix.forEach((f) => console.log(`    @${f.handle}  ->  "${f.nombre}"`));

  if (!aplicar) {
    console.log("\n  ensayo: nada se escribió.");
    return;
  }
  try {
    await confirmarDestino({ accion: `renombrar ${fix.length} fichas del censo de Instagram` });
  } catch (e) {
    return salirConDestinoRechazado(e);
  }
  const db = await connectDb();
  try {
    await db.query("begin");
    let n = 0;
    for (const f of fix) {
      const r = await db.query(`update doctors set nombre = $2 where instagram = $1`, [f.handle, f.nombre]);
      n += r.rowCount ?? 0;
    }
    await db.query("commit");
    console.log(`\n  \u2713 ${n} nombres corregidos`);
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    await db.end();
  }
}

main();

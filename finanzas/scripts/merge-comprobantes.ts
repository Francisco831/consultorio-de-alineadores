// Mergea un listado parcial del Drive (carpetas recientes + sus archivos) en
// seed-data/comprobantes_drive.json. Para las carpetas que vienen en el delta,
// sus archivos REEMPLAZAN a los guardados (altas, renombres y bajas); el resto
// del inventario queda intacto. Dedup por id.
//
// Uso:  npx tsx scripts/merge-comprobantes.ts <delta.json>
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ArchivoDrive, CarpetaDrive } from "../lib/comprobantes/vincular";

type Inventario = { folders: CarpetaDrive[]; files: ArchivoDrive[] };

const deltaPath = process.argv[2];
if (!deltaPath) { console.error("falta el path del delta.json"); process.exit(1); }

const basePath = resolve(__dirname, "../seed-data/comprobantes_drive.json");
const base = JSON.parse(readFileSync(basePath, "utf8")) as Inventario;
const delta = JSON.parse(readFileSync(resolve(deltaPath), "utf8")) as Inventario;
if (!Array.isArray(delta.folders) || !Array.isArray(delta.files)) {
  console.error("delta inválido: se espera {folders: [], files: []}");
  process.exit(1);
}

const carpetasDelta = new Set(delta.folders.map((f) => f.id));
const folders = new Map(base.folders.map((f) => [f.id, f]));
for (const f of delta.folders) folders.set(f.id, f);

const files = new Map<string, ArchivoDrive>();
for (const f of base.files) {
  if (f.parent && carpetasDelta.has(f.parent)) continue; // la relista el delta
  files.set(f.id, f);
}
let nuevos = 0;
for (const f of delta.files) {
  if (!files.has(f.id)) nuevos++;
  files.set(f.id, f);
}

const out: Inventario = { folders: [...folders.values()], files: [...files.values()] };
writeFileSync(basePath, JSON.stringify(out, null, 2) + "\n");
console.log(`carpetas: ${base.folders.length} → ${out.folders.length} | archivos: ${base.files.length} → ${out.files.length} (${nuevos} nuevos en el delta)`);

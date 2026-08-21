// Vincula los comprobantes del Drive del consultorio (carpetas diarias D-M-YY)
// con los ingresos de la caja AR. Lee el inventario que deja el listado de
// Drive en seed-data/comprobantes_drive.json y crea filas en `documents`
// (entity_type 'movement', storage_path = URL del archivo en Drive).
//
// Uso:  npx tsx scripts/vincular-comprobantes.ts [--apply]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, fetchAllRows, argFlags } from "./lib/service-client";
import { vincular, type ArchivoDrive, type CarpetaDrive, type MovIngreso } from "../lib/comprobantes/vincular";
import { clavePaciente } from "../lib/liquidaciones/costeo";

async function main() {
  const flags = argFlags();
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/comprobantes_drive.json"), "utf8")
  ) as { folders: CarpetaDrive[]; files: ArchivoDrive[] };

  const db = await serviceClient({
    accion: "vincular comprobantes del Drive con ingresos (ar)",
    auto: flags.yes,
  });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");
  const companyId = cia.id;

  const movs = await fetchAllRows<{
    id: string; occurred_on: string; description: string | null;
    counterparty_id: string | null;
    counterparty: { display_name?: string } | { display_name?: string }[] | null;
  }>(db, "movements", "id, occurred_on, description, counterparty_id, counterparty:counterparties(display_name)",
    (q) => q.eq("company_id", companyId).eq("kind", "income").neq("status", "void"));

  const candidatos: MovIngreso[] = movs.map((m) => {
    const nombre = (Array.isArray(m.counterparty) ? m.counterparty[0]?.display_name : m.counterparty?.display_name)
      || m.description || "";
    return {
      id: m.id,
      occurred_on: m.occurred_on,
      paciente: nombre,
      pacienteKey: clavePaciente(nombre) || (m.counterparty_id ?? ""),
    };
  });

  const r = vincular(raw.files, raw.folders, candidatos);

  // idempotencia: documents no tiene unique natural — dedup contra lo ya cargado
  const existentes = await fetchAllRows<{ entity_id: string; storage_path: string }>(
    db, "documents", "entity_id, storage_path",
    (q) => q.eq("company_id", companyId).eq("entity_type", "movement"));
  const ya = new Set(existentes.map((d) => `${d.entity_id}|${d.storage_path}`));

  const filas: Record<string, unknown>[] = [];
  for (const v of r.vinculos) {
    for (const movId of v.movementIds) {
      if (ya.has(`${movId}|${v.url}`)) continue;
      filas.push({
        company_id: companyId,
        storage_path: v.url,
        entity_type: "movement",
        entity_id: movId,
        filename: `${v.titulo} (${v.carpeta})`,
        mime: v.mime,
      });
    }
  }

  const corridos = r.vinculos.filter((v) => v.corrimiento !== 0 || v.via === "subida");
  console.log(`Comprobantes en Drive: ${raw.files.length} (carpetas diarias: ${raw.folders.length})`);
  console.log(`  vinculados: ${r.vinculos.length} archivos → ${r.vinculos.reduce((s, v) => s + v.movementIds.length, 0)} movimientos (${filas.length} filas nuevas, ${ya.size} ya cargadas)`);
  if (corridos.length) {
    console.log(`  con fecha corrida (carpeta ≠ día de caja, ±3d): ${corridos.length}`);
    for (const v of corridos) console.log(`    · ${v.titulo} — carpeta ${v.carpeta}, ${v.via === "subida" ? "por fecha de subida" : "caja"} ${v.corrimiento > 0 ? "+" : ""}${v.corrimiento}d`);
  }
  if (r.ambiguos.length) {
    console.log(`  ambiguos (matchean 2+ pacientes, NO se vinculan): ${r.ambiguos.length}`);
    for (const a of r.ambiguos) console.log(`    · ${a.titulo} (${a.fecha}): ${a.pacientes.join(" / ")}`);
  }
  if (r.sinMatch.length) {
    console.log(`  SIN fila en caja (comprobante huérfano): ${r.sinMatch.length}`);
    for (const s of r.sinMatch) console.log(`    · ${s.titulo} — carpeta ${s.carpeta}`);
  }
  if (r.fueraDeCarpeta.length) {
    console.log(`  fuera de carpeta diaria (ignorados): ${r.fueraDeCarpeta.length}`);
    for (const f of r.fueraDeCarpeta.slice(0, 10)) console.log(`    · ${f.title}`);
  }

  if (!flags.apply) {
    console.log("\n(dry-run — nada escrito; correr con --apply)");
    return;
  }
  for (let i = 0; i < filas.length; i += 500) {
    const chunk = filas.slice(i, i + 500);
    const { error } = await db.from("documents").insert(chunk);
    if (error) throw new Error(`insert documents (fila ~${i}): ${error.message}`);
  }
  console.log(`\n✓ ${filas.length} documentos escritos`);
}

main().catch((e) => { console.error(e); process.exit(1); });

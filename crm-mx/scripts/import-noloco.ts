/**
 * Import manual de Noloco → CRM desde una terminal.
 *
 *   npx tsx scripts/import-noloco.ts [ruta-al-json]
 *
 * La lógica de sincronización vive en lib/noloco-sync.ts (compartida con el
 * cron de Vercel /api/sync/noloco). Este script conserva lo que es propio de
 * una corrida manual:
 *   - confirmación de destino (producción exige tipear el ref),
 *   - el GATE contra los conteos que Juan reporta por mail (EXPECTED_2026):
 *     los conteos mensuales de casos nuevos deben coincidir o no se escribe.
 * - Doctores: inserta nuevos por noloco_id; en existentes solo actualiza email/categoría
 *   y stats derivadas (nunca pisa owner, lifecycle manual, teléfonos ni tags).
 * - Casos: upsert por noloco_case_id. is_new_case = (etapa === 'I_1') — LA regla del KPI.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";
import {
  sincronizarNoloco,
  conteosI1PorMes,
  type NolocoCase,
} from "../lib/noloco-sync";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Conteos que Juan reporta por mail (casos nuevos = solo etapa I_1), mes UTC.
// Solo meses CERRADOS: el mes en curso todavía se mueve.
const EXPECTED_2026: Record<string, number> = {
  "2026-01": 22, "2026-02": 23, "2026-03": 19, "2026-04": 25,
  "2026-05": 14, "2026-06": 33, "2026-07": 22,
};

async function main() {
  await confirmarDestino({
    accion: "importar doctores y casos desde el export de Noloco (upsert)",
    auto: process.argv.includes("--yes"),
  });
  const jsonPath = resolve(
    process.argv[2] ?? resolve(__dirname, "../../gestion-mx/data/noloco_mx.json")
  );
  const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
  const casos: NolocoCase[] = raw.casos ?? raw;
  console.log(`Leídos ${casos.length} casos de ${jsonPath}`);

  // ---------- GATE de validación (antes de escribir nada) ----------
  const monthly = conteosI1PorMes(casos);
  const errors: string[] = [];
  for (const [m, expected] of Object.entries(EXPECTED_2026)) {
    const got = monthly[m] ?? 0;
    if (got !== expected) errors.push(`${m}: esperado ${expected}, encontrado ${got}`);
  }
  if (errors.length > 0) {
    console.error("GATE FALLIDO — los casos nuevos no coinciden con los reportes de Juan:");
    for (const e of errors) console.error("  " + e);
    console.error("Conteos encontrados:", JSON.stringify(monthly, null, 2));
    process.exit(1);
  }
  console.log("GATE OK: conteos mensuales 2026 coinciden con los reportes de Juan ✓");

  await sincronizarNoloco(db, casos, console.log);
  console.log("Import OK ✓");
}

main().catch((e) => {
  salirConDestinoRechazado(e);
  console.error("Import falló:", e);
  process.exit(1);
});

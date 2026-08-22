// Control diario: hoja "SOLICITUD FACTURAS Y CONSULTAS" vs caja.
// Lee seed-data/caja_ar_raw.json (lo deja sync-caja-ar.ts) y reporta las
// filas con monto que no tienen NINGÚN pago con ese nombre en la caja (±5d).
// Solo reporta — no escribe nada.
//
// Uso:  npx tsx scripts/control-solicitud.ts [--yes]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, fetchAllRows, argFlags } from "./lib/service-client";
import { extraerFilasSolicitud, faltantesSolicitud, type Conocida } from "../lib/import/solicitud";

const TAB = "SOLICITUD FACTURAS Y CONSULTAS ";

async function main() {
  const flags = argFlags();
  const raw = JSON.parse(readFileSync(resolve(__dirname, "../seed-data/caja_ar_raw.json"), "utf8"));
  const rows = raw.tabs?.[TAB];
  if (!rows) { console.error(`el raw no trae la pestaña '${TAB}'`); process.exit(2); }

  const db = await serviceClient({ accion: "control solicitud de facturas vs caja (ar)", auto: flags.yes });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  const movs = await fetchAllRows<{
    occurred_on: string; description: string | null;
    counterparty: { display_name?: string } | { display_name?: string }[] | null;
  }>(db, "movements", "occurred_on, description, counterparty:counterparties(display_name)",
    (q) => q.eq("company_id", cia!.id).eq("kind", "income").neq("status", "void"));

  let conocidas: Conocida[] = [];
  try { conocidas = JSON.parse(readFileSync(resolve(__dirname, "../seed-data/solicitud_ignorar.json"), "utf8")); } catch { /* sin lista */ }

  const r = faltantesSolicitud(
    extraerFilasSolicitud(rows),
    movs.map((m) => ({
      occurred_on: m.occurred_on,
      nombre: (Array.isArray(m.counterparty) ? m.counterparty[0]?.display_name : m.counterparty?.display_name)
        || m.description || "",
    })),
    conocidas
  );
  console.log(`SOLICITUD vs caja: ${r.cruzadas} filas cruzadas, ${r.faltan.length} SIN rastro en caja${r.salteadas ? ` (${r.salteadas} conocidas salteadas)` : ""}`);
  for (const f of r.faltan) {
    console.log(`  ✗ ${f.fecha} $${f.monto.toLocaleString("es-AR")} — ${f.nombres.join(" | ")}`);
  }
  if (!r.faltan.length) console.log("  ✓ todo lo anotado para facturar tiene su pago en caja");
}

main().catch((e) => { console.error(e); process.exit(1); });

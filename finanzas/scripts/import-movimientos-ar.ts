// Siembra los 877 movimientos reales Ene–Jul 2026 del consultorio
// (seed-data/movimientos_ar_2026.json, parseados del Sheet vivo de la caja).
//
// GATE DE CONTROL: después de escribir, los totales de cobros por mes y moneda
// en la BASE deben ser IDÉNTICOS a los del archivo fuente. Si difieren en un
// centavo, el script termina con error y lo dice fuerte.
//
// Uso:  npx tsx scripts/import-movimientos-ar.ts            (dry-run)
//       npx tsx scripts/import-movimientos-ar.ts --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, upsertBatched, fetchAllRows, argFlags } from "./lib/service-client";
import { medioCanonico } from "../lib/import/medios";
import { KeyBuilder } from "../lib/import/keys";

type MovAR = {
  fecha: string; mes: number; doctora: string | null; atribucion_clara: boolean;
  tab: string; paciente: string | null; ars: number; usd: number;
  medio: string | null; motivo: string | null; obs: string | null;
  tipo: "cobro" | "retiro_liquidacion" | "gasto_consultorio" | "gasto_tratamiento";
  categoria: string | null;
};

const CATEGORIA_INGRESO: Record<string, string> = {
  Alineadores: "Alineadores",
  Mensualidad: "Mensualidad",
  "Contención": "Contención",
  Consulta: "Consulta",
  Otros: "Otros ingresos",
};

// La pata ya es mono-moneda: la cuenta se decide por medio canónico + moneda.
function cuentaPara(m: MovAR & { currency: "ARS" | "USD" }): { name: string; pendiente: boolean } {
  const usd = m.currency === "USD";
  const canon = medioCanonico(m.medio);
  if (canon === "ks") return { name: usd ? "Cuenta KS USD" : "Cuenta KS", pendiente: false };
  if (canon === "coni") return usd
    ? { name: "Sin medio USD (a revisar)", pendiente: true }
    : { name: "Coni – cuenta propia", pendiente: false };
  if (canon === "mp") return usd
    ? { name: "Sin medio USD (a revisar)", pendiente: true }
    : { name: "Mercado Pago", pendiente: false };
  if (canon === "efectivo") return { name: usd ? "Efectivo USD" : "Efectivo", pendiente: false };
  return { name: usd ? "Sin medio USD (a revisar)" : "Sin medio (a revisar)", pendiente: true };
}

async function main() {
  const flags = argFlags();
  const filas: MovAR[] = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/movimientos_ar_2026.json"), "utf8")
  );

  // Una fila puede traer ARS y USD A LA VEZ (caso real: retiro 29/4 con
  // ars=-50000 y usd=66965). Cada moneda es una pata independiente del ledger:
  // partirla acá evita perder plata en silencio.
  type Pata = MovAR & { currency: "ARS" | "USD"; amount: number };
  const movs: Pata[] = [];
  for (const m of filas) {
    if ((m.ars ?? 0) !== 0) movs.push({ ...m, currency: "ARS", amount: Math.abs(m.ars) });
    if ((m.usd ?? 0) !== 0) movs.push({ ...m, currency: "USD", amount: Math.abs(m.usd) });
  }

  // Totales esperados desde la FUENTE (el gate compara contra esto).
  const esperado = new Map<string, number>(); // "2026-01|ARS|income" → total
  for (const m of movs) {
    const kind = m.tipo === "cobro" ? "income" : "expense";
    const k = `${m.fecha.slice(0, 7)}|${m.currency}|${kind}`;
    esperado.set(k, Math.round(((esperado.get(k) ?? 0) + m.amount) * 100) / 100);
  }

  console.log(`Fuente: ${filas.length} filas → ${movs.length} patas mono-moneda.`);
  if (flags.dryRun) {
    console.log("DRY-RUN (sin --apply no escribe). Totales de la fuente:");
    for (const [k, v] of [...esperado].sort()) console.log(`  ${k}: ${v.toLocaleString("es-AR")}`);
    return;
  }

  const db = await serviceClient({
    accion: `sembrar ${movs.length} movimientos AR (caja consultorio Ene–Jul 2026)`,
    auto: flags.yes,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente: correr seed-base primero");
  const companyId = cia.id;

  const { data: accounts } = await db.from("accounts").select("id, name, currency").eq("company_id", companyId);
  const accByName = Object.fromEntries((accounts ?? []).map((a) => [a.name, a]));
  const { data: cats } = await db.from("categories").select("id, name, flow").eq("company_id", companyId);
  const catByName = Object.fromEntries((cats ?? []).map((c) => [c.name, c.id]));
  const liquidacionesCat = catByName["Liquidaciones profesionales"];
  if (!liquidacionesCat) throw new Error("falta la categoría 'Liquidaciones profesionales': correr seed-base");

  // Contrapartes: profesionales existentes + pacientes get-or-create en bloque.
  const existing = await fetchAllRows<{ id: string; display_name: string; kind: string }>(
    db, "counterparties", "id, display_name, kind", (q) => q.eq("company_id", companyId)
  );
  const cpByName = new Map(existing.map((c) => [`${c.kind}|${c.display_name.trim().toLowerCase()}`, c.id]));

  const pacientesNuevos = new Map<string, string>(); // nombre → nombre original
  for (const m of movs) {
    const p = (m.paciente ?? "").trim();
    if (m.tipo === "cobro" && p && !cpByName.has(`patient|${p.toLowerCase()}`)) {
      pacientesNuevos.set(p.toLowerCase(), p);
    }
  }
  if (pacientesNuevos.size) {
    const rows = [...pacientesNuevos.values()].map((name) => ({
      company_id: companyId, kind: "patient", display_name: name,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("counterparties").insert(rows.slice(i, i + 500));
      if (error) throw new Error(`alta de pacientes: ${error.message}`);
    }
    const refreshed = await fetchAllRows<{ id: string; display_name: string; kind: string }>(
      db, "counterparties", "id, display_name, kind", (q) => q.eq("company_id", companyId)
    );
    cpByName.clear();
    for (const c of refreshed) cpByName.set(`${c.kind}|${c.display_name.trim().toLowerCase()}`, c.id);
    console.log(`✓ ${pacientesNuevos.size} pacientes creados`);
  }

  const keys = new KeyBuilder();
  const rows = movs.map((m) => {
    const { currency, amount } = m;
    const kind = m.tipo === "cobro" ? "income" : "expense";
    const cuenta = cuentaPara(m);
    const account = accByName[cuenta.name];
    if (!account) throw new Error(`cuenta inexistente: ${cuenta.name}`);
    if (account.currency !== currency) throw new Error(`moneda incoherente ${cuenta.name} ${currency}`);

    let categoryId: string | null = null;
    let counterpartyId: string | null = null;
    if (m.tipo === "cobro") {
      categoryId = m.categoria ? (catByName[CATEGORIA_INGRESO[m.categoria] ?? ""] ?? null) : null;
      const p = (m.paciente ?? "").trim();
      counterpartyId = p ? (cpByName.get(`patient|${p.toLowerCase()}`) ?? null) : null;
    } else if (m.tipo === "retiro_liquidacion") {
      categoryId = liquidacionesCat;
      const d = (m.doctora ?? "").trim();
      counterpartyId = d ? (cpByName.get(`professional|${d.toLowerCase()}`) ?? null) : null;
    }
    // gasto_consultorio / gasto_tratamiento quedan sin categoría: se
    // reclasifican en la app, no se inventa la clasificación en el seed.

    return {
      company_id: companyId,
      account_id: account.id,
      currency,
      kind,
      status: cuenta.pendiente ? "pending" : "confirmed",
      occurred_on: m.fecha,
      amount,
      category_id: categoryId,
      counterparty_id: counterpartyId,
      description: m.motivo?.trim() || (m.tipo === "retiro_liquidacion"
        ? `Retiro liquidación ${m.doctora ?? ""}`.trim()
        : m.tipo.replace("_", " ")),
      source: "seed",
      external_key: keys.build("caja", m.tab, m.fecha, m.paciente, m.ars, m.usd, m.motivo, currency),
      meta: {
        tab: m.tab, doctora: m.doctora, atribucion_clara: m.atribucion_clara,
        medio_raw: m.medio, motivo: m.motivo, obs: m.obs, tipo_origen: m.tipo,
        categoria_origen: m.categoria,
      },
    };
  });

  // Filas que YA NO están en la caja: Claudia editó el monto/el texto (la clave
  // es de contenido: editar = clave nueva) o borró la fila. Sin esto la vieja
  // queda viva y el conteo del gate falla todos los días. Se anulan, no se
  // borran (regla del ledger: status='void' + audit).
  const clavesEntrantes = new Set(rows.map((r) => r.external_key));
  const enBaseAntes = await fetchAllRows<{ id: string; external_key: string | null; occurred_on: string; amount: string; currency: string; description: string | null }>(
    db, "movements", "id, external_key, occurred_on, amount, currency, description",
    (q) => q.eq("company_id", companyId).eq("source", "seed").neq("status", "void")
  );
  const desaparecidos = enBaseAntes.filter((m) => m.external_key && !clavesEntrantes.has(m.external_key));
  const LIMITE_DESAPARECIDOS = 15;
  if (desaparecidos.length) {
    console.log(`\nFilas que ya no están en la caja (editadas o borradas): ${desaparecidos.length}`);
    for (const m of desaparecidos.slice(0, 20)) {
      console.log(`  · ${m.occurred_on} ${m.currency} ${Number(m.amount).toLocaleString("es-AR")} — ${m.description ?? "—"}`);
    }
    if (desaparecidos.length > LIMITE_DESAPARECIDOS) {
      console.error(`\n✗ GATE: desaparecieron ${desaparecidos.length} filas (límite ${LIMITE_DESAPARECIDOS}).`);
      console.error("  Eso no parece una edición puntual sino un problema de la fuente: NO se escribe nada.");
      process.exit(1);
    }
  }

  const written = await upsertBatched(db, "movements", rows, "company_id,external_key");
  console.log(`✓ ${written} movimientos upserteados`);

  if (desaparecidos.length) {
    const { error } = await db.from("movements").update({ status: "void" })
      .in("id", desaparecidos.map((m) => m.id));
    if (error) throw new Error(`anular desaparecidos: ${error.message}`);
    console.log(`✓ ${desaparecidos.length} anuladas (status void)`);
  }

  // ---------- GATE ----------
  const enBase = await fetchAllRows<{ occurred_on: string; currency: string; kind: string; amount: string }>(
    db, "movements", "occurred_on, currency, kind, amount",
    (q) => q.eq("company_id", companyId).eq("source", "seed").neq("status", "void")
  );
  const real = new Map<string, number>();
  for (const r of enBase) {
    const k = `${r.occurred_on.slice(0, 7)}|${r.currency}|${r.kind}`;
    real.set(k, Math.round(((real.get(k) ?? 0) + Number(r.amount)) * 100) / 100);
  }
  let falla = false;
  for (const [k, v] of [...esperado].sort()) {
    const got = real.get(k) ?? 0;
    const ok = Math.abs(got - v) < 0.01;
    if (!ok) falla = true;
    console.log(`  ${ok ? "✓" : "✗ GATE"} ${k}: fuente ${v.toLocaleString("es-AR")} · base ${got.toLocaleString("es-AR")}`);
  }
  if (enBase.length !== movs.length) {
    console.log(`  ✗ GATE conteo: fuente ${movs.length} · base ${enBase.length}`);
    falla = true;
  }
  if (falla) {
    console.error("\n✗ EL GATE FALLÓ: los totales de la base NO coinciden con la fuente.");
    process.exit(1);
  }
  console.log(`\n✓ GATE OK: ${movs.length} movimientos, totales idénticos a la fuente mes a mes.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

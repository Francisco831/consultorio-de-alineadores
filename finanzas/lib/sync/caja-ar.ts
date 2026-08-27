// La caja del consultorio, de punta a punta: Apps Script → ledger.
//
// Vivía repartido entre scripts/sync-caja-ar.ts (traer + parsear con python) e
// import-movimientos-ar.ts (escribir + gate). Se unificó acá para que el cron
// de Vercel corra EXACTAMENTE el mismo código que la terminal: dos
// implementaciones de la external_key serían dos cajas distintas.
//
// Tres cosas que no se tocan sin entender por qué están:
//   · la external_key es de CONTENIDO y con ordinal intra-día → re-importar es
//     incremental gratis, y editar una fila en la caja crea una clave nueva.
//   · el gate de totales: si la base no queda idéntica a la fuente mes a mes,
//     la corrida se marca fallida (y la app lo muestra).
//   · el gate de regresión: un mes CERRADO no puede achicarse solo.

import type { SupabaseClient } from "@supabase/supabase-js";
import { KeyBuilder } from "@/lib/import/keys";
import { medioCanonico } from "@/lib/import/medios";
import { pareceCuota } from "@/lib/liquidaciones/planes-pacientes";
import { rawAMovs, type MovCaja, type RawCaja } from "@/lib/import/caja-ar";
import { fetchAllRows, upsertBatched } from "@/lib/sync/db";
import { currentPeriodIn } from "@/lib/dates";
import overridesJson from "@/seed-data/medios_overrides.json";

/** Correcciones por fila verificadas contra el extracto (pesos en la columna
 *  de dólares, medios confirmados a mano). Es interpretación, no identidad. */
type Override = { cuenta?: string; moneda?: "ARS" | "USD"; monto?: number; ignorar?: boolean; nota?: string };
const OVERRIDES = overridesJson as Record<string, Override>;

const CATEGORIA_INGRESO: Record<string, string> = {
  Alineadores: "Alineadores",
  Mensualidad: "Mensualidad",
  "Contención": "Contención",
  Consulta: "Consulta",
  Otros: "Otros ingresos",
};

/** Filas que ya no están en la caja: más de esto no es una edición, es un problema. */
const LIMITE_DESAPARECIDOS = 15;

export type ResultadoCaja = {
  filas: number;
  patas: number;
  escritas: number;
  anuladas: number;
  /** Cobros con texto de cuota que quedaron fuera de Alineadores. */
  invisibles: string[];
  totales: Array<{ clave: string; fuente: number; base: number }>;
};

export class ErrorGate extends Error {}

/** Trae el JSON crudo de la caja (Apps Script gas-caja-ar.gs). */
export async function traerRawCaja(url: string, secret: string): Promise<RawCaja> {
  // El secreto se cuelga de un objeto URL YA parseado, nunca de un string que
  // fetch pueda rechazar: si CAJA_AR_URL viene mal cargada, el TypeError de
  // undici trae la URL entera —con el secreto— en su message, y ese message se
  // persiste en sync_runs.log, que cualquier miembro de la empresa lee.
  let destino: URL;
  try {
    destino = new URL(url);
  } catch {
    throw new Error("CAJA_AR_URL no es una URL válida");
  }
  destino.searchParams.set("secret", secret);
  // El Apps Script tarda ~70s normales; más de 180 es que se colgó. Sin este
  // corte la corrida se come los 300s de maxDuration, Vercel la mata sin que
  // llegue a cerrarse, y la fila de sync_runs queda 'running' para siempre —
  // que con el cron horario nunca acumula el día que dispara la alerta.
  const res = await fetch(destino, { cache: "no-store", signal: AbortSignal.timeout(180_000) });
  const texto = await res.text();
  if (!res.ok || texto === "no") {
    throw new Error(`Apps Script respondió ${res.status}: ${texto.slice(0, 120)}`);
  }
  const raw = JSON.parse(texto) as RawCaja;
  if (!raw.tabs || !Object.keys(raw.tabs).length) throw new Error("respuesta sin pestañas");
  return raw;
}

// La pata ya es mono-moneda: la cuenta se decide por medio canónico + moneda.
function cuentaPara(m: MovCaja & { currency: "ARS" | "USD"; amount: number }): { name: string; pendiente: boolean } {
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
  // Sin medio: si es GASTO o RETIRO, sale de la caja física — es efectivo
  // (decisión Pancho 21/8, "bloque 1"). Dos excepciones: lo de la pestaña de
  // Coni va a su cuenta propia (contabilidad separada; su pata USD no existe),
  // y un gasto USD grande sin medio huele a monto en pesos en la columna de
  // dólares (casos reales 21/4 y 29/4) — queda en revisión, no se inventa.
  if (m.tipo !== "cobro") {
    if (m.tab === "CONI 2020") {
      return usd
        ? { name: "Sin medio USD (a revisar)", pendiente: true }
        : { name: "Coni – cuenta propia", pendiente: false };
    }
    if (usd && m.amount >= 5000) return { name: "Sin medio USD (a revisar)", pendiente: true };
    return { name: usd ? "Efectivo USD" : "Efectivo", pendiente: false };
  }
  return { name: usd ? "Sin medio USD (a revisar)" : "Sin medio (a revisar)", pendiente: true };
}

type Pata = MovCaja & {
  currency: "ARS" | "USD"; amount: number; key: string; seq: number; cuentaOverride?: string;
};

/**
 * Parte cada fila en patas mono-moneda y les congela la clave.
 *
 * Una fila puede traer ARS y USD A LA VEZ (caso real: retiro 29/4 con
 * ars=-50000 y usd=66965). Cada moneda es una pata independiente del ledger:
 * partirla acá evita perder plata en silencio. La clave se computa ANTES de
 * aplicar overrides: la identidad es el contenido de la caja.
 *
 * `seq` es el número de fila original, compartido por las dos patas: el costeo
 * de cuotas depende del orden de la caja (la primera que menciona una cuota se
 * la lleva). Antes lo escribía backfill-seq.ts en una segunda pasada, porque el
 * import le pisaba el meta; ahora nace acá y esa pasada ya no hace falta.
 */
export function patasDeCaja(filas: MovCaja[]): { patas: Pata[]; overridesAplicados: number } {
  const keys = new KeyBuilder();
  const patas: Pata[] = [];
  let overridesAplicados = 0;
  let seq = 0;
  for (const m of filas) {
    for (const currency of ["ARS", "USD"] as const) {
      const monto = currency === "ARS" ? m.ars : m.usd;
      if ((monto ?? 0) === 0) continue;
      const key = keys.build("caja", m.tab, m.fecha, m.paciente, m.ars, m.usd, m.motivo, currency);
      const o = OVERRIDES[key];
      if (o) overridesAplicados++;
      // pata espuria (monto fantasma en la columna equivocada de la caja):
      // no entra a la fuente → el paso de "desaparecidos" la anula en la base
      if (o?.ignorar) continue;
      patas.push({
        ...m,
        currency: o?.moneda ?? currency,
        // el monto corregido entra TAMBIÉN en el total esperado del gate: el
        // override es verdad declarada, no un parche sobre la base
        amount: o?.monto ?? Math.abs(monto),
        key, seq, cuentaOverride: o?.cuenta,
      });
    }
    seq++;   // el número de FILA original, compartido por sus patas
  }
  return { patas, overridesAplicados };
}

/**
 * GATE DE REGRESIÓN: un mes cerrado no puede achicarse. Si Claudia borra filas
 * viejas, eso tiene que mirarlo un humano y la corrida aborta sin escribir.
 *
 * Los dos mapas tienen que venir SIN overrides. El gate viejo comparaba archivo
 * contra archivo, los dos crudos, así que un override nunca lo tocaba; al pasar
 * a comparar la base —que ya los tiene aplicados— contra la fuente, agregar un
 * override que baje un mes cerrado se leería como un borrado. Y como el gate
 * aborta ANTES de escribir, la base nunca bajaría: el cron quedaría trabado
 * hora tras hora sin forma de destrabarlo desde la app.
 *
 * Sólo mira ingresos: los gastos se reclasifican y corrigen a mano.
 */
export function regresionesDeMesesCerrados(
  antes: Map<string, number>, ahora: Map<string, number>, mesActual: string
): string[] {
  const regresiones: string[] = [];
  for (const [k, v] of antes) {
    if (!k.endsWith("|income")) continue;
    if (k.slice(0, 7) >= mesActual) continue;
    const n = ahora.get(k) ?? 0;
    if (n < v - 0.005) {
      regresiones.push(`${k}: ${v.toLocaleString("es-AR")} → ${n.toLocaleString("es-AR")}`);
    }
  }
  return regresiones;
}

/** Totales por mes/moneda/signo, que es lo que comparan los dos gates. */
function totalesDe(patas: Pata[]): Map<string, number> {
  const t = new Map<string, number>();
  for (const m of patas) {
    const kind = m.tipo === "cobro" ? "income" : "expense";
    const k = `${m.fecha.slice(0, 7)}|${m.currency}|${kind}`;
    t.set(k, Math.round(((t.get(k) ?? 0) + m.amount) * 100) / 100);
  }
  return t;
}

/**
 * CONTROL ANTI-ETCHEGOYEN: un cobro con texto de cuota que NO quedó en
 * Alineadores es invisible para "Por cobrar" → el paciente figura falso moroso
 * (o su plan no avanza). Pasa cuando la caja corre las columnas o classify() no
 * conoce una redacción nueva. No aborta, pero lo canta en cada corrida.
 */
function cobrosInvisibles(patas: Pata[]): string[] {
  const vistas = new Set<string>();
  const out: string[] = [];
  for (const m of patas) {
    if (m.tipo !== "cobro") continue;
    if (m.categoria === "Alineadores" || m.categoria === "Contención") continue;
    if (!pareceCuota([m.paciente, m.motivo, m.obs, m.medio].filter(Boolean).join(" "))) continue;
    const k = `${m.tab}|${m.fecha}|${m.paciente}|${m.motivo}|${m.obs}`;
    if (vistas.has(k)) continue;   // una fila con ARS y USD genera dos patas
    vistas.add(k);
    out.push(
      `${m.fecha} ${m.paciente || "—"} ${m.currency} ${m.amount.toLocaleString("es-AR")} ` +
      `[${m.categoria ?? "sin categoría"}] — ${[m.motivo, m.obs, m.medio].filter(Boolean).join(" · ")}`
    );
  }
  return out;
}

/**
 * Escribe la caja en el ledger. Tira ErrorGate si algún control no pasa —
 * y en ese caso NO deja la base a medias: los gates que pueden abortar
 * (regresión y desaparecidos) corren ANTES de escribir.
 */
export async function importarCajaAr(
  db: SupabaseClient,
  filas: MovCaja[],
  opts: { dryRun?: boolean; log?: (m: string) => void } = {}
): Promise<ResultadoCaja> {
  const log = opts.log ?? (() => {});
  const { patas, overridesAplicados } = patasDeCaja(filas);
  if (overridesAplicados) log(`${overridesAplicados} overrides de medio/moneda aplicados`);
  const esperado = totalesDe(patas);
  log(`Fuente: ${filas.length} filas → ${patas.length} patas mono-moneda.`);

  const invisibles = cobrosInvisibles(patas);
  for (const i of invisibles) log(`⚠ cobro con texto de cuota fuera de Alineadores: ${i}`);

  const { data: cia } = await db.from("companies").select("id, timezone").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente: correr seed-base primero");
  const companyId = cia.id as string;

  // Lo que hay HOY en la base es, por el gate de la corrida anterior, idéntico
  // a la caja de ayer: sirve de referencia para el gate de regresión sin
  // guardar ningún archivo (que es lo que se perdió al mudar el sync a Vercel).
  const enBaseAntes = await fetchAllRows<{
    id: string; external_key: string | null; occurred_on: string;
    amount: string; currency: string; kind: string; description: string | null;
  }>(
    db, "movements", "id, external_key, occurred_on, amount, currency, kind, description",
    (q) => q.eq("company_id", companyId).eq("source", "seed").neq("status", "void")
  );
  // Los dos lados del gate van SIN overrides (ver regresionesDeMesesCerrados).
  const antes = new Map<string, number>();
  for (const r of enBaseAntes) {
    if (r.external_key && OVERRIDES[r.external_key]) continue;
    const k = `${r.occurred_on.slice(0, 7)}|${r.currency}|${r.kind}`;
    antes.set(k, Math.round(((antes.get(k) ?? 0) + Number(r.amount)) * 100) / 100);
  }
  const esperadoSinOverrides = totalesDe(patas.filter((m) => !OVERRIDES[m.key]));

  // el mes se cierra en Buenos Aires, no en UTC: a las 21:30 del 31 ya sería
  // el mes que viene y agosto pasaría a "cerrado" tres horas antes de tiempo
  const mesActual = currentPeriodIn(cia.timezone ?? "America/Argentina/Buenos_Aires");
  const regresiones = regresionesDeMesesCerrados(antes, esperadoSinOverrides, mesActual);
  if (regresiones.length) {
    throw new ErrorGate(`meses cerrados se achicaron — no se escribió nada: ${regresiones.join(" · ")}`);
  }

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

  const pacientesNuevos = new Map<string, string>();
  for (const m of patas) {
    const p = (m.paciente ?? "").trim();
    if (m.tipo === "cobro" && p && !cpByName.has(`patient|${p.toLowerCase()}`)) {
      pacientesNuevos.set(p.toLowerCase(), p);
    }
  }
  if (pacientesNuevos.size && !opts.dryRun) {
    const nuevos = [...pacientesNuevos.values()].map((name) => ({
      company_id: companyId, kind: "patient", display_name: name,
    }));
    for (let i = 0; i < nuevos.length; i += 500) {
      const { error } = await db.from("counterparties").insert(nuevos.slice(i, i + 500));
      if (error) throw new Error(`alta de pacientes: ${error.message}`);
    }
    const refreshed = await fetchAllRows<{ id: string; display_name: string; kind: string }>(
      db, "counterparties", "id, display_name, kind", (q) => q.eq("company_id", companyId)
    );
    cpByName.clear();
    for (const c of refreshed) cpByName.set(`${c.kind}|${c.display_name.trim().toLowerCase()}`, c.id);
    log(`${pacientesNuevos.size} pacientes creados`);
  }

  const rows = patas.map((m) => {
    const { currency, amount } = m;
    const kind = m.tipo === "cobro" ? "income" : "expense";
    const cuenta = m.cuentaOverride ? { name: m.cuentaOverride, pendiente: false } : cuentaPara(m);
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
    // reclasifican en la app, no se inventa la clasificación en el sync.

    return {
      company_id: companyId,
      account_id: account.id,
      currency, kind,
      status: cuenta.pendiente ? "pending" : "confirmed",
      occurred_on: m.fecha,
      amount,
      category_id: categoryId,
      counterparty_id: counterpartyId,
      description: m.motivo?.trim() || (m.tipo === "retiro_liquidacion"
        ? `Retiro liquidación ${m.doctora ?? ""}`.trim()
        : m.tipo.replace("_", " ")),
      source: "seed",
      external_key: m.key,
      meta: {
        tab: m.tab, doctora: m.doctora, atribucion_clara: m.atribucion_clara,
        medio_raw: m.medio, motivo: m.motivo, obs: m.obs, tipo_origen: m.tipo,
        categoria_origen: m.categoria, seq: m.seq,
      },
    };
  });

  // Filas que YA NO están en la caja: Claudia editó el monto/el texto (la clave
  // es de contenido: editar = clave nueva) o borró la fila. Sin esto la vieja
  // queda viva y el conteo del gate falla todos los días. Se anulan, no se
  // borran (regla del ledger: status='void' + audit).
  const clavesEntrantes = new Set(rows.map((r) => r.external_key));
  const desaparecidos = enBaseAntes.filter((m) => m.external_key && !clavesEntrantes.has(m.external_key));
  if (desaparecidos.length) {
    log(`Filas que ya no están en la caja (editadas o borradas): ${desaparecidos.length}`);
    for (const m of desaparecidos.slice(0, 20)) {
      log(`  · ${m.occurred_on} ${m.currency} ${Number(m.amount).toLocaleString("es-AR")} — ${m.description ?? "—"}`);
    }
    if (desaparecidos.length > LIMITE_DESAPARECIDOS) {
      throw new ErrorGate(
        `desaparecieron ${desaparecidos.length} filas (límite ${LIMITE_DESAPARECIDOS}): ` +
        "eso no parece una edición puntual sino un problema de la fuente — no se escribió nada"
      );
    }
  }

  const totales = [...esperado].sort().map(([clave, fuente]) => ({ clave, fuente, base: 0 }));
  if (opts.dryRun) {
    return { filas: filas.length, patas: patas.length, escritas: 0, anuladas: 0, invisibles, totales };
  }

  const escritas = await upsertBatched(db, "movements", rows, "company_id,external_key");
  log(`${escritas} movimientos upserteados`);

  if (desaparecidos.length) {
    const { error } = await db.from("movements").update({ status: "void" })
      .in("id", desaparecidos.map((m) => m.id));
    if (error) throw new Error(`anular desaparecidos: ${error.message}`);
    log(`${desaparecidos.length} anuladas (status void)`);
  }

  // ---------- GATE DE TOTALES ----------
  const enBase = await fetchAllRows<{ occurred_on: string; currency: string; kind: string; amount: string }>(
    db, "movements", "occurred_on, currency, kind, amount",
    (q) => q.eq("company_id", companyId).eq("source", "seed").neq("status", "void")
  );
  const real = new Map<string, number>();
  for (const r of enBase) {
    const k = `${r.occurred_on.slice(0, 7)}|${r.currency}|${r.kind}`;
    real.set(k, Math.round(((real.get(k) ?? 0) + Number(r.amount)) * 100) / 100);
  }
  const fallas: string[] = [];
  for (const t of totales) {
    t.base = real.get(t.clave) ?? 0;
    if (Math.abs(t.base - t.fuente) >= 0.01) {
      fallas.push(`${t.clave}: fuente ${t.fuente.toLocaleString("es-AR")} · base ${t.base.toLocaleString("es-AR")}`);
    }
  }
  if (enBase.length !== patas.length) fallas.push(`conteo: fuente ${patas.length} · base ${enBase.length}`);
  if (fallas.length) throw new ErrorGate(`los totales de la base no coinciden con la fuente: ${fallas.join(" · ")}`);

  return { filas: filas.length, patas: patas.length, escritas, anuladas: desaparecidos.length, invisibles, totales };
}

/** El paso completo: traer de la caja e importar. Es lo que corre el cron. */
export async function sincronizarCajaAr(
  db: SupabaseClient,
  opts: { url: string; secret: string; log?: (m: string) => void }
): Promise<ResultadoCaja> {
  const raw = await traerRawCaja(opts.url, opts.secret);
  const movs = rawAMovs(raw, (m) => opts.log?.(`AVISO: ${m}`));
  return importarCajaAr(db, movs, { log: opts.log });
}

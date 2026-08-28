// Pagos de la planilla "Administración México" (hoja Facturación y Cobranzas)
// → tabla payments. Corre en Vercel (cron diario, vercel.json), no en la Mac.
//
// POR QUÉ ESTE ARCHIVO EXISTE: el sync vivía en scripts/sync-pagos-planilla.ts,
// que parsea la planilla llamando a python3 (openpyxl). En Vercel no hay
// python, así que la mitad "pagos" del parser está portada acá a TypeScript.
// La equivalencia con el parser viejo NO es un supuesto: pagos-planilla.test.ts
// corre este código sobre data/pagos_planilla_gas.json (respuesta cruda del
// Apps Script) y exige que dé EXACTAMENTE data/pagos_planilla.json (lo que
// escribió python). Si alguien toca una de las dos, el test lo grita.
//
// El script local sigue existiendo y sigue siendo el único camino para:
//   · el export .xlsx manual (--xlsx), que necesita openpyxl;
//   · data/casos_planilla.json y las copias a finanzas/seed-data/, que son
//     archivos del disco de Pancho y Vercel no puede escribir.
// Esta ruta se ocupa solo del CRM, que es lo que tiene que andar sin la Mac.

import type { SupabaseClient } from "@supabase/supabase-js";

import { traerTodo } from "./paginar";

export const TAB = "Facturación y Cobranzas";

/** Los 5 slots de pago que tiene cada fila de la planilla. */
const SLOTS = 5;

export type PagoPlanilla = {
  external_key: string;
  doctor_nombre_raw: string | null;
  noloco_id: string | null;
  case_external_id: string | null;
  paciente: string | null;
  amount_mxn: number;
  paid_at: string;
  method: string | null;
  notes: string | null;
};

type Celda = string | number | boolean | null | undefined;

// ---------------------------------------------------------------- celdas
// Port 1:1 de cell_str / to_amount / to_date / norm_method de
// scripts/parse_enrichment.py. Cualquier cambio acá va también allá.

export function cellStr(v: Celda): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : String(v);
  return String(v).trim();
}

/** Igual que float() de python: no acepta "0x10" ni "12abc" (Number sí). */
const NUMERO = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function toAmount(v: Celda): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replaceAll("$", "").replaceAll(",", "").replaceAll(" ", "");
  if (!s || s === "-" || s === "—") return null;
  return NUMERO.test(s) ? Number(s) : null;
}

/** Los 4 formatos que acepta to_date(), en el mismo orden. */
const FORMATOS: { re: RegExp; orden: [number, number, number] }[] = [
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/, orden: [1, 2, 3] },
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, orden: [1, 2, 3] },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, orden: [3, 2, 1] },
  { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, orden: [3, 2, 1] },
];

export function toDate(v: Celda): string | null {
  if (v === null || v === undefined) return null;
  const s = cellStr(v).slice(0, 19);
  for (const { re, orden } of FORMATOS) {
    const m = re.exec(s);
    if (!m) continue;
    const [y, mes, dia] = orden.map((i) => Number(m[i]));
    // strptime rechaza 32/01: si el Date no vuelve al mismo día, no era fecha.
    const d = new Date(Date.UTC(y, mes - 1, dia));
    if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
      return null;
    }
    return `${String(y).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
  }
  return null;
}

const sinAcentos = (s: string) => s.normalize("NFD").replace(/\p{Mn}/gu, "");

export function normMethod(raw: Celda): string | null {
  const m = cellStr(raw);
  if (!m) return null;
  const k = sinAcentos(m).toLowerCase().trim().replace(/\.+$/, "").trim();
  if (k === "tr" || k === "transferencia") return "TR";
  if (k === "mp" || k === "mercado pago" || k === "mercadopago") return "MP";
  if (k.startsWith("dep")) return "Depósito";
  return m;
}

// ---------------------------------------------------------------- grilla
/**
 * Normaliza la respuesta del Apps Script (gas-pagos-planilla.LISTO.gs) a la
 * grilla que espera el parser. Las fechas llegan como timestamp ISO en UTC
 * ("2022-04-22T03:00:00.000Z" = medianoche GMT-3/-6): el día calendario es el
 * del string, así que se corta en seco a 10 caracteres — convertirlo con Date
 * lo correría un día para atrás.
 */
export function grillaDeAppsScript(data: unknown): Celda[][] {
  const d = data as { tab?: unknown; values?: unknown };
  if (d?.tab !== TAB) {
    throw new Error(
      `el JSON no es de la hoja ${JSON.stringify(TAB)}: ${JSON.stringify(data).slice(0, 120)}`
    );
  }
  if (!Array.isArray(d.values) || d.values.length === 0) {
    throw new Error("el Apps Script devolvió la hoja vacía");
  }
  const isoTs = /^\d{4}-\d{2}-\d{2}T\d{2}:/;
  return (d.values as Celda[][]).map((row) =>
    row.map((c) => (typeof c === "string" && isoTs.test(c) ? c.slice(0, 10) : c))
  );
}

// ---------------------------------------------------------------- parser
export function parsePagos(rows: Celda[][]): { pagos: PagoPlanilla[]; sinFecha: number } {
  const header = rows[0].map(cellStr);
  const idxAll = (pat: RegExp) =>
    header.map((c, i) => (pat.test(c.trim()) ? i : -1)).filter((i) => i >= 0);
  const idxExacto = (nombre: string) =>
    header.findIndex((c) => c.trim().toUpperCase() === nombre);

  // La hoja abre con DOS columnas "ID" (una vacía, otra con el ME…): vale la
  // segunda, igual que en el parser de python.
  const idCols = header.map((c, i) => (c.trim().toUpperCase() === "ID" ? i : -1)).filter((i) => i >= 0);
  if (idCols.length === 0) throw new Error("la hoja no tiene columna ID");
  const cId = idCols.length > 1 ? idCols[1] : idCols[0];
  const cPac = idxExacto("PACIENTE");
  const cProf = idxExacto("PROFESIONAL");
  if (cPac < 0 || cProf < 0) throw new Error("la hoja no tiene PACIENTE / PROFESIONAL");

  const formas = idxAll(/^FORMA DE PAGO$/i);
  const fechasPago = idxAll(/^FECHA PAGO$/i);
  const montos = idxAll(/^\d\s*°\s*PAGO$/i);
  const nfacs = idxAll(/^N°\s*FAC$/i);
  if (formas.length !== SLOTS || fechasPago.length !== SLOTS || montos.length !== SLOTS) {
    throw new Error(
      `la hoja cambió de estructura: formas=${formas} fechas=${fechasPago} montos=${montos}`
    );
  }

  const pagos: PagoPlanilla[] = [];
  let sinFecha = 0;
  for (let rix = 2; rix <= rows.length; rix++) {
    const row = rows[rix - 1] ?? [];
    const cells: Celda[] = [...row];
    while (cells.length < header.length) cells.push(null);

    const caseId = cellStr(cells[cId]);
    if (!caseId || caseId.toUpperCase() === "ID") continue;
    const profRaw = cellStr(cells[cProf]);

    for (let k = 0; k < SLOTS; k++) {
      const amt = toAmount(cells[montos[k]]);
      const pdate = toDate(cells[fechasPago[k]]);
      if (amt === null || amt === 0) continue;
      if (!pdate) {
        sinFecha++;
        continue;
      }
      const nfac = k < nfacs.length && nfacs[k] < cells.length ? cellStr(cells[nfacs[k]]) : "";
      pagos.push({
        external_key: `adminmx:${rix}:${k + 1}`,
        doctor_nombre_raw: profRaw || null,
        noloco_id: null,
        case_external_id: caseId,
        paciente: cellStr(cells[cPac]) || null,
        amount_mxn: Math.round(amt * 100) / 100,
        paid_at: pdate,
        method: normMethod(cells[formas[k]]),
        notes: nfac && nfac !== "-" ? `fac:${nfac}` : null,
      });
    }
  }
  return { pagos, sinFecha };
}

// ---------------------------------------------------------------- bajada
export async function bajarPlanilla(url: string, secret: string): Promise<Celda[][]> {
  const res = await fetch(`${url}?secret=${encodeURIComponent(secret)}`, {
    redirect: "follow",
    cache: "no-store",
  });
  const texto = await res.text();
  if (!res.ok || !texto.trimStart().startsWith("{")) {
    throw new Error(`Apps Script respondió raro (HTTP ${res.status}): ${texto.slice(0, 120)}`);
  }
  return grillaDeAppsScript(JSON.parse(texto));
}

// ---------------------------------------------------------------- notas
// La planilla solo aporta la parte "fac:…" de notes; el CRM le agrega cosas
// propias ("Doctor sin matchear: …") que este sync no debe pisar.
export const facDe = (n: string | null) => n?.match(/fac:\s*([^\s·]+)/i)?.[1] ?? null;

export function mergeNotes(deDb: string | null, facFresco: string | null): string | null {
  const sinFac = (deDb ?? "").replace(/\s*·?\s*fac:[^\s·]+/i, "").trim() || null;
  if (!facFresco) return sinFac;
  return sinFac ? `${sinFac} · fac:${facFresco}` : `fac:${facFresco}`;
}

// ---------------------------------------------------------------- gates
type PagoDb = {
  id: string;
  external_key: string;
  amount_mxn: number;
  paid_at: string;
  method: string | null;
  notes: string | null;
  paciente: string | null;
};

/** Deriva tolerable: más que esto huele a filas corridas, no a correcciones. */
const DERIVA_MAX = 20;

/**
 * Los dos gates que traía el script, textuales. Tiran Error y la ruta lo
 * convierte en fila `error` en sync_runs + aviso a Slack: corriendo sola, la
 * única forma de que un aborto no sea silencio es que grite.
 */
export function revisarGates(
  existentes: PagoDb[],
  frescos: PagoPlanilla[],
  hoyISO: string,
  log: (s: string) => void
): void {
  const porKey = new Map(frescos.map((p) => [p.external_key, p]));

  // GATE 1: deriva de filas
  const desaparecidos = existentes.filter((p) => !porKey.has(p.external_key));
  const cambiadosMonto = existentes.filter((p) => {
    const f = porKey.get(p.external_key);
    return f && Math.abs(Number(p.amount_mxn) - f.amount_mxn) > 0.01;
  });
  const deriva = desaparecidos.length + cambiadosMonto.length;
  if (deriva) {
    log(
      `deriva: ${desaparecidos.length} pagos ya no están en la planilla, ${cambiadosMonto.length} cambiaron de monto`
    );
    for (const p of [...desaparecidos, ...cambiadosMonto].slice(0, 10)) {
      const f = porKey.get(p.external_key);
      log(`   ${p.external_key} ${p.paid_at} $${p.amount_mxn}${f ? ` → $${f.amount_mxn}` : " (desapareció)"}`);
    }
    if (deriva > DERIVA_MAX) {
      throw new Error(
        `deriva de ${deriva} pagos — parece corrimiento de filas en la planilla, no correcciones. ABORTO sin escribir.`
      );
    }
  }

  // GATE 2: un mes cerrado no se achica
  const mesActual = hoyISO.slice(0, 7);
  const porMes = (xs: { paid_at: string; amount_mxn: number }[]) => {
    const m = new Map<string, number>();
    for (const p of xs) {
      if (p.paid_at < "2026-01-01") continue;
      const k = p.paid_at.slice(0, 7);
      m.set(k, (m.get(k) ?? 0) + Number(p.amount_mxn));
    }
    return m;
  };
  const antes = porMes(existentes);
  const despues = porMes(frescos);
  for (const [mes, total] of [...antes].sort()) {
    if (mes >= mesActual) continue;
    const nuevo = despues.get(mes) ?? 0;
    if (nuevo < total - 0.01) {
      throw new Error(
        `mes cerrado ${mes} se achica: ${total.toFixed(2)} → ${nuevo.toFixed(2)}. ABORTO sin escribir.`
      );
    }
  }
}

// ---------------------------------------------------------------- sync
export type ResultadoSync = {
  planilla: number;
  crm: number;
  nuevos: number;
  editados: number;
  sinFecha: number;
};

export async function sincronizarPagos(
  db: SupabaseClient,
  frescos: PagoPlanilla[],
  sinFecha: number,
  hoyISO: string,
  log: (s: string) => void
): Promise<ResultadoSync> {
  // payments ya pasó las 1.000 filas: sin paginar, el sync creería que los
  // pagos viejos no existen y los duplicaría.
  const existentes = await traerTodo<PagoDb>(
    db,
    "payments",
    "id, external_key, amount_mxn, paid_at, method, notes, paciente"
  );
  const exByKey = new Map(existentes.map((p) => [p.external_key, p]));

  revisarGates(existentes, frescos, hoyISO, log);

  const nuevos = frescos.filter((p) => !exByKey.has(p.external_key));
  const editados = frescos.filter((p) => {
    const e = exByKey.get(p.external_key);
    return (
      !!e &&
      (Math.abs(Number(e.amount_mxn) - p.amount_mxn) > 0.01 ||
        e.paid_at !== p.paid_at ||
        (e.method ?? null) !== p.method ||
        facDe(e.notes) !== facDe(p.notes) ||
        (e.paciente ?? null) !== p.paciente)
    );
  });
  log(
    `Planilla: ${frescos.length} pagos · CRM: ${existentes.length} · nuevos: ${nuevos.length} · editados: ${editados.length}`
  );

  if (nuevos.length) {
    const filas = nuevos.map((p) => ({
      external_key: p.external_key,
      paciente: p.paciente,
      amount_mxn: p.amount_mxn,
      paid_at: p.paid_at,
      method: p.method,
      notes: p.notes,
      source: "import",
      is_demo: false,
    }));
    for (let i = 0; i < filas.length; i += 500) {
      const { error } = await db.from("payments").insert(filas.slice(i, i + 500));
      if (error) throw new Error(`alta de pagos: ${error.message}`);
    }
  }

  // Los pagos nuevos entran sin doctor (doctor_id null): el vínculo lo hace
  // reconcile-ledger. Nunca se tocan doctor_id/case_id de filas existentes.
  for (const p of editados) {
    const e = exByKey.get(p.external_key)!;
    const { error } = await db
      .from("payments")
      .update({
        amount_mxn: p.amount_mxn,
        paid_at: p.paid_at,
        method: p.method,
        notes: mergeNotes(e.notes, facDe(p.notes)),
        paciente: p.paciente,
      })
      .eq("external_key", p.external_key);
    if (error) throw new Error(`edición ${p.external_key}: ${error.message}`);
  }

  return {
    planilla: frescos.length,
    crm: existentes.length,
    nuevos: nuevos.length,
    editados: editados.length,
    sinFecha,
  };
}

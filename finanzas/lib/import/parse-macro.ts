// Parser del extracto de Banco Macro tal como vive en las hojas Banco_* de
// 2026_Consultorio.xlsx. Realidad verificada de esos archivos:
//   - el header está en la FILA 2 (índice 1), no en la 1
//   - las columnas CAMBIAN entre meses (MAR26 tiene FACTURADOR; ABR/MAY no)
//   - en MAY26 hay filas CORRIDAS una columna respecto del header
// Por eso: mapeo por NOMBRE de header + validación de tipos por fila, probando
// offsets ±1 cuando la fila no valida.

import { norm, parseAmount, parseDateDDMM } from "./normalize";

export type MacroLine = {
  lineNo: number;
  fecha: string;            // YYYY-MM-DD
  amount: number;           // firmado: crédito +, débito −
  currency: "ARS" | "USD";  // USD cuando la fila es de la cuenta "BBVA USD"
  banco: string | null;     // columna BANCO cruda ("MACRO $", "BBVA USD", ...)
  descripcion: string;
  contraparte: string | null;
  nroFactura: string | null;
  raw: Record<string, string | null>;
};

export type MacroParseResult = {
  lines: MacroLine[];
  skipped: Array<{ lineNo: number; reason: string; raw: (string | null)[] }>;
  /** Total de control que la hoja trae ANTES del header (suma ARS esperada).
   *  El importador DEBE cotejar la suma parseada contra esto y abortar si difiere. */
  controlTotal: number | null;
};

const HEADER_HINTS = ["fecha", "importe", "paciente", "detalle", "credito", "banco"];

function findHeaderRow(rows: (string | null)[][]): number {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const cells = rows[i].map((c) => norm(c));
    const hits = HEADER_HINTS.filter((h) => cells.some((c) => c.includes(h))).length;
    if (hits >= 3) return i;
  }
  return -1;
}

function idx(header: string[], ...names: string[]): number {
  for (const n of names) {
    const i = header.findIndex((h) => h === n || h.startsWith(n));
    if (i >= 0) return i;
  }
  return -1;
}

/** Lee una fila con un corrimiento dado y devuelve los campos tipados, o null si no valida. */
type Cols = {
  fecha: number; importe: number; credito: number; debito: number;
  paciente: number; detalle: number; fc: number; banco: number; totalUsd: number;
};

function readRow(
  row: (string | null)[],
  offset: number,
  col: Cols
): { fecha: string; amount: number; currency: "ARS" | "USD"; banco: string | null; contraparte: string | null; descripcion: string; fc: string | null } | null {
  const at = (i: number) => (i >= 0 && i + offset >= 0 ? row[i + offset] ?? null : null);
  const fecha = parseDateDDMM(at(col.fecha));
  if (!fecha) return null;

  const banco = (at(col.banco) ?? "")?.toString().trim() || null;

  // IMPORTE tiene precedencia: en las hojas reales las columnas de la cola
  // (Credito/Débito) vienen corridas y traen CUITs/texto — parseAmount ahora
  // los rechaza, pero el orden importa igual para extractos crudos futuros.
  let amount: number | null = null;
  let currency: "ARS" | "USD" = "ARS";
  const imp = parseAmount(at(col.importe));
  if (imp != null && imp !== 0) amount = imp;
  if (amount == null && (col.credito >= 0 || col.debito >= 0)) {
    const cr = parseAmount(at(col.credito));
    const db = parseAmount(at(col.debito));
    if (cr != null && cr !== 0) amount = Math.abs(cr);
    else if (db != null && db !== 0) amount = -Math.abs(db);
  }
  // filas de la cuenta en dólares: el monto vive en "TOTAL FACTURA USD"
  if (amount == null && banco && /usd|u\$s/i.test(banco)) {
    const usd = parseAmount(at(col.totalUsd));
    if (usd != null && usd !== 0) {
      amount = usd;
      currency = "USD";
    }
  }
  if (amount == null) return null;

  // La celda "NRO DE FC" a veces trae el CONCEPTO ("CONSULTORIO CONSULTA") en
  // vez de una factura; solo lo tomamos como factura si parece una.
  const fcRaw = (at(col.fc) ?? "")?.toString().trim() || null;
  const esFactura = fcRaw ? /\d{3,}-\d+|^[A-Z]\s*-\s*\d/.test(fcRaw) : false;
  let descripcion = (at(col.detalle) ?? "")?.toString().trim() || "";
  // DETALLE con solo dígitos = dato corrido de otra columna (Codigo/Documento),
  // no una descripción; queda en raw y se prefiere el concepto de "NRO DE FC".
  if (/^\d+$/.test(descripcion)) descripcion = "";
  if (!descripcion && fcRaw && !esFactura) descripcion = fcRaw;

  return {
    fecha,
    amount,
    currency,
    banco,
    contraparte: (at(col.paciente) ?? "")?.toString().trim() || null,
    descripcion,
    fc: esFactura ? fcRaw : null,
  };
}

export function parseMacroSheet(rows: (string | null)[][]): MacroParseResult {
  const result: MacroParseResult = { lines: [], skipped: [], controlTotal: null };
  const hi = findHeaderRow(rows);
  if (hi < 0) {
    result.skipped.push({ lineNo: 0, reason: "no se encontró el header", raw: rows[0] ?? [] });
    return result;
  }
  // la(s) fila(s) antes del header traen el total de control de la hoja
  for (let r = 0; r < hi; r++) {
    for (const cell of rows[r] ?? []) {
      const n = parseAmount(cell);
      if (n != null && n > 1000 && (result.controlTotal == null || n > result.controlTotal)) {
        result.controlTotal = n;
      }
    }
  }
  const header = rows[hi].map((c) => norm(c));
  const col: Cols = {
    fecha: idx(header, "fecha"),
    importe: idx(header, "importe"),
    credito: idx(header, "credito"),
    debito: idx(header, "debito"),
    paciente: idx(header, "paciente"),
    detalle: idx(header, "detalle"),
    fc: idx(header, "nro de fc", "nro fc", "factura"),
    banco: idx(header, "banco"),
    totalUsd: idx(header, "total factura usd"),
  };

  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => c == null || String(c).trim() === "")) continue;
    // offset 0 primero; si la fila no valida (fecha o monto ilegibles), probar ±1
    let parsed = readRow(row, 0, col);
    let usedOffset = 0;
    if (!parsed) {
      for (const off of [1, -1]) {
        parsed = readRow(row, off, col);
        if (parsed) { usedOffset = off; break; }
      }
    }
    if (!parsed) {
      result.skipped.push({ lineNo: r + 1, reason: "fila no valida (fecha/monto)", raw: row });
      continue;
    }
    const raw: Record<string, string | null> = {};
    rows[hi].forEach((h, i) => { if (h) raw[String(h)] = row[i] ?? null; });
    if (usedOffset !== 0) raw._offset = String(usedOffset);
    result.lines.push({
      lineNo: r + 1,
      fecha: parsed.fecha,
      amount: parsed.amount,
      currency: parsed.currency,
      banco: parsed.banco,
      descripcion: parsed.descripcion,
      contraparte: parsed.contraparte,
      nroFactura: parsed.fc,
      raw,
    });
  }
  return result;
}

// Parser del CSV que genera la API de reportes de Mercado Pago
// ("reporte de liberaciones": POST /v1/account/release_report).
// Columnas relevantes: DATE, SOURCE_ID, RECORD_TYPE, DESCRIPTION,
// NET_CREDIT_AMOUNT, NET_DEBIT_AMOUNT. Solo RECORD_TYPE=release es un
// movimiento; initial_available_balance y total son saldos de control.

export type MovimientoMpApi = {
  fecha: string;          // YYYY-MM-DD
  descripcion: string;
  source_id: string | null;
  monto: number;          // crédito positivo, débito negativo
};

export type ResultadoMpApi = {
  movimientos: MovimientoMpApi[];
  control: { inicial: number | null; final: number | null };
};

function splitLinea(linea: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "", enComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (enComillas) {
      if (c === '"' && linea[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') enComillas = false;
      else cur += c;
    } else if (c === '"') enComillas = true;
    else if (c === sep) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (s: string | undefined): number => {
  const v = Number((s ?? "").trim());
  return Number.isFinite(v) ? v : 0;
};

export function parseMpApiCsv(texto: string): ResultadoMpApi {
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lineas.length) return { movimientos: [], control: { inicial: null, final: null } };

  const header = lineas[0];
  const sep = (header.match(/;/g)?.length ?? 0) > (header.match(/,/g)?.length ?? 0) ? ";" : ",";
  const cols = splitLinea(header, sep).map((c) => c.trim().toUpperCase());
  const idx = (n: string) => cols.indexOf(n);
  const iFecha = idx("DATE"), iTipo = idx("RECORD_TYPE"), iDesc = idx("DESCRIPTION"),
    iSrc = idx("SOURCE_ID"), iCred = idx("NET_CREDIT_AMOUNT"), iDeb = idx("NET_DEBIT_AMOUNT");
  if (iFecha < 0) {
    throw new Error(`CSV sin columna DATE — ¿es un reporte de liberaciones? Header: ${header.slice(0, 200)}`);
  }
  if (iTipo < 0) {
    // Variante ARGENTINA: no trae RECORD_TYPE. El tipo viene en DESCRIPTION
    // ("payment", "asset_management") y las comisiones no son filas aparte sino
    // columnas de la misma fila (GROSS − MP_FEE − TAXES = NET). Las filas de
    // control son las que no tienen ni SOURCE_ID ni DESCRIPTION: la primera es
    // el saldo inicial y la última el final. Verificado contra el reporte real
    // de la cuenta del consultorio el 27/8/26.
    return parseSinRecordType(lineas, sep, { iFecha, iDesc, iSrc, iCred, iDeb, iSaldo: idx("BALANCE_AMOUNT"), iMedio: idx("PAYMENT_METHOD") });
  }

  const movimientos: MovimientoMpApi[] = [];
  let inicial: number | null = null, final: number | null = null;
  for (const linea of lineas.slice(1)) {
    const f = splitLinea(linea, sep);
    const tipo = (f[iTipo] ?? "").trim().toLowerCase();
    const cred = num(f[iCred]), deb = num(f[iDeb]);
    if (tipo === "initial_available_balance") { inicial = cred - deb; continue; }
    if (tipo === "total") { final = cred - deb; continue; }
    if (tipo !== "release") continue;
    const fecha = (f[iFecha] ?? "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    movimientos.push({
      fecha,
      descripcion: (f[iDesc] ?? "").trim() || "(sin descripción)",
      source_id: (f[iSrc] ?? "").trim() || null,
      monto: cred > 0 ? cred : -deb,
    });
  }
  return { movimientos, control: { inicial, final } };
}

type Columnas = {
  iFecha: number; iDesc: number; iSrc: number;
  iCred: number; iDeb: number; iSaldo: number; iMedio: number;
};

/** El reporte de Argentina, que no tiene RECORD_TYPE (ver parseMpApiCsv). */
function parseSinRecordType(lineas: string[], sep: string, c: Columnas): ResultadoMpApi {
  const movimientos: MovimientoMpApi[] = [];
  let inicial: number | null = null, final: number | null = null;

  for (const linea of lineas.slice(1)) {
    const f = splitLinea(linea, sep);
    const src = (f[c.iSrc] ?? "").trim();
    const desc = (f[c.iDesc] ?? "").trim();
    const cred = num(f[c.iCred]), deb = num(f[c.iDeb]);

    // Fila de control: sin operación ni concepto. La primera es la apertura y
    // la última el cierre.
    //
    // El saldo va en NET_CREDIT/NET_DEBIT, NO en BALANCE_AMOUNT: la fila de
    // cierre del reporte real trae BALANCE_AMOUNT en 0,00 y el saldo verdadero
    // en el crédito. Leer la columna equivocada dejaba registrado "saldo final
    // 0" para una cuenta con 17 millones adentro.
    if (!src && !desc) {
      const vacia = (f[c.iCred] ?? "").trim() === "" && (f[c.iDeb] ?? "").trim() === "";
      if (!vacia) {
        const saldo = Math.round((cred - deb) * 100) / 100;
        if (inicial === null) inicial = saldo;
        final = saldo;
      }
      continue;
    }

    const fecha = (f[c.iFecha] ?? "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    // el medio de pago entra en la descripción: es lo único que distingue dos
    // cobros del mismo día y monto a la hora de conciliar
    const medio = c.iMedio >= 0 ? (f[c.iMedio] ?? "").trim() : "";
    movimientos.push({
      fecha,
      descripcion: [desc, medio].filter(Boolean).join(" · ") || "(sin descripción)",
      source_id: src || null,
      monto: Math.round((cred - deb) * 100) / 100,
    });
    // el saldo corriente de la última fila con movimiento también sirve de cierre
    if (c.iSaldo >= 0 && (f[c.iSaldo] ?? "").trim() !== "") final = num(f[c.iSaldo]);
  }
  return { movimientos, control: { inicial, final } };
}

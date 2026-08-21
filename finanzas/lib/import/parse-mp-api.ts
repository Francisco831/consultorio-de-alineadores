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
  if (iFecha < 0 || iTipo < 0) {
    throw new Error(`CSV sin columnas DATE/RECORD_TYPE — ¿es un reporte de liberaciones? Header: ${header.slice(0, 120)}`);
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

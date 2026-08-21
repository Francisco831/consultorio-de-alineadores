// Control "SOLICITUD FACTURAS Y CONSULTAS" vs caja: la hoja donde Claudia
// anota qué facturar es un segundo registro de los cobros — todo lo que está
// ahí con monto debería tener su fila en la caja de la doctora. Lo que no
// aparece es plata posiblemente no anotada (hallazgo 21/8: ~$1M en 10 filas).
import { nameScore, similarity, tokens } from "../conciliacion/matcher";

/** tokens ordenados — la similitud del nombre entero salva typos que tokEq no. */
function claveLaxa(s: string): string {
  return [...tokens(s)].sort().join(" ");
}

function parecido(a: string, b: string): number {
  return Math.max(nameScore(a, b), similarity(claveLaxa(a), claveLaxa(b)));
}

export type FilaSolicitud = { fecha: string; monto: number; textos: string[] };
export type MovNombre = { occurred_on: string; nombre: string };

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DOCTORAS = new Set([
  "monica gonzalez", "mónica gonzález", "mariana matelli", "mariana franco",
  "eugenia di giano", "rocio puig", "rocío puig", "virginia", "virginia heredia",
]);
const ROTULO = /basilico|lavalle|identif|falta comprobante|hacer factura|no hacer|resp inscripto|osde|galicia|santander|patagonia|comprobante|t\/c|contenci|consulta|cuota|abona|retira|placa|dni|cuit|^tr |^mp |^ef\b|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|chequear|difiere|carpeta|descargado|ex paciente|mercado pago|transferencia|billetera|deposito|depósito/i;

/** Filas 2026 con monto de la grilla cruda del GAS (o del xlsx convertido). */
export function extraerFilasSolicitud(rows: (string | number | null)[][]): FilaSolicitud[] {
  const out: FilaSolicitud[] = [];
  for (const r of rows) {
    const fecha = r.find((c): c is string => typeof c === "string" && RE_FECHA.test(c) && c.startsWith("2026"));
    const montos = r.filter((c): c is number => typeof c === "number" && c >= 20_000 && c <= 20_000_000);
    const textos = r.filter((c): c is string => typeof c === "string" && !RE_FECHA.test(c)).map((t) => t.trim());
    if (fecha && montos.length) out.push({ fecha, monto: Math.max(...montos), textos });
  }
  return out;
}

function candidatos(f: FilaSolicitud): string[] {
  return f.textos
    .map((t) => t.replace(/\d+/g, "").trim())
    .filter((t) => t.length > 5 && !DOCTORAS.has(t.toLowerCase()) && !ROTULO.test(t) && /^[a-záéíóúüñ' .-]+$/i.test(t));
}

function dias(a: string, b: string): number {
  return Math.abs((+new Date(a) - +new Date(b)) / 86400000);
}

/** Filas de SOLICITUD sin rastro en la caja (ningún nombre matchea ese día ±5). */
export function faltantesSolicitud(filas: FilaSolicitud[], movs: MovNombre[]) {
  const faltan: (FilaSolicitud & { nombres: string[] })[] = [];
  let cruzadas = 0;
  for (const f of filas) {
    const nombres = candidatos(f);
    if (!nombres.length) continue;
    cruzadas++;
    const cerca = movs.filter((m) => dias(m.occurred_on, f.fecha) <= 5);
    const hay = nombres.some((n) => cerca.some((m) => parecido(n, m.nombre) >= 0.6));
    if (!hay) faltan.push({ ...f, nombres });
  }
  return { cruzadas, faltan };
}

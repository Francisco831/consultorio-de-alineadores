// Resumen del mes POR PAÍS desde Noloco keepsmiling-v2, para el panel personal
// (lo pidió Rocío 22/8: casos movidos / modificaciones / comunicaciones por país).
// Reusa lo probado en panel-ortodoncistas/fetch_datos.py: totalCount por país para
// movimientos (sin paginar) + una pasada por keepsmilingComunicacionCollection del
// mes (≈400 filas) agrupando motivo × país del caso.
//
// El CRM espeja solo MEXICO; esto NO importa nada a la base: es un vistazo de
// solo lectura con cache en memoria de 1 h (por instancia — en serverless un cold
// start lo repaga, ~3-5 s, aceptable para un bloque secundario). Sin credenciales
// o con Noloco caído devuelve null y el panel lo omite.

import { monthStartMX } from "@/lib/dates";

const API = "https://api.portals.noloco.io/data/keepsmiling-v2";

// países con operación conocida; lo que no matchee suma a "Otros"
const PAISES = [
  "ARGENTINA",
  "MEXICO",
  "PERU",
  "CHILE",
  "URUGUAY",
  "PARAGUAY",
] as const;

export const PAIS_LABEL: Record<string, string> = {
  ARGENTINA: "Argentina",
  MEXICO: "México",
  PERU: "Perú",
  CHILE: "Chile",
  URUGUAY: "Uruguay",
  PARAGUAY: "Paraguay",
  OTROS: "Otros",
};

export interface FilaPais {
  pais: string;
  movidos: number;
  modificaciones: number;
  comunicaciones: number;
}

export interface ResumenPaises {
  filas: FilaPais[];
  generado: string; // ISO
}

async function gql(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuesta GraphQL sin tipar, cada caller castea lo suyo
): Promise<any> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-noloco-project": "keepsmiling-v2",
      "x-noloco-ghost": "false",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
    // POST: Next no lo cachea; el cache es el memo de módulo de abajo
    cache: "no-store",
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors).slice(0, 300));
  return data.data;
}

async function login(email: string, password: string): Promise<string> {
  const d = await gql(
    "mutation Login($e: String!, $p: String!) { login(email: $e, password: $p) { token } }",
    { e: email, p: password }
  );
  return d.login.token;
}

let memo: { ts: number; data: ResumenPaises } | null = null;

export async function resumenPorPais(): Promise<ResumenPaises | null> {
  if (memo && Date.now() - memo.ts < 3_600_000) return memo.data;

  const email = process.env.KEEPSMILING_EMAIL;
  const password = process.env.KEEPSMILING_PASSWORD;
  if (!email || !password) return null;

  try {
    const token = await login(email, password);
    // inicio de mes en México (-06): las fechas de Noloco vienen en UTC
    const desde = `${monthStartMX()}T06:00:00Z`;

    // movidos: un totalCount por país + el total global para calcular "Otros"
    const countMovidos = async (pais?: string) => {
      const wherePais = pais ? `pais: {equals: "${pais}"}, ` : "";
      const d = await gql(
        `{ keepsmilingCasosCollection(first: 1, where: {${wherePais}fechaMovimientos: {gte: "${desde}"}}) { totalCount } }`,
        {},
        token
      );
      return d.keepsmilingCasosCollection.totalCount as number;
    };

    const [totalMovidos, ...movidosPorPais] = await Promise.all([
      countMovidos(),
      ...PAISES.map((p) => countMovidos(p)),
    ]);

    // comunicaciones del mes (paginado; ~2-3 páginas): motivo × país del caso
    type Com = { motivo: string | null; casos: { pais: string | null } | null };
    const coms: Com[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const after = cursor ? `, after: "${cursor}"` : "";
      const d = await gql(
        `{ keepsmilingComunicacionCollection(first: 200, where: {createdAt: {gte: "${desde}"}}${after}) {
            edges { node { motivo casos { pais } } }
            pageInfo { hasNextPage endCursor }
          } }`,
        {},
        token
      );
      const c = d.keepsmilingComunicacionCollection;
      coms.push(...c.edges.map((e: { node: Com }) => e.node));
      if (!c.pageInfo.hasNextPage) break;
      cursor = c.pageInfo.endCursor;
    }

    const fila = new Map<string, FilaPais>();
    const de = (pais: string) => {
      if (!fila.has(pais))
        fila.set(pais, { pais, movidos: 0, modificaciones: 0, comunicaciones: 0 });
      return fila.get(pais)!;
    };
    PAISES.forEach((p, i) => (de(p).movidos = movidosPorPais[i]));
    const restoMovidos = totalMovidos - movidosPorPais.reduce((a, b) => a + b, 0);
    if (restoMovidos > 0) de("OTROS").movidos = restoMovidos;

    for (const c of coms) {
      const pais = c.casos?.pais?.toUpperCase() ?? "OTROS";
      const f = de((PAISES as readonly string[]).includes(pais) ? pais : "OTROS");
      f.comunicaciones++;
      if (c.motivo === "MODIFICACIONES_DE_VIDEO_YO_RENDERS") f.modificaciones++;
    }

    const filas = [...fila.values()]
      .filter((f) => f.movidos || f.modificaciones || f.comunicaciones)
      .sort((a, b) => b.movidos - a.movidos || b.comunicaciones - a.comunicaciones);

    memo = { ts: Date.now(), data: { filas, generado: new Date().toISOString() } };
    return memo.data;
  } catch {
    // Noloco caído o credenciales mal: se devuelve lo último bueno si existe
    return memo?.data ?? null;
  }
}

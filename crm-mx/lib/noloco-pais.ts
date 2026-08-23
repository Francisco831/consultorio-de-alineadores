// Resumen del mes POR PAÍS **de una persona** desde Noloco keepsmiling-v2.
// Pancho (22/8): "tienen que ser los de ella, no los generales" — la tabla del
// panel muestra lo que ESA persona movió/atendió, no el total de la empresa.
//
// Cómo se define "suyo" en el esquema v2 (verificado en vivo 22/8):
//   · casos movidos  → keepsmilingCasos con fechaMovimientos del mes y la
//     persona como asesorComercialId o asesorAtencionId (Juan: 29 en agosto)
//   · comunicaciones → keepsmilingComunicacion del mes con userKsId o
//     userAtencionId = la persona; traen `pais` directo (Rocío: 32+8 en agosto)
//   · modificaciones → las mismas comunicaciones con motivo
//     MODIFICACIONES_DE_VIDEO_YO_RENDERS
// Los filtros de relación anidados ({is:{...}}) tiran INTERNAL error en este
// portal; los campos planos `...Id` andan — usar SIEMPRE esos.
//
// Volumen por persona/mes ≈ decenas: se traen las filas (1-2 páginas) y se
// agrupa acá. Cache 1 h por usuario, en memoria de la instancia. Sin
// credenciales o con Noloco caído → null y el panel omite el bloque.

const API = "https://api.portals.noloco.io/data/keepsmiling-v2";

// CRM profile (por primer nombre normalizado) → id de keepsmilingUser en v2.
// El matcheo por nombre no alcanza: hay 3 "Juan" y 2 "Rocio" en la colección.
// Verificado 22/8: Rocio Puig=121 · Juan Banffi=12 · Francisco Basilico=182.
const V2_USER_POR_NOMBRE: Record<string, number> = {
  rocio: 121,
  juan: 12,
  pancho: 182,
};

export function v2UserIdDe(nombrePerfil: string): number | null {
  const primero = nombrePerfil
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .split(/\s+/)[0];
  return V2_USER_POR_NOMBRE[primero] ?? null;
}

export const PAIS_LABEL: Record<string, string> = {
  ARGENTINA: "Argentina",
  MEXICO: "México",
  PERU: "Perú",
  CHILE: "Chile",
  URUGUAY: "Uruguay",
  PARAGUAY: "Paraguay",
  SIN_PAIS: "Sin país",
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

/** Trae todas las páginas de una colección para un where dado (tope 10 páginas). */
async function filas(
  token: string,
  coleccion: string,
  where: string,
  campos: string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const after = cursor ? `, after: "${cursor}"` : "";
    const d = await gql(
      `{ ${coleccion}(first: 200, where: ${where}${after}) {
          edges { node { ${campos} } }
          pageInfo { hasNextPage endCursor }
        } }`,
      {},
      token
    );
    const c = d[coleccion];
    out.push(...c.edges.map((e: { node: Record<string, unknown> }) => e.node));
    if (!c.pageInfo.hasNextPage) break;
    cursor = c.pageInfo.endCursor;
  }
  return out;
}

/** inicio de mes en México (-06): las fechas de Noloco vienen en UTC */
function inicioMesUTC(): string {
  const hoyMX = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
  }).format(new Date());
  return `${hoyMX.slice(0, 7)}-01T06:00:00Z`;
}

const memos = new Map<number, { ts: number; data: ResumenPaises }>();

export async function resumenPorPaisDe(
  v2UserId: number
): Promise<ResumenPaises | null> {
  const memo = memos.get(v2UserId);
  if (memo && Date.now() - memo.ts < 3_600_000) return memo.data;

  const email = process.env.KEEPSMILING_EMAIL;
  const password = process.env.KEEPSMILING_PASSWORD;
  if (!email || !password) return null;

  try {
    const token = await login(email, password);
    const desde = inicioMesUTC();

    // por cada métrica, la persona puede figurar en DOS campos: se piden ambos
    // y se deduplica por id (si está en los dos roles del mismo registro)
    const [casosCom, casosAte, comsKs, comsAte] = await Promise.all([
      filas(
        token,
        "keepsmilingCasosCollection",
        `{asesorComercialId: {equals: ${v2UserId}}, fechaMovimientos: {gte: "${desde}"}}`,
        "id pais"
      ),
      filas(
        token,
        "keepsmilingCasosCollection",
        `{asesorAtencionId: {equals: ${v2UserId}}, fechaMovimientos: {gte: "${desde}"}}`,
        "id pais"
      ),
      filas(
        token,
        "keepsmilingComunicacionCollection",
        `{userKsId: {equals: ${v2UserId}}, createdAt: {gte: "${desde}"}}`,
        "id motivo pais"
      ),
      filas(
        token,
        "keepsmilingComunicacionCollection",
        `{userAtencionId: {equals: ${v2UserId}}, createdAt: {gte: "${desde}"}}`,
        "id motivo pais"
      ),
    ]);

    const dedup = (grupos: Array<Array<Record<string, unknown>>>) => {
      const vistos = new Map<string, Record<string, unknown>>();
      for (const g of grupos)
        for (const r of g) vistos.set(String(r.id), r);
      return [...vistos.values()];
    };
    const casos = dedup([casosCom, casosAte]);
    const coms = dedup([comsKs, comsAte]);

    const fila = new Map<string, FilaPais>();
    const de = (paisCrudo: unknown) => {
      const pais =
        typeof paisCrudo === "string" && paisCrudo.trim()
          ? paisCrudo.trim().toUpperCase()
          : "SIN_PAIS";
      if (!fila.has(pais))
        fila.set(pais, { pais, movidos: 0, modificaciones: 0, comunicaciones: 0 });
      return fila.get(pais)!;
    };
    for (const c of casos) de(c.pais).movidos++;
    for (const c of coms) {
      const f = de(c.pais);
      f.comunicaciones++;
      if (c.motivo === "MODIFICACIONES_DE_VIDEO_YO_RENDERS") f.modificaciones++;
    }

    const listas = [...fila.values()].sort(
      (a, b) =>
        b.movidos - a.movidos || b.comunicaciones - a.comunicaciones
    );

    const data = { filas: listas, generado: new Date().toISOString() };
    memos.set(v2UserId, { ts: Date.now(), data });
    return data;
  } catch {
    // Noloco caído: se devuelve lo último bueno si existe
    return memo?.data ?? null;
  }
}

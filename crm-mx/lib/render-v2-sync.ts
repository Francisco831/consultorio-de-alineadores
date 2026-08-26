// Espejo del estado del render: keepsmiling-v2 → cases.video_* (migración 0045).
//
// POR QUÉ EXISTE. El CRM venía diciendo "render esperando aprobación" con
// `fecha_video is not null and fecha_aprobacion_video is null`, que es lo único
// que trae ks-indicadores. Cruzado a mano contra v2 el 26/8, de esos 98 casos
// sólo 62 esperaban de verdad: 34 ya habían sido RECHAZADOS (un rechazo deja la
// fecha de aprobación en NULL para siempre) y 2 ya habían avanzado de stage.
// La verdad está en v2: stage ATENCION + subStage PENDIENTE_APROBACION_RENDER es
// "la pelota la tiene el doctor"; stage RECHAZADO + fechaRechazado es "contestó
// que no". Ojo: 32 de los 72 rechazados MX conservan el subStage
// PENDIENTE_APROBACION_RENDER, así que el subStage suelto miente.
//
// Es el mismo portal y el mismo login que lib/alerta-rechazos.ts. Se trae el país
// entero (1.058 casos MX, 6 páginas) y no sólo ATENCION/RECHAZADO para que el
// espejo se cure solo: cuando un caso sale de ATENCION, la fila del CRM se
// actualiza en la misma corrida en vez de quedar marcada como pendiente para
// siempre.

import type { SupabaseClient } from "@supabase/supabase-js";

const API_V2 = "https://api.portals.noloco.io/data/keepsmiling-v2";
const PAIS = "MEXICO";
const PAGINA = 200;

/** stage + subStage que significan "el render espera respuesta del doctor". */
export const V2_STAGE_ESPERANDO = "ATENCION";
export const V2_SUB_STAGE_ESPERANDO = "PENDIENTE_APROBACION_RENDER";
export const V2_STAGE_RECHAZADO = "RECHAZADO";

// Cuántos id_externo entran en un `.in(...)`: PostgREST manda el filtro en la
// query string, así que 1.000 códigos serían una URL de ~7 KB. 200 es el mismo
// tamaño de página que usa el resto del repo y deja la URL en ~1,5 KB.
const IDS_POR_UPDATE = 200;

interface CasoV2 {
  idExterno: string | null;
  stage: string | null;
  subStage: string | null;
  videoEstado: string | null;
  fechaRechazado: string | null;
}

interface FilaCrm {
  id_externo: string;
  video_stage: string | null;
  video_sub_stage: string | null;
  video_estado: string | null;
  fecha_rechazado: string | null;
}

export interface ResumenRenderV2 {
  /** casos MX leídos del portal v2 */
  leidos: number;
  /** filas de cases escritas (sólo las que cambiaron) */
  actualizados: number;
  /** casos esperando aprobación del doctor, según v2 */
  esperando: number;
  /** casos rechazados por el doctor, según v2 */
  rechazados: number;
  /** idExterno que v2 tiene y el CRM no importó nunca */
  sin_match: number;
}

async function gqlV2<T>(
  query: string,
  token?: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(API_V2, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-noloco-project": "keepsmiling-v2",
      "x-noloco-ghost": "false",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Noloco v2: ${JSON.stringify(data.errors).slice(0, 400)}`);
  return data.data as T;
}

interface PaginaCasos {
  keepsmilingCasosCollection: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: CasoV2 }[];
  };
}

/** Los id_externo vienen de dos sistemas distintos: se comparan normalizados. */
function clave(id: string | null | undefined): string | null {
  const k = (id ?? "").trim().toUpperCase();
  return k === "" ? null : k;
}

/** Dos timestamps son "el mismo" si apuntan al mismo instante, escritos como sea. */
function mismoInstante(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

export async function sincronizarRenderV2(
  db: SupabaseClient,
  email: string,
  password: string,
  log: (s: string) => void = () => {}
): Promise<ResumenRenderV2> {
  const login = await gqlV2<{ login: { token: string } }>(
    "mutation l($e:String!,$p:String!){ login(email:$e, password:$p){ token } }",
    undefined,
    { e: email, p: password }
  );
  const token = login.login.token;

  // ---------- 1. traer los casos del país desde v2 ----------
  const casos: CasoV2[] = [];
  let after: string | null = null;
  for (;;) {
    // La anotación explícita no es de adorno: sin ella TS ve un ciclo entre
    // `after` y el resultado de la página (TS7022) y tipa todo como any.
    const d: PaginaCasos = await gqlV2<PaginaCasos>(
      `query c($after: String) {
        keepsmilingCasosCollection(first: ${PAGINA}, after: $after,
          where: { pais: {equals: "${PAIS}"} }) {
          pageInfo { hasNextPage endCursor }
          edges { node { idExterno stage subStage videoEstado fechaRechazado } }
        }
      }`,
      token,
      { after }
    );
    const c = d.keepsmilingCasosCollection;
    casos.push(...c.edges.map((e) => e.node));
    if (!c.pageInfo.hasNextPage) break;
    after = c.pageInfo.endCursor;
  }
  log(`v2: ${casos.length} casos ${PAIS}`);

  const porClave = new Map<string, CasoV2>();
  for (const c of casos) {
    const k = clave(c.idExterno);
    if (k) porClave.set(k, c);
  }

  const esperando = casos.filter(
    (c) => c.stage === V2_STAGE_ESPERANDO && c.subStage === V2_SUB_STAGE_ESPERANDO
  ).length;
  const rechazados = casos.filter((c) => c.stage === V2_STAGE_RECHAZADO).length;
  log(`v2: ${esperando} esperando aprobación, ${rechazados} rechazados`);

  // ---------- 2. lo que hoy tiene el CRM ----------
  const filas: FilaCrm[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db
      .from("cases")
      .select("id_externo, video_stage, video_sub_stage, video_estado, fecha_rechazado")
      .not("id_externo", "is", null)
      .range(desde, desde + 999);
    if (error) throw new Error(`leer cases: ${error.message}`);
    filas.push(...((data ?? []) as FilaCrm[]));
    if ((data?.length ?? 0) < 1000) break;
  }

  // ---------- 3. qué cambió ----------
  // Sólo se escriben las filas que cambiaron. No es una optimización de lujo:
  // `cases` tiene el trigger cases_recompute_trg (0005), que recalcula la doctora
  // entera en CADA update. Tocar las 1.051 filas cada 2 horas serían 1.051
  // recálculos para nada; en régimen cambian unas pocas por corrida.
  const enCrm = new Set<string>();
  const grupos = new Map<string, { valores: CasoV2; ids: string[] }>();
  for (const f of filas) {
    const k = clave(f.id_externo);
    if (!k) continue;
    enCrm.add(k);
    const v2 = porClave.get(k);
    if (!v2) continue; // caso del CRM que v2 no tiene como MX: se deja como está
    const igual =
      f.video_stage === v2.stage &&
      f.video_sub_stage === v2.subStage &&
      f.video_estado === v2.videoEstado &&
      mismoInstante(f.fecha_rechazado, v2.fechaRechazado);
    if (igual) continue;
    // Un update por combinación de valores, no uno por caso: los 1.058 casos MX
    // se reparten en un puñado de combinaciones stage/subStage/videoEstado (los
    // rechazados sí caen de a uno, porque fechaRechazado es distinta en cada uno).
    const gk = JSON.stringify([v2.stage, v2.subStage, v2.videoEstado, v2.fechaRechazado]);
    const g = grupos.get(gk) ?? { valores: v2, ids: [] };
    g.ids.push(f.id_externo);
    grupos.set(gk, g);
  }

  const sin_match = [...porClave.keys()].filter((k) => !enCrm.has(k)).length;

  // ---------- 4. escribir ----------
  const ahora = new Date().toISOString();
  let actualizados = 0;
  for (const { valores, ids } of grupos.values()) {
    for (let i = 0; i < ids.length; i += IDS_POR_UPDATE) {
      const lote = ids.slice(i, i + IDS_POR_UPDATE);
      const { data, error } = await db
        .from("cases")
        .update({
          video_stage: valores.stage,
          video_sub_stage: valores.subStage,
          video_estado: valores.videoEstado,
          fecha_rechazado: valores.fechaRechazado,
          video_v2_synced_at: ahora,
        })
        .in("id_externo", lote)
        .select("id");
      if (error) throw new Error(`update cases: ${error.message}`);
      actualizados += data?.length ?? 0;
    }
  }
  log(
    `CRM: ${actualizados} casos actualizados en ${grupos.size} grupos` +
      (sin_match ? `, ${sin_match} idExterno de v2 sin caso en el CRM` : "")
  );

  return { leidos: casos.length, actualizados, esperando, rechazados, sin_match };
}

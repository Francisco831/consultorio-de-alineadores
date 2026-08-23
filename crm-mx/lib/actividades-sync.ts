// Sync de actividad comercial MX → tabla activities. Dos fuentes automatizables:
//
//   · contact points del intranet (api-colombia getContactPoint, eventos 1-a-1
//     de los asesores) — POR USUARIO: cada cuenta ve solo sus eventos y se
//     atribuye a quien se loguea (INTRANET_EMAIL/_PASSWORD, y _2, _3… en la ruta)
//   · pedidos de modificación de casos MX (Noloco keepsmiling-v2,
//     keepsmilingComunicacion) — credenciales KEEPSMILING_EMAIL/PASSWORD
//
// La consumen scripts/import-actividades-mx.ts (manual) y /api/sync/actividades
// (cron diario). Idempotente: dedup por (doctor, día, resumen). El matching de
// doctores NUNCA adivina: exacto > ficha con noloco_id > se reporta ambiguo.
// Las llamadas de Rocío (sheet) y las oportunidades de la planilla NO están acá:
// esas fuentes no tienen API y siguen siendo import manual del script.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/scripts/lib/fetch-all";

// ---------- matching de nombres ----------
export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-zñ0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(s: string): Set<string> {
  const STOP = new Set(["dr", "dra", "doctor", "doctora", "de", "del", "la", "los"]);
  return new Set(norm(s).split(" ").filter((t) => t.length > 1 && !STOP.has(t)));
}

export type Doc = { id: string; nombre: string; noloco_id: string | null };

// Typos conocidos de las fuentes → nombre como figura en el CRM
const ALIAS_FUENTE: Record<string, string> = {
  "castejon gomez ervin": "Castrejón Gómez Ervin",
  "correira figueira jose luis": "Correia Figueira Jose Luis",
  "cautetpozo luis alberto": "Cuatepotzo Olvera Luis Alberto",
  "lucia dosal gutierrez": "Dosal Guitiérrez Lucía del Carmen",
};

function desempatar(nombreFuente: string, hits: Doc[]): Doc[] {
  if (hits.length <= 1) return hits;
  const objetivo = norm(nombreFuente.replace(",", " "));
  const exactos = hits.filter((d) => norm(d.nombre) === objetivo);
  const pool = exactos.length >= 1 ? exactos : hits;
  if (pool.length === 1) return pool;
  const conNoloco = pool.filter((d) => d.noloco_id);
  return conNoloco.length === 1 ? conNoloco : pool;
}

export function matchDoctor(nombreFuente: string, doctors: Doc[]): Doc[] {
  const alias = ALIAS_FUENTE[norm(nombreFuente.replace(",", " "))];
  if (alias) nombreFuente = alias;
  const src = tokens(nombreFuente.replace(",", " "));
  if (src.size === 0) return [];
  const hits = doctors.filter((d) => {
    const dst = tokens(d.nombre);
    for (const t of src) if (!dst.has(t)) return false;
    return true;
  });
  if (hits.length > 0) return desempatar(nombreFuente, hits);
  return desempatar(
    nombreFuente,
    doctors.filter((d) => {
      const dst = tokens(d.nombre);
      if (dst.size === 0) return false;
      for (const t of dst) if (!src.has(t)) return false;
      return true;
    })
  );
}

// ---------- utilidades compartidas ----------
export async function cargarDoctores(db: SupabaseClient): Promise<Doc[]> {
  return await fetchAll<Doc>(db, "doctors", "id, nombre, noloco_id");
}

export async function perfilPorPista(db: SupabaseClient, pista: string): Promise<string | null> {
  // OJO: profiles NO tiene full_name ni email — la versión anterior los pedía,
  // el select fallaba en silencio y esta función devolvió null SIEMPRE (por eso
  // ninguna actividad del sync tuvo autor hasta el 22/8). La columna real es
  // `nombre`; si esto vuelve a fallar, que reviente en vez de atribuir a nadie.
  const { data, error } = await db.from("profiles").select("id, nombre");
  if (error) throw new Error(`perfilPorPista: ${error.message}`);
  const p = (data ?? []).find((x) => norm(x.nombre ?? "").includes(pista));
  return p?.id ?? null;
}

export async function actividadesExistentes(db: SupabaseClient): Promise<Set<string>> {
  const rows = await fetchAll<{ doctor_id: string; occurred_at: string; summary: string | null }>(
    db,
    "activities",
    "doctor_id, occurred_at, summary"
  );
  return new Set(
    rows.map((r) => `${r.doctor_id}|${r.occurred_at.slice(0, 10)}|${(r.summary ?? "").slice(0, 80)}`)
  );
}

export function claveActividad(doctorId: string, iso: string, summary: string): string {
  // SIEMPRE en UTC: PostgREST devuelve occurred_at en UTC, pero los candidatos
  // llegan con hora local de México (-06:00). Un evento de las 18:00+ CDMX cruza
  // de día en UTC, y comparar strings crudos hacía que el dedup no lo viera:
  // los mismos 13 contact points vespertinos se re-insertaban en CADA corrida
  // (detectado 20/8: ×4 copias; limpiado a mano, este fix evita la quinta).
  const dia = new Date(iso).toISOString().slice(0, 10);
  return `${doctorId}|${dia}|${summary.slice(0, 80)}`;
}

export interface ReporteFuente {
  insertadas: number;
  duplicadas: number;
  sinMatch: string[];
  ambiguos: string[];
  /** contact points: con qué usuario del intranet se leyó y a qué perfil se atribuyó */
  usuario?: string;
  atribuidoA?: string | null;
}

// ---------- fuente: contact points (intranet api-colombia) ----------
const INTRANET = "https://api-colombia.keepsmiling.click/";

interface SesionIntranet {
  token: string;
  fullName: string | null;
  email: string | null;
}

async function intranetLogin(email: string, password: string): Promise<SesionIntranet> {
  const res = await fetch(INTRANET + "api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  const token = data?.data?.token;
  if (!token) throw new Error(`Login intranet falló (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
  // el login devuelve el usuario completo: de acá sale la atribución
  return {
    token,
    fullName: data?.data?.full_name ?? null,
    email: data?.data?.email ?? null,
  };
}

async function intranetGet(path: string, token: string): Promise<any> {
  const res = await fetch(INTRANET + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return await res.json();
}

export async function sincronizarContactPoints(
  db: SupabaseClient,
  email: string,
  password: string,
  log: (s: string) => void = () => {}
): Promise<ReporteFuente> {
  const sesion = await intranetLogin(email, password);
  const token = sesion.token;

  type Evento = {
    dentista: string;
    id: number;
    details: string | null;
    date: string;
    modality: string | null;
    reason: string | null;
  };
  const eventos: Evento[] = [];
  let page = 1;
  for (;;) {
    const d = await intranetGet(`api/getContactPoint?page=${page}`, token);
    for (const row of d.table?.body ?? []) {
      for (const semanas of Object.values(row.monthlyEvents ?? {})) {
        for (const evs of Object.values(semanas as Record<string, any[]>)) {
          for (const e of evs ?? []) {
            eventos.push({
              dentista: row.name,
              id: e.id,
              details: e.details,
              date: e.date,
              modality: e.modality,
              reason: e.reason,
            });
          }
        }
      }
    }
    const nxt = d.paginator?.next_page;
    if (!nxt || nxt === 0 || nxt === page) break;
    page = nxt;
    if (page > 300) break; // backstop
  }
  log(`Contact points leídos del intranet: ${eventos.length}`);

  const doctors = await cargarDoctores(db);
  // Atribución por IDENTIDAD del login: cada cuenta del intranet ve SOLO sus
  // propios eventos (verificado 22/8: con la sesión de Juan, los 460 eventos de
  // la ventana son suyos). Quien se loguea es quien hizo el contacto — así el
  // sync por usuario no necesita más config que el par de credenciales.
  const pista =
    norm(sesion.fullName ?? "").split(" ")[0] ||
    (sesion.email ?? "").split("@")[0].toLowerCase();
  const autor = pista ? await perfilPorPista(db, pista) : null;
  const existentes = await actividadesExistentes(db);
  const rep: ReporteFuente = {
    insertadas: 0,
    duplicadas: 0,
    sinMatch: [],
    ambiguos: [],
    usuario: sesion.fullName ?? sesion.email ?? email,
    atribuidoA: autor,
  };
  log(
    `Intranet: sesión de ${rep.usuario} → ` +
      (autor ? "atribuido a su perfil del CRM" : "SIN perfil que matchee (created_by null)")
  );

  const filas: any[] = [];
  for (const e of eventos) {
    const hits = matchDoctor(e.dentista, doctors);
    if (hits.length === 0) { rep.sinMatch.push(e.dentista); continue; }
    if (hits.length > 1) { rep.ambiguos.push(`${e.dentista} → ${hits.map((h) => h.nombre).join(" · ")}`); continue; }
    const doctorId = hits[0].id;
    const occurred = e.date.replace(" ", "T") + "-06:00";
    const summary = e.details?.trim() || `Contacto ${e.modality ?? ""}`.trim();
    const clave = claveActividad(doctorId, occurred, summary);
    if (existentes.has(clave)) { rep.duplicadas++; continue; }
    existentes.add(clave);
    const type =
      e.reason === "KeepDay" ? "keepday"
      : /whatsapp/i.test(e.details ?? "") ? "whatsapp"
      : e.modality === "Presencial" ? "visita"
      : "reunion";
    filas.push({ doctor_id: doctorId, type, occurred_at: occurred, summary, outcome: e.reason, created_by: autor });
  }
  for (let i = 0; i < filas.length; i += 200) {
    const { error } = await db.from("activities").insert(filas.slice(i, i + 200));
    if (error) throw error;
  }
  rep.insertadas = filas.length;
  return rep;
}

// ---------- fuente: comunicaciones de modificación (Noloco keepsmiling-v2) ----------
const NOLOCO_V2 = "https://api.portals.noloco.io/data/keepsmiling-v2";

async function nolocoV2Gql(query: string, variables: Record<string, unknown>, token?: string) {
  const res = await fetch(NOLOCO_V2, {
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
  if (data.errors) throw new Error(JSON.stringify(data.errors).slice(0, 400));
  return data.data;
}

export async function sincronizarComunicaciones(
  db: SupabaseClient,
  email: string,
  password: string,
  log: (s: string) => void = () => {}
): Promise<ReporteFuente> {
  const login = await nolocoV2Gql(
    "mutation l($e:String!,$p:String!){login(email:$e,password:$p){token}}",
    { e: email, p: password }
  );
  const token = login.login.token as string;

  const casos = await fetchAll<{ id: string; id_externo: string | null; doctor_id: string }>(
    db, "cases", "id, id_externo, doctor_id"
  );
  const porIdExterno = new Map(
    casos.filter((c) => c.id_externo).map((c) => [c.id_externo!.toUpperCase(), c])
  );

  const coms: Array<{ createdAt: string; estado: string | null; mensajeCliente: string | null; casos: { idExterno: string | null } | null }> = [];
  let after: string | null = null;
  for (;;) {
    const d: any = await nolocoV2Gql(
      `query c($after:String) {
        keepsmilingComunicacionCollection(first: 200, after: $after,
          where: { motivo: {equals: "MODIFICACIONES_DE_VIDEO_YO_RENDERS"}, createdAt: {gte: "2026-01-01T00:00:00.000Z"} }) {
          totalCount pageInfo { hasNextPage endCursor }
          edges { node { createdAt estado mensajeCliente casos { idExterno } } }
        }
      }`,
      { after },
      token
    );
    const col = d.keepsmilingComunicacionCollection;
    coms.push(...col.edges.map((e: any) => e.node));
    if (!col.pageInfo.hasNextPage) break;
    after = col.pageInfo.endCursor;
  }
  log(`Comunicaciones de modificación 2026 (global): ${coms.length}`);

  const existentes = await actividadesExistentes(db);
  const rep: ReporteFuente = { insertadas: 0, duplicadas: 0, sinMatch: [], ambiguos: [] };
  const filas: any[] = [];
  for (const c of coms) {
    const idext = c.casos?.idExterno?.toUpperCase();
    if (!idext) continue;
    const caso = porIdExterno.get(idext);
    if (!caso) continue; // no es un caso MX del CRM
    const msg = (c.mensajeCliente ?? "").trim();
    const summary = `Pedido de modificación (caso ${idext})${msg && msg !== "." ? `: ${msg}` : ""}`;
    const clave = claveActividad(caso.doctor_id, c.createdAt, summary);
    if (existentes.has(clave)) { rep.duplicadas++; continue; }
    existentes.add(clave);
    filas.push({ doctor_id: caso.doctor_id, type: "revision_clinica", occurred_at: c.createdAt, summary, outcome: c.estado });
  }
  for (let i = 0; i < filas.length; i += 200) {
    const { error } = await db.from("activities").insert(filas.slice(i, i + 200));
    if (error) throw error;
  }
  rep.insertadas = filas.length;
  return rep;
}

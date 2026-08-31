// Alerta de rechazos de propuesta: casos con 2+ "modificaciones de video/renders"
// en 40 días → aviso a Slack (#alertas-rechazos) mencionando a la ortodoncista.
//
// Port de alerta_rechazos.py (launchd en la Mac de Pancho, ~/ks-alertas),
// migrado a cron de Vercel el 21/8/26. Dos diferencias con el resto del CRM:
// lee el portal Noloco keepsmiling-v2 (producción AR), NO ks-indicadores, y su
// estado anti-re-aviso vive en alerta_rechazos_estado (no toca cases).

import type { SupabaseClient } from "@supabase/supabase-js";

const API_V2 = "https://api.portals.noloco.io/data/keepsmiling-v2";
const VENTANA_DIAS = 40;
const PANEL_URL = "https://panel-ortodoncistas.vercel.app";
const MOTIVO = "MODIFICACIONES_DE_VIDEO_YO_RENDERS";

// Ortodoncista en Noloco (userMovimientos.fullName) → usuario de Slack.
// Mapeado a mano el 21/8/26; la mención solo notifica si es miembro del canal.
// Laitan, Persico, Aizpurua y Kogan no están a propósito: ya no trabajan en KS.
const SLACK_IDS: Record<string, string> = {
  "Agustina Cercedo": "U0131GE6CSV",
  "Ana Domench": "U03VDUCMMD4",
  "Luli Zollo": "U04HMELKFN2",
  "Milagros Olmedo": "U044ZH4JC2V",
  "Monica Gonzalez Zuazquita": "U012U3XD9EH",
  "Soledad Fasani": "U069G8CE51B",
  "Fiorella Forciniti": "U07NY8GT813",
  "Agustina Saizar": "U094N7Z2VL1",
  "Rocio Puig": "U07D2TZ7PGB",
  "Camila Dotta": "U07PDQH7MED",
  "Belen Kim": "U07KN55R960",
  "Daniela Marlene Soto": "U09B18EMF7C",
  "Virginia Heredia Castelli": "U0A6R9VFQG5",
  "Luisina Tarulli": "U01ATCWCX7V",
  "Danieska Karolina Fernandez Nuñez": "U0A6YAJHDKN",
  "Maria Jose Grillo": "U02FJP0KUQ3",
  "Constanza Basilico": "U015314PU66",
  "Florencia Mastroberardino": "U044F6SV5HV",
  "Eugenia Di Giano": "U09PSNB2U59",
  "Marcela Mantovano": "U08UNJYLYSH",
  "Gabriela Lavalle": "U0128CFGMFH",
};

type Com = { createdAt: string; mensajeCliente: string | null; casos: { idExterno: string } | null };

async function gqlV2(query: string, token?: string): Promise<any> {
  const res = await fetch(API_V2, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-noloco-project": "keepsmiling-v2",
      "x-noloco-ghost": "false",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Noloco v2: ${JSON.stringify(data.errors).slice(0, 400)}`);
  return data.data;
}

function piezas(texto: string | null): string[] {
  return [...new Set(texto?.match(/\b[1-4][1-8]\b/g) ?? [])].sort();
}

// Un caso con 2+ rechazos ya no se avisa si el conflicto quedó atrás: pasó a
// una etapa de producción o la doctora aprobó el video DESPUÉS del último
// rechazo ("Apruebo la segunda!"). Mismo criterio que el script local del 22/8.
const ETAPAS_RESUELTAS = new Set(["FINALIZADO", "LABORATORIO", "IMPRESION", "IMPRESION_DIGITAL"]);

export async function correrAlertaRechazos(
  db: SupabaseClient,
  email: string,
  password: string,
  webhook: string,
  log: (s: string) => void = () => {}
): Promise<{ avisados: number; conDosOMas: number; descartados: number }> {
  const login = await gqlV2(
    `mutation { login(email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)}) { token } }`
  );
  const token = login.login.token as string;

  const desde = new Date(Date.now() - VENTANA_DIAS * 86400_000).toISOString().slice(0, 10) + "T00:00:00Z";
  const coms: Com[] = [];
  let cursor: string | null = null;
  for (;;) {
    const after: string = cursor ? `, after: "${cursor}"` : "";
    const d = await gqlV2(
      `{ keepsmilingComunicacionCollection(first: 200, where: {
          motivo: {equals: "${MOTIVO}"}, createdAt: {gte: "${desde}"}}${after}) {
          edges { node { createdAt mensajeCliente casos { idExterno } } }
          pageInfo { hasNextPage endCursor } } }`,
      token
    );
    const c = d.keepsmilingComunicacionCollection;
    coms.push(...c.edges.map((e: any) => e.node));
    if (!c.pageInfo.hasNextPage) break;
    cursor = c.pageInfo.endCursor;
  }
  log(`comunicaciones ${VENTANA_DIAS}d: ${coms.length}`);

  const porCaso = new Map<string, Com[]>();
  for (const cm of coms) {
    const caso = cm.casos?.idExterno;
    if (caso && (cm.mensajeCliente ?? "").trim().length > 3) {
      if (!porCaso.has(caso)) porCaso.set(caso, []);
      porCaso.get(caso)!.push(cm);
    }
  }

  const { data: filas, error } = await db.from("alerta_rechazos_estado").select("caso, rechazos");
  if (error) throw new Error(`estado: ${error.message}`);
  const estado = new Map((filas ?? []).map((f) => [f.caso as string, f.rechazos as number]));

  let nuevos = [...porCaso.entries()].filter(
    ([caso, v]) => v.length >= 2 && v.length > (estado.get(caso) ?? 0)
  );
  const conDosOMas = [...porCaso.values()].filter((v) => v.length >= 2).length;
  if (nuevos.length === 0) {
    log("sin casos nuevos con 2+ rechazos");
    return { avisados: 0, conDosOMas, descartados: 0 };
  }

  const guardarEstado = async () => {
    const ahora = new Date().toISOString();
    const upserts = [...porCaso.entries()]
      .filter(([, v]) => v.length >= 2)
      .map(([caso, v]) => ({
        caso,
        rechazos: Math.max(v.length, estado.get(caso) ?? 0),
        updated_at: ahora,
      }));
    const { error: e2 } = await db.from("alerta_rechazos_estado").upsert(upserts, { onConflict: "caso" });
    if (e2) throw new Error(`upsert estado: ${e2.message}`);
  };

  const ids = nuevos.map(([c]) => `"${c}"`).join(", ");
  const info = new Map<string, { doctora: string; orto: string; stage: string | null; aprob: string | null }>();
  const q = await gqlV2(
    `{ keepsmilingCasosCollection(first: 100, where: {idExterno: {in: [${ids}]}}) {
        edges { node { idExterno doctorFullName stage fechaAprobacionVideo userMovimientos { fullName } } } } }`,
    token
  );
  for (const e of q.keepsmilingCasosCollection.edges) {
    info.set(e.node.idExterno, {
      doctora: e.node.doctorFullName || "—",
      orto: e.node.userMovimientos?.fullName || "sin asignar",
      stage: e.node.stage ?? null,
      aprob: e.node.fechaAprobacionVideo ?? null,
    });
  }

  const resuelto = ([caso, v]: [string, Com[]]) => {
    const i = info.get(caso);
    if (!i) return false;
    if (i.stage && ETAPAS_RESUELTAS.has(i.stage)) return true;
    const ultima = v.map((c) => c.createdAt).sort().at(-1)!;
    return !!i.aprob && i.aprob > ultima;
  };
  const descartados = nuevos.filter(resuelto).map(([c]) => c);
  nuevos = nuevos.filter((n) => !resuelto(n));
  if (descartados.length) log(`descartados ${descartados.length} ya resueltos: ${descartados.join(", ")}`);
  if (nuevos.length === 0) {
    await guardarEstado();
    log("nada abierto para avisar");
    return { avisados: 0, conDosOMas, descartados: descartados.length };
  }

  const lineas: string[] = [];
  for (const [caso, v] of [...nuevos].sort((a, b) => b[1].length - a[1].length)) {
    v.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const reps: string[] = [];
    for (let i = 1; i < v.length; i++) {
      const prev = new Set(piezas(v[i - 1].mensajeCliente));
      for (const p of piezas(v[i].mensajeCliente)) {
        if (prev.has(p) && !reps.includes(p)) reps.push(p);
      }
    }
    const { doctora, orto: ortoNombre } = info.get(caso) ?? { doctora: "—", orto: "s/d" };
    const orto = SLACK_IDS[ortoNombre] ? `<@${SLACK_IDS[ortoNombre]}>` : ortoNombre;
    const ultimo = (v[v.length - 1].mensajeCliente ?? "").replace(/\n/g, " ").trim().slice(0, 120);
    const extra = reps.length ? ` · 🔁 pieza ${reps.join(", ")} repetida` : "";
    lineas.push(`*${caso}* — ${doctora} · ort. ${orto} · *${v.length}º rechazo*${extra}\n> ${ultimo}`);
  }

  const texto =
    `⚠ *${nuevos.length} caso${nuevos.length > 1 ? "s" : ""} con 2+ rechazos de propuesta* — ` +
    `revisar con la ortodoncista\n\n` +
    lineas.slice(0, 10).join("\n\n") +
    (lineas.length > 10 ? `\n\n…y ${lineas.length - 10} más.` : "") +
    `\n\n<${PANEL_URL}|Ver panel>`;

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: texto }),
  });
  if (!res.ok) throw new Error(`Slack respondió ${res.status}`);
  log(`Slack: ${res.status}, avisados ${nuevos.length}`);

  await guardarEstado();

  return { avisados: nuevos.length, conDosOMas, descartados: descartados.length };
}

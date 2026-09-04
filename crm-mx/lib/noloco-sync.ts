// Sincronización Noloco → CRM: la ÚNICA implementación del import de casos.
//
// La consumen dos entradas:
//   · scripts/import-noloco.ts — corrida manual desde una terminal, con el gate
//     EXPECTED (conteos dichos por Juan) y confirmación de destino.
//   · app/api/sync/noloco — el cron de Vercel (cada 2 h), con gate anti-regresión
//     contra la propia base, porque a las 3 de la mañana no hay nadie para
//     mantener un hardcode de conteos mensuales.
//
// Antes de esto el import vivía entero en el script y el CRM solo se actualizaba
// cuando alguien lo corría a mano: quedó congelado 12 días (7/8 → 19/8) y Pancho
// lo notó porque una doctora subió un caso y el CRM no se enteró.
//
// Escribe con service-role a propósito: setear noloco_id está prohibido desde la
// app (guard de 0019) y este importador es el único autorizado a conciliarlo.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/scripts/lib/fetch-all";
import { canonPhone, canonEmail } from "@/scripts/lib/phone";

export interface NolocoCase {
  id: string;
  idExterno: string | null;
  paciente: string | null;
  tipoTratamiento: string | null;
  etapa: string | null;
  pais: string;
  fechaIngreso: string;
  fechaDocumentacion: string | null;
  fechaAprobacion: string | null;
  fechaEdicion: string | null;
  fechaMovimientos: string | null;
  fechaVideo: string | null;
  fechaAprobacionVideo: string | null;
  fechaImpresion: string | null;
  fechaFinalizado: string | null;
  fechaEntrega: string | null;
  doctores: {
    id: string;
    nombre: string;
    email: string | null;
    telefono?: string | null;
    categoria: string | null;
  } | null;
}

const CATEGORIAS = new Set(["SIN_CATEGORIA", "SILVER", "GOLD", "PLATINUM", "BLACK", "ELITE"]);

// Duplicados conocidos en Noloco: id alias → id canónico
// 2532 "Ruiz Velazquez Lorena" (3 casos) es la misma persona que 2537 (25 casos)
const DOCTOR_ALIASES: Record<string, string> = { "2532": "2537" };

// Doctores de prueba en Noloco: no importar (ni sus casos)
const SKIP_DOCTOR_NAMES = new Set(["Prueba Doctor"]);
const DAY_MS = 86_400_000;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Fetch directo de Noloco (port de gestion-mx/scripts/pull_noloco_mx.py)
// ---------------------------------------------------------------------------

const NOLOCO_API = "https://api.portals.noloco.io/data/ks-indicadores";

const CAMPOS = `
  id idExterno paciente tipoTratamiento etapa pais
  fechaIngreso fechaDocumentacion fechaAprobacion fechaEdicion fechaMovimientos
  fechaVideo fechaAprobacionVideo fechaImpresion fechaFinalizado fechaEntrega
  doctores { id nombre email telefono categoria }
`;

async function nolocoGql(
  query: string,
  variables: Record<string, unknown>,
  token?: string
): Promise<any> {
  const res = await fetch(NOLOCO_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-noloco-project": "ks-indicadores",
      "x-noloco-ghost": "false",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Noloco: ${JSON.stringify(data.errors).slice(0, 400)}`);
  return data.data;
}

/** Baja TODOS los casos pais=MEXICO de xanoCasos, paginando de a 200. */
export async function fetchCasosNolocoMx(
  email: string,
  password: string,
  log: (s: string) => void = () => {}
): Promise<NolocoCase[]> {
  const login = await nolocoGql(
    "mutation l($e:String!,$p:String!){login(email:$e,password:$p){token}}",
    { e: email, p: password }
  );
  const token = login.login.token as string;

  const casos: NolocoCase[] = [];
  let after: string | null = null;
  for (;;) {
    const d = await nolocoGql(
      `query c($after:String) {
        xanoCasosCollection(first: 200, after: $after,
          where: { pais: {equals: "MEXICO"} },
          orderBy: {field: "fechaIngreso", direction: DESC}) {
          totalCount pageInfo { hasNextPage endCursor }
          edges { node { ${CAMPOS} } }
        }
      }`,
      { after },
      token
    );
    const col = d.xanoCasosCollection;
    casos.push(...col.edges.map((e: any) => e.node));
    log(`  Noloco: ${casos.length}/${col.totalCount}`);
    if (!col.pageInfo.hasNextPage) break;
    after = col.pageInfo.endCursor;
  }
  return casos;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Conteo de casos nuevos (I_1) por mes calendario, para los gates y el log. */
export function conteosI1PorMes(casos: NolocoCase[]): Record<string, number> {
  const monthly: Record<string, number> = {};
  for (const c of casos) {
    if (c.etapa === "I_1" && c.fechaIngreso) {
      const m = c.fechaIngreso.slice(0, 7);
      monthly[m] = (monthly[m] ?? 0) + 1;
    }
  }
  return monthly;
}

/**
 * Gate del cron: compara contra la PROPIA base en vez de contra un hardcode.
 *
 * Un mes cerrado no puede llegar con MENOS casos I_1 que los que la base ya
 * tiene: eso es un fetch truncado o un filtro roto, no la realidad (los
 * backfills legítimos solo pueden sumar). Y un payload de menos de 900 casos
 * contra una base que ya pasó los 1.000 es un fetch a medias, se venga de donde
 * se venga. En cualquiera de los dos casos no se escribe nada.
 */
export async function gateAntiRegresion(
  db: SupabaseClient,
  casos: NolocoCase[]
): Promise<string[]> {
  const errores: string[] = [];
  if (casos.length < 900) {
    errores.push(`payload sospechosamente chico: ${casos.length} casos (esperados 1.000+)`);
    return errores;
  }
  const payload = conteosI1PorMes(casos);
  const mesActual = new Date().toISOString().slice(0, 7);

  const enDb = await fetchAll<{ fecha_ingreso: string }>(
    db,
    "cases",
    "fecha_ingreso",
    (q) => q.eq("is_new_case", true).gte("fecha_ingreso", "2026-01-01")
  );
  const dbMonthly: Record<string, number> = {};
  for (const r of enDb) {
    const m = r.fecha_ingreso.slice(0, 7);
    dbMonthly[m] = (dbMonthly[m] ?? 0) + 1;
  }
  for (const [mes, enBase] of Object.entries(dbMonthly)) {
    if (mes >= mesActual) continue; // el mes en curso todavía se mueve
    const got = payload[mes] ?? 0;
    if (got < enBase) {
      errores.push(`${mes}: el payload trae ${got} casos I_1 y la base ya tiene ${enBase}`);
    }
  }
  return errores;
}

// ---------------------------------------------------------------------------
// Sincronización (el cuerpo que vivía en scripts/import-noloco.ts)
// ---------------------------------------------------------------------------

export interface ResumenSync {
  casosLeidos: number;
  doctoresUnicos: number;
  doctoresNuevos: number;
  doctoresActualizados: number;
  adoptadas: string[];
  ambiguos: string[];
  casosUpserted: number;
  i1EnDb: number | null;
  recomputeError: string | null;
  monthly: Record<string, number>;
}

export async function sincronizarNoloco(
  db: SupabaseClient,
  casos: NolocoCase[],
  log: (s: string) => void = () => {}
): Promise<ResumenSync> {
  const monthly = conteosI1PorMes(casos);

  const { data: run } = await db
    .from("sync_runs")
    .insert({ source: "noloco", status: "running" })
    .select("id")
    .single();

  try {
    // ---------- Fase 1: doctores ----------
    type DocAgg = {
      noloco_id: string;
      nombre: string;
      email: string | null;
      phone: string | null;
      categoria: string;
      allDates: string[];
      newDates: string[];
    };
    const docs = new Map<string, DocAgg>();
    for (const c of casos) {
      if (!c.doctores) continue;
      if (SKIP_DOCTOR_NAMES.has(c.doctores.nombre)) continue;
      const d = { ...c.doctores, id: DOCTOR_ALIASES[c.doctores.id] ?? c.doctores.id };
      let agg = docs.get(d.id);
      if (!agg) {
        agg = {
          noloco_id: d.id,
          nombre: d.nombre,
          email: d.email,
          phone: d.telefono ?? null,
          categoria: CATEGORIAS.has(d.categoria ?? "") ? d.categoria! : "SIN_CATEGORIA",
          allDates: [],
          newDates: [],
        };
        docs.set(d.id, agg);
      }
      agg.allDates.push(c.fechaIngreso);
      if (c.etapa === "I_1") agg.newDates.push(c.fechaIngreso);
    }
    log(`Doctores únicos: ${docs.size}`);

    // Mediana de gaps por categoría (fallback cohort para n<3)
    const personalIntervals = new Map<string, number>();
    const byCat = new Map<string, number[]>();
    for (const d of docs.values()) {
      const dates = d.newDates.map((x) => Date.parse(x)).sort((a, b) => a - b);
      if (dates.length >= 3) {
        const gaps = dates.slice(1).map((t, i) => (t - dates[i]) / DAY_MS).slice(-8);
        const m = median(gaps);
        if (m !== null) {
          const clamped = Math.min(365, Math.max(14, m));
          personalIntervals.set(d.noloco_id, clamped);
          byCat.set(d.categoria, [...(byCat.get(d.categoria) ?? []), clamped]);
        }
      }
    }
    const cohortMedians = new Map<string, number>();
    for (const [cat, xs] of byCat) cohortMedians.set(cat, median(xs)!);
    const globalMedian = median([...personalIntervals.values()]) ?? 45;

    const now = Date.now();
    function initialLifecycle(d: DocAgg): string {
      const allT = d.allDates.map((x) => Date.parse(x));
      const lastAny = Math.max(...allT);
      const daysSinceAny = (now - lastAny) / DAY_MS;
      if (d.allDates.length === 1 && daysSinceAny > 365) return "perdido";
      if (daysSinceAny <= 60) return "activo";
      const newT = d.newDates.map((x) => Date.parse(x));
      const interval =
        personalIntervals.get(d.noloco_id) ?? cohortMedians.get(d.categoria) ?? globalMedian;
      if (newT.length > 0) {
        const overdue = (now - Math.max(...newT)) / DAY_MS / interval;
        return overdue > 2 ? "dormido" : "activo";
      }
      return daysSinceAny > 180 ? "dormido" : "activo";
    }

    // paginado obligatorio: sin esto PostgREST devuelve 1.000 de 7k doctores y
    // el import no reconocería a los existentes → los duplicaría a todos
    const existing = await fetchAll<{
      id: string;
      noloco_id: string | null;
      nombre: string;
      email: string | null;
      phone: string | null;
      whatsapp: string | null;
      categoria: string;
      is_accredited: boolean;
    }>(
      db,
      "doctors",
      "id, noloco_id, nombre, email, phone, whatsapp, categoria, is_accredited"
    );
    const existingByNoloco = new Map(existing.map((r) => [r.noloco_id, r.id]));
    const currentFields = new Map(
      existing.map((r) => [r.noloco_id, { email: r.email, categoria: r.categoria }])
    );

    // ---- Adopción de fichas del CRM que Noloco todavía no conoce ----
    // (ver scripts/import-noloco.ts en git history para el porqué completo:
    // un acreditado sin noloco_id se partiría en dos fichas al ingresar su
    // primer caso; acá se adopta la ficha existente si hay UN candidato claro)
    const sinNoloco = existing.filter((r) => !r.noloco_id);
    const porEmail = new Map<string, typeof sinNoloco>();
    const porTelefono = new Map<string, typeof sinNoloco>();
    for (const r of sinNoloco) {
      const e = canonEmail(r.email);
      if (e) porEmail.set(e, [...(porEmail.get(e) ?? []), r]);
      for (const p of [r.phone, r.whatsapp]) {
        const c = canonPhone(p);
        if (c && !(porTelefono.get(c) ?? []).some((x) => x.id === r.id)) {
          porTelefono.set(c, [...(porTelefono.get(c) ?? []), r]);
        }
      }
    }
    const yaAdoptados = new Set<string>();

    function buscarFichaAdoptable(d: {
      nombre: string;
      email: string | null;
      phone: string | null;
    }) {
      for (const cands of [
        porEmail.get(canonEmail(d.email) ?? "") ?? [],
        porTelefono.get(canonPhone(d.phone) ?? "") ?? [],
      ]) {
        const libres = cands.filter((c) => !yaAdoptados.has(c.id));
        if (libres.length === 1) return { ficha: libres[0], ambiguo: false as const };
        if (libres.length > 1) return { ficha: null, ambiguo: true as const, cands: libres };
      }
      return null;
    }

    let inserted = 0;
    let updated = 0;
    const adoptadas: string[] = [];
    const ambiguos: string[] = [];
    for (const d of docs.values()) {
      const allT = d.allDates.map((x) => Date.parse(x)).sort((a, b) => a - b);
      const newT = d.newDates.map((x) => Date.parse(x)).sort((a, b) => a - b);
      const stats = {
        case_count: d.allDates.length,
        new_case_count: d.newDates.length,
        first_case_at: new Date(allT[0]).toISOString().slice(0, 10),
        last_case_at: new Date(allT[allT.length - 1]).toISOString().slice(0, 10),
        last_new_case_at: newT.length
          ? new Date(newT[newT.length - 1]).toISOString().slice(0, 10)
          : null,
        avg_interval_days:
          personalIntervals.get(d.noloco_id) ?? cohortMedians.get(d.categoria) ?? globalMedian,
      };
      const existingId = existingByNoloco.get(d.noloco_id);
      if (existingId) {
        // nunca pisar campos CRM-owned (owner, lifecycle, phone, tags…);
        // email/categoría solo se COMPLETAN si están vacíos (fill-empty)
        const cur = currentFields.get(d.noloco_id);
        const patch: Record<string, unknown> = { ...stats };
        if (!cur?.email && d.email) patch.email = d.email;
        if (cur?.categoria === "SIN_CATEGORIA" && d.categoria !== "SIN_CATEGORIA") {
          patch.categoria = d.categoria;
        }
        const { error } = await db.from("doctors").update(patch).eq("id", existingId);
        if (error) throw error;
        updated++;
      } else {
        const match = buscarFichaAdoptable(d);
        if (match?.ambiguo) {
          ambiguos.push(
            `${d.nombre} (noloco ${d.noloco_id}) → ${match.cands.length} candidatas: ` +
              match.cands.map((c) => c.nombre).join(" · ")
          );
        }
        if (match && !match.ambiguo && match.ficha) {
          const ficha = match.ficha;
          const patch: Record<string, unknown> = { noloco_id: d.noloco_id, ...stats };
          if (!ficha.email && d.email) patch.email = d.email;
          if (ficha.categoria === "SIN_CATEGORIA" && d.categoria !== "SIN_CATEGORIA") {
            patch.categoria = d.categoria;
          }
          const { error } = await db.from("doctors").update(patch).eq("id", ficha.id);
          if (error) throw error;
          yaAdoptados.add(ficha.id);
          existingByNoloco.set(d.noloco_id, ficha.id);
          adoptadas.push(`${ficha.nombre} ←→ noloco ${d.noloco_id} (${d.nombre})`);
          continue;
        }

        const { data: ins, error } = await db
          .from("doctors")
          .insert({
            noloco_id: d.noloco_id,
            nombre: d.nombre,
            phone: d.phone,
            email: d.email,
            categoria: d.categoria,
            lifecycle_stage: initialLifecycle(d),
            ...stats,
          })
          .select("id")
          .single();
        if (error) throw error;
        existingByNoloco.set(d.noloco_id, ins.id);
        inserted++;
      }
    }
    log(`Doctores: ${inserted} nuevos, ${updated} actualizados, ${adoptadas.length} fichas adoptadas`);
    for (const a of adoptadas) log(`  adoptada: ${a}`);
    if (ambiguos.length) {
      log(
        `  ⚠ ${ambiguos.length} con más de una ficha candidata: se creó una nueva en vez de adivinar.`
      );
      for (const a of ambiguos) log(`    - ${a}`);
    }

    // ---------- Fase 2: casos ----------
    const resolveDoctor = (rawId: string) =>
      existingByNoloco.get(DOCTOR_ALIASES[rawId] ?? rawId);
    const caseRows = casos
      .filter((c) => c.doctores && resolveDoctor(c.doctores.id))
      .map((c) => ({
        noloco_case_id: c.id,
        id_externo: c.idExterno,
        doctor_id: resolveDoctor(c.doctores!.id)!,
        paciente: c.paciente,
        tipo_tratamiento: c.tipoTratamiento,
        etapa: c.etapa,
        is_new_case: c.etapa === "I_1",
        needs_review: c.etapa === null,
        treatment_key: c.paciente
          ? `${c.paciente.trim().toLowerCase()}:${resolveDoctor(c.doctores!.id)}`
          : null,
        fecha_ingreso: c.fechaIngreso,
        fecha_documentacion: c.fechaDocumentacion,
        fecha_aprobacion: c.fechaAprobacion,
        fecha_edicion: c.fechaEdicion,
        fecha_movimientos: c.fechaMovimientos,
        fecha_video: c.fechaVideo,
        fecha_aprobacion_video: c.fechaAprobacionVideo,
        fecha_impresion: c.fechaImpresion,
        fecha_finalizado: c.fechaFinalizado,
        fecha_entrega: c.fechaEntrega,
      }));

    for (let i = 0; i < caseRows.length; i += 500) {
      const chunk = caseRows.slice(i, i + 500);
      const { error } = await db
        .from("cases")
        .upsert(chunk, { onConflict: "noloco_case_id" });
      if (error) throw error;
    }
    log(`Casos upserted: ${caseRows.length}`);

    // ---------- objetivos país (rampa H2 del OKR) ----------
    const RAMPA: Record<string, number> = {
      "2026-08-01": 24, "2026-09-01": 26, "2026-10-01": 28,
      "2026-11-01": 30, "2026-12-01": 30,
    };
    for (const [period, target] of Object.entries(RAMPA)) {
      const { data: g } = await db
        .from("goals")
        .select("id")
        .eq("period", period)
        .eq("metric", "paid_cases")
        .is("user_id", null)
        .maybeSingle();
      if (!g) {
        await db.from("goals").insert({ period, metric: "paid_cases", target });
      }
    }

    // ---------- recompute total (cohortes + scores) ----------
    // Vía PostgREST puede morir por statement_timeout del rol; no es fatal:
    // pg_cron lo corre entero cada noche (crm-recompute-nightly, 11:00 UTC).
    const { error: rcErr } = await db.rpc("recompute_all");
    if (rcErr) log(`recompute_all falló (lo cubre el pg_cron nocturno): ${rcErr.message}`);
    else log("Scores recalculados ✓");

    // ---------- eje de actividad de 90 días (migración 0055) ----------
    // Va acá y no en su propio cron porque es acá donde llegan los casos: un
    // doctor que manda su primera etapa a la mañana tiene que salir de "solo
    // termina" en el sync siguiente, no a la noche. Un UPDATE sobre 212 filas,
    // no compite con nada. La red igual está: crm-actividad-nightly a las 11:20.
    const { error: actErr } = await db.rpc("recompute_actividad");
    if (actErr) log(`recompute_actividad falló (lo cubre el cron): ${actErr.message}`);
    else log("Eje de actividad recalculado ✓");

    // ---------- verificación post-escritura ----------
    const { count: i1EnDb } = await db
      .from("cases")
      .select("id", { count: "exact", head: true })
      .eq("is_new_case", true);
    log(`Casos nuevos (I_1) en DB: ${i1EnDb}`);

    const watermark = casos.reduce((max, c) => {
      const t = c.fechaEdicion ?? c.fechaIngreso;
      return t > max ? t : max;
    }, "");

    if (run) {
      await db
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          rows_upserted: caseRows.length + inserted + updated,
          watermark,
          status: "ok",
          log: { doctores: docs.size, casos: caseRows.length, monthly },
        })
        .eq("id", run.id);
    }

    return {
      casosLeidos: casos.length,
      doctoresUnicos: docs.size,
      doctoresNuevos: inserted,
      doctoresActualizados: updated,
      adoptadas,
      ambiguos,
      casosUpserted: caseRows.length,
      i1EnDb: i1EnDb ?? null,
      recomputeError: rcErr?.message ?? null,
      monthly,
    };
  } catch (e) {
    // el run no puede quedar "running" para siempre: se cierra como error y
    // el error original sigue viaje al caller
    if (run) {
      await db
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "error",
          log: { error: e instanceof Error ? e.message : String(e) },
        })
        .eq("id", run.id);
    }
    throw e;
  }
}

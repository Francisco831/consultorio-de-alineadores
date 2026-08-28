// Vincula los pagos huérfanos con su doctor. Port de scripts/reconcile-ledger.ts.
//
// EL PROBLEMA QUE RESUELVE: la planilla de México trae el nombre del profesional
// como texto libre ("Dra. Ilse Osuna"), y la tabla payments no guarda ese texto
// —no tiene columna para él—, solo el doctor_id ya resuelto. Los pagos entran
// con doctor_id null y alguien tiene que casarlos contra la ficha del doctor.
// Hasta el 28/8/26 ese alguien era Pancho corriendo el script a mano.
//
// POR QUÉ VIVE PEGADO AL SYNC DE PAGOS Y NO EN SU PROPIA RUTA: el nombre crudo
// solo existe en la planilla recién parseada. Una ruta separada tendría que
// bajar el Apps Script de nuevo (19 s) para recuperar un dato que la otra acaba
// de tener en la mano. El script viejo lo leía de data/payments.json, un archivo
// del disco de Pancho que quedó congelado en el import de agosto: acá se trabaja
// contra el estado vivo de la base, que además es más correcto.
//
// Qué hace con cada doctor sin vincular:
//   · 1 candidato  → linkea los pagos; si figuraba como prospecto, lo marca
//                    acreditado (pagó = cliente)
//   · 0 candidatos → crea la ficha (tag ledger-sin-noloco) y linkea: es el
//                    doctor que pagó pero no está en el portal comercial
//   · 2 o más      → NO TOCA NADA y lo reporta
//
// Ese último caso es la ÚNICA diferencia con scripts/reconcile-ledger.ts, y es a
// propósito (28/8/26). El script creaba una ficha nueva "para no adivinar", que
// con un humano mirando la consola era razonable. Corriendo solo todos los días
// no lo es: el primer caso real que apareció fue "García Garduño Guillermo",
// que matchea DOS fichas que ya son la misma persona cargada al derecho y al
// revés — crear una tercera habría enterrado el problema en vez de mostrarlo.
// Un pago sin vincular se arregla en diez segundos; una ficha duplicada parte
// en dos la historia de un doctor y nadie se entera.
//
// Nada de esto borra ni despega nada: solo completa doctor_id donde estaba null.

import type { SupabaseClient } from "@supabase/supabase-js";

import { traerTodo } from "./paginar";
import type { PagoPlanilla } from "./pagos-planilla";

const TITULOS = /\b(dra?|drs|doctora?|od|cd|mtra?|esp|lic)\b\.?/g;
const VACIAS = ["de", "del", "la", "las", "los", "y"];

export function nameTokens(s: string): string[] {
  return [
    ...new Set(
      s
        .normalize("NFD")
        .replace(/\p{Mn}/gu, "")
        .toLowerCase()
        .replace(TITULOS, " ")
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1 && !VACIAS.includes(t))
    ),
  ].sort();
}

/**
 * 3 tokens en común (o dos nombres cortos idénticos). Con 2 tokens se fusionan
 * personas distintas — y acá el daño sería peor que un duplicado: colgarle
 * pagos ajenos a un doctor y marcarlo acreditado sin serlo.
 */
export function nameMatches(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const inter = a.filter((t) => b.includes(t)).length;
  const small = Math.min(a.length, b.length);
  if (small <= 2) return a.length === b.length && inter === a.length;
  return inter >= 3 && inter >= small - 1;
}

export function cleanName(raw: string): string {
  return raw
    .replace(/^\s*(dra?|dr|doctora?)\s*\.?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

type DoctorMin = { id: string; nombre: string; is_accredited: boolean };

export type ResultadoReconcile = {
  huerfanos: number;
  linkeados: number;
  creados: number;
  acreditados: number;
  ambiguos: string[];
  nuevos: string[];
};

export async function reconciliarLedger(
  db: SupabaseClient,
  planilla: PagoPlanilla[],
  log: (s: string) => void
): Promise<ResultadoReconcile> {
  const vacio: ResultadoReconcile = {
    huerfanos: 0, linkeados: 0, creados: 0, acreditados: 0, ambiguos: [], nuevos: [],
  };

  const { data: sinDoctor, error } = await db
    .from("payments")
    .select("external_key")
    .is("doctor_id", null);
  if (error) throw new Error(`lectura de pagos huérfanos: ${error.message}`);
  const huerfanas = new Set((sinDoctor ?? []).map((p) => p.external_key as string));
  if (huerfanas.size === 0) {
    log("ledger: no hay pagos sin doctor");
    return vacio;
  }

  // El nombre crudo sale de la planilla, que es el único lugar donde existe.
  const porNombre = new Map<string, { raw: string; keys: string[] }>();
  for (const p of planilla) {
    if (!huerfanas.has(p.external_key) || !p.doctor_nombre_raw) continue;
    const k = nameTokens(p.doctor_nombre_raw).join(" ");
    if (!k) continue;
    const g = porNombre.get(k) ?? { raw: p.doctor_nombre_raw, keys: [] };
    g.keys.push(p.external_key);
    porNombre.set(k, g);
  }
  log(`ledger: ${huerfanas.size} pagos sin doctor, ${porNombre.size} profesionales distintos`);
  if (porNombre.size === 0) return { ...vacio, huerfanos: huerfanas.size };

  const doctores = await traerTodo<DoctorMin>(db, "doctors", "id, nombre, is_accredited");
  const conToks = doctores.map((d) => ({ toks: nameTokens(d.nombre ?? ""), d }));

  const r: ResultadoReconcile = { ...vacio, huerfanos: huerfanas.size, ambiguos: [], nuevos: [] };
  const tocados = new Set<string>();

  for (const [, grupo] of porNombre) {
    const toks = nameTokens(grupo.raw);
    const cands = conToks.filter((w) => nameMatches(toks, w.toks));
    if (cands.length > 1) {
      r.ambiguos.push(`${grupo.raw} → ${cands.map((c) => c.d.nombre).join(" | ")}`);
      log(
        `  ? "${grupo.raw}" matchea ${cands.length} doctores (${cands
          .map((c) => c.d.nombre)
          .join(" | ")}) — se deja sin vincular para que lo resuelva una persona`
      );
      continue;
    }
    let doc: DoctorMin | null = cands.length === 1 ? cands[0].d : null;

    if (!doc) {
      const { data: ins, error: e } = await db
        .from("doctors")
        .insert({
          nombre: cleanName(grupo.raw),
          is_accredited: true,
          lifecycle_stage: "activado",
          tags: ["ledger-sin-noloco"],
          is_demo: false,
        })
        .select("id, nombre, is_accredited")
        .single();
      if (e) throw new Error(`alta de doctor "${grupo.raw}": ${e.message}`);
      doc = ins as DoctorMin;
      conToks.push({ toks, d: doc });
      r.creados++;
      r.nuevos.push(`${doc.nombre} (${grupo.keys.length} pagos)`);
      log(`  + creado: ${doc.nombre} (${grupo.keys.length} pagos)`);
    } else if (!doc.is_accredited) {
      const { error: e } = await db
        .from("doctors")
        .update({ is_accredited: true })
        .eq("id", doc.id);
      if (e) throw new Error(`acreditar ${doc.nombre}: ${e.message}`);
      doc.is_accredited = true;
      r.acreditados++;
      log(`  ✓ ${doc.nombre}: era prospecto pero PAGÓ — marcado acreditado`);
    }

    // `is("doctor_id", null)` no es decorativo: nunca se re-apunta un pago que
    // ya tiene doctor, ni siquiera si el match dice otra cosa.
    const { data: upd, error: e2 } = await db
      .from("payments")
      .update({ doctor_id: doc.id })
      .in("external_key", grupo.keys)
      .is("doctor_id", null)
      .select("external_key");
    if (e2) throw new Error(`vincular pagos de ${doc.nombre}: ${e2.message}`);
    r.linkeados += upd?.length ?? 0;
    tocados.add(doc.id);
  }

  // payments_recompute_trg (migración 0015) ya dispara recompute_doctor en cada
  // update, así que esto es cinturón y tirantes: cubre al doctor recién creado
  // cuyos pagos, por lo que sea, no se hayan movido.
  for (const id of tocados) {
    const { error: e } = await db.rpc("recompute_doctor", { p_id: id });
    if (e) throw new Error(`recompute_doctor: ${e.message}`);
  }

  log(
    `ledger: ${r.linkeados} pagos vinculados · ${r.creados} fichas creadas · ` +
      `${r.acreditados} prospectos→acreditados · ${r.ambiguos.length} sin resolver`
  );
  return r;
}

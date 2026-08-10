/**
 * Seed fases 3-4 del plan:
 *   3. seed_gestion.json → oportunidades/tareas REALES (is_demo=false)
 *   4. Demo sintético marcado (is_demo=true): opps + activities + tasks
 *      con RNG determinístico — re-corridas estables. Se borra con purge_demo().
 *
 *   npx tsx scripts/seed-demo.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(__dirname, "../.env.local") });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// RNG determinístico (mulberry32)
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(dra?|doctor|doctora)\.?\s+/g, "")
    .trim();
}

/** matching laxo por tokens (nombres en distinto orden) */
function nameMatch(a: string, b: string): boolean {
  const ta = new Set(norm(a).split(/\s+/).filter((x) => x.length > 2));
  const tb = new Set(norm(b).split(/\s+/).filter((x) => x.length > 2));
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap >= 2 || (overlap >= 1 && Math.min(ta.size, tb.size) === 1);
}

async function main() {
  const seedPath = resolve(__dirname, "../../gestion-mx/data/seed_gestion.json");
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));

  const { data: doctors } = await db
    .from("doctors")
    .select("id, nombre, owner_id, lifecycle_stage, new_case_count, last_new_case_at, is_demo");
  const { data: profiles } = await db.from("profiles").select("id, nombre");
  if (!doctors?.length) throw new Error("Sin doctores: correr import-noloco.ts primero");

  const byProfile = new Map(
    (profiles ?? []).map((p) => [norm(p.nombre), p.id])
  );
  const juanId = byProfile.get("juan") ?? null;
  const rocioId = byProfile.get("rocio") ?? null;

  const findDoctor = (name: string) =>
    doctors.find((d) => nameMatch(d.nombre, name)) ?? null;

  const { data: run } = await db
    .from("sync_runs")
    .insert({ source: "seed", status: "running" })
    .select("id")
    .single();

  // ---------- Fase 3: datos REALES de seed_gestion.json ----------
  let realOpps = 0;
  let realTasks = 0;

  for (const p of seed.potenciales ?? []) {
    const ownerId = byProfile.get(norm(p.dueno ?? "")) ?? juanId;
    const doctor = findDoctor(p.nombre);
    // los potenciales sin doctor acreditado se crean como doctores prospecto
    let doctorId = doctor?.id;
    if (!doctorId) {
      const { data: existing, error: docErr } = await db
        .from("doctors")
        .select("id")
        .ilike("nombre", `%${p.nombre}%`)
        .limit(1);
      if (docErr) throw docErr;
      if (existing?.length) {
        doctorId = existing[0].id;
      } else {
        const { data: ins, error } = await db
          .from("doctors")
          .insert({
            nombre: p.nombre,
            city: p.ciudad ?? null,
            lifecycle_stage: "prospecto",
            owner_id: ownerId,
            source: "referido",
          })
          .select("id")
          .single();
        if (error) throw error;
        doctorId = ins.id;
      }
    }
    const { data: existingOpps, error: oppErr } = await db
      .from("opportunities")
      .select("id")
      .eq("doctor_id", doctorId)
      .not("stage", "in", "(ganada,perdida)")
      .limit(1);
    if (oppErr) throw oppErr;
    if (!existingOpps?.length) {
      const { error } = await db.from("opportunities").insert({
        doctor_id: doctorId,
        patient_name: null,
        stage: "paciente_potencial",
        owner_id: ownerId,
        source: "referido",
      });
      if (error) throw error;
      realOpps++;
    }
    if (p.proxima_accion) {
      const { data: t, error: tErr } = await db
        .from("tasks")
        .select("id")
        .eq("doctor_id", doctorId)
        .eq("status", "pendiente")
        .limit(1);
      if (tErr) throw tErr;
      if (!t?.length) {
        await db.from("tasks").insert({
          doctor_id: doctorId,
          type: "seguimiento",
          title: p.proxima_accion,
          assigned_to: ownerId,
        });
        realTasks++;
      }
    }
    if (p.notas) {
      const { data: n, error: nErr } = await db
        .from("activities")
        .select("id")
        .eq("doctor_id", doctorId)
        .eq("type", "nota")
        .limit(1);
      if (nErr) throw nErr;
      if (!n?.length) {
        await db.from("activities").insert({
          doctor_id: doctorId,
          type: "nota",
          summary: p.notas,
          occurred_at: p.ultimo_contacto
            ? new Date(p.ultimo_contacto).toISOString()
            : new Date().toISOString(),
        });
      }
    }
  }

  // cobranza / por ingresar → tareas reales con el contexto como descripción
  const contextTasks: [string, string, string][] = [];
  for (const [name, ctx] of Object.entries(seed.contexto_por_cobrar ?? {}))
    contextTasks.push([name, `Cobrar a ${name}`, String(ctx)]);
  for (const [name, ctx] of Object.entries(seed.contexto_por_ingresar ?? {}))
    contextTasks.push([name, `Destrabar ingreso de ${name}`, String(ctx)]);

  for (const [name, title, ctx] of contextTasks) {
    const doctor = findDoctor(name);
    const fullTitle = `${title} — ${ctx.slice(0, 140)}`;
    const { data: existing, error: exErr } = await db
      .from("tasks")
      .select("id")
      .eq("title", fullTitle)
      .limit(1);
    if (exErr) throw exErr;
    if (existing?.length) continue;
    await db.from("tasks").insert({
      doctor_id: doctor?.id ?? null,
      type: "llamada",
      title: fullTitle,
      due_date: new Date().toISOString().slice(0, 10),
      assigned_to: doctor?.owner_id ?? rocioId ?? juanId,
    });
    realTasks++;
  }
  console.log(`Reales: ${realOpps} oportunidades, ${realTasks} tareas`);

  // ---------- Fase 4: demo sintético (is_demo=true) ----------
  const { count: demoCount } = await db
    .from("opportunities")
    .select("id", { count: "exact", head: true })
    .eq("is_demo", true);
  if (process.env.SKIP_DEMO === "1") {
    console.log("SKIP_DEMO=1: solo seed real, sin datos demo (modo producción)");
  } else if ((demoCount ?? 0) > 0) {
    console.log("Demo ya sembrado, salteando (purge_demo() para regenerar)");
  } else {
    const rand = rng(20260807);
    const active = doctors
      .filter((d) => !d.is_demo && d.new_case_count > 0)
      .sort((a, b) => b.new_case_count - a.new_case_count);
    const pool = active.slice(0, 60);
    const STAGES = [
      "paciente_potencial", "paciente_potencial", "paciente_potencial",
      "documentacion", "documentacion", "caso_ingresado", "planificacion",
      "presentada", "presentada", "decision", "compromiso",
    ];
    const NAMES = [
      "García", "López", "Martínez", "Hernández", "Pérez", "Sánchez",
      "Ramírez", "Torres", "Flores", "Rivera", "Gómez", "Díaz", "Cruz",
      "Morales", "Reyes", "Gutiérrez", "Ortiz", "Chávez", "Ruiz", "Mendoza",
    ];
    const owners = [juanId, rocioId].filter(Boolean) as string[];

    const opps = [];
    for (let i = 0; i < 40; i++) {
      const d = pool[Math.floor(rand() * pool.length)];
      const stage = STAGES[Math.floor(rand() * STAGES.length)];
      const daysAgo = Math.floor(rand() * 21);
      opps.push({
        doctor_id: d.id,
        patient_name: `Pac. ${NAMES[Math.floor(rand() * NAMES.length)]} (demo)`,
        stage,
        stage_entered_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
        amount_mxn: [13450, 16500, 20000, 26900][Math.floor(rand() * 4)],
        owner_id: owners[Math.floor(rand() * owners.length)] ?? null,
        source: "existente",
        is_demo: true,
      });
    }
    const { error: oErr } = await db.from("opportunities").insert(opps);
    if (oErr) throw oErr;

    // actividades coherentes: cerca de los casos reales de cada doctor
    const ACT_TYPES = ["whatsapp", "whatsapp", "whatsapp", "llamada", "visita", "revision_clinica"];
    const activities = [];
    for (let i = 0; i < 200; i++) {
      const d = pool[Math.floor(rand() * pool.length)];
      const daysAgo = Math.floor(rand() * 90);
      activities.push({
        doctor_id: d.id,
        type: ACT_TYPES[Math.floor(rand() * ACT_TYPES.length)],
        occurred_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
        summary: "Interacción demo",
        created_by: owners[Math.floor(rand() * owners.length)] ?? null,
        is_demo: true,
      });
    }
    const { error: aErr } = await db.from("activities").insert(activities);
    if (aErr) throw aErr;

    const tasks = [];
    for (let i = 0; i < 25; i++) {
      const d = pool[Math.floor(rand() * pool.length)];
      const inDays = Math.floor(rand() * 7) - 2; // algunas vencidas
      tasks.push({
        doctor_id: d.id,
        type: ACT_TYPES[Math.floor(rand() * ACT_TYPES.length)] === "visita" ? "visita" : "whatsapp",
        title: `Seguimiento demo — ${d.nombre.split(" ")[0]}`,
        due_date: new Date(Date.now() + inDays * 86_400_000).toISOString().slice(0, 10),
        assigned_to: owners[Math.floor(rand() * owners.length)] ?? null,
        is_demo: true,
      });
    }
    const { error: tErr } = await db.from("tasks").insert(tasks);
    if (tErr) throw tErr;
    console.log(`Demo: ${opps.length} opps, ${activities.length} activities, ${tasks.length} tasks`);
  }

  // ---------- recompute ----------
  const { error: rcErr } = await db.rpc("recompute_all");
  if (rcErr) console.warn("recompute_all:", rcErr.message);

  const { data: dist } = await db
    .from("doctors")
    .select("health_score");
  const scores = (dist ?? []).map((d) => d.health_score).filter((x) => x != null) as number[];
  const buckets = { verde: 0, amarillo: 0, rojo: 0 };
  for (const s of scores) {
    if (s >= 70) buckets.verde++;
    else if (s >= 40) buckets.amarillo++;
    else buckets.rojo++;
  }
  console.log("Distribución health:", buckets, `(${scores.length} con score)`);

  if (run) {
    await db
      .from("sync_runs")
      .update({ finished_at: new Date().toISOString(), status: "ok" })
      .eq("id", run.id);
  }
  console.log("Seed OK ✓");
}

main().catch((e) => {
  console.error("Seed falló:", e);
  process.exit(1);
});

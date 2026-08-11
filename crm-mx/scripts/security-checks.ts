/**
 * Chequeos de seguridad del CRM — paso C-1 de PLAN_REMEDIACION_CRM.md.
 *
 *   npx tsx scripts/security-checks.ts              # falla (exit 1) si algo no está en verde
 *   npx tsx scripts/security-checks.ts --baseline   # solo reporta, siempre exit 0
 *   npx tsx scripts/security-checks.ts --probar-altas   # habilita el chequeo 4 (ver abajo)
 *
 * Se escribe ANTES del primer cambio de permisos, a propósito: la corrida en modo
 * --baseline documenta el estado de partida, y las corridas siguientes son la
 * prueba de cierre de G1, G2, G3, G4, G8 y parte de G6.
 *
 * REGLAS DE ESTE SCRIPT
 *  - No escribe NADA. Lo que necesita probar escrituras usa transacciones que
 *    siempre terminan en rollback (ver scripts/lib/pg.ts).
 *  - No crea usuarios ni sesiones. El chequeo 4 prueba el guard de altas con un
 *    insert en `auth.users` dentro de una transacción revertida; aun así queda
 *    detrás de --probar-altas, porque "insertar en auth.users y revertir" y "no
 *    crear usuarios" son la misma frase solo si la transacción cierra bien.
 *  - No imprime valores de variables de entorno, solo sus nombres.
 *  - No imprime cuerpos de respuesta HTTP: de las RPC solo se mira el status, así
 *    que ningún nombre de doctor o de paciente entra en la salida.
 *
 * Estados:
 *   OK         el criterio se cumple
 *   FALLA      el criterio no se cumple y debería
 *   PENDIENTE  el arreglo todavía no está implementado; es esperable hoy
 *   OMITIDO    falta un dato para poder chequear (se dice cuál)
 */
import { config } from "dotenv";
import type { Client } from "pg";
import { connectDb, projectRef, enTransaccionRevertida, comoAutenticado } from "./lib/pg";

config({ path: ".env.local" });

const BASELINE = process.argv.includes("--baseline");
const PROBAR_ALTAS = process.argv.includes("--probar-altas");
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

type Estado = "OK" | "FALLA" | "PENDIENTE" | "OMITIDO";
interface Resultado {
  n: number;
  nombre: string;
  criterio: string;
  estado: Estado;
  detalle: string[];
}
const resultados: Resultado[] = [];

function anotar(
  n: number,
  nombre: string,
  criterio: string,
  estado: Estado,
  detalle: string[]
) {
  resultados.push({ n, nombre, criterio, estado, detalle });
}

// ---------------------------------------------------------------------------
// 1. Permisos de funciones — G1
// ---------------------------------------------------------------------------
async function chequeo1(db: Client) {
  const { rows } = await db.query<{ sig: string; trigger: boolean }>(`
    select p.oid::regprocedure::text as sig,
           (pg_get_function_result(p.oid) = 'trigger') as trigger
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
    where n.nspname = 'public' and d.objid is null and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
    order by 2, 1
  `);
  const rpc = rows.filter((r) => !r.trigger);
  anotar(
    1,
    "Permisos de funciones",
    "Ninguna función SECURITY DEFINER de public es ejecutable por anon",
    rows.length === 0 ? "OK" : "FALLA",
    rows.length === 0
      ? ["las 39 funciones SECURITY DEFINER están cerradas para anon"]
      : [
          `${rows.length} funciones ejecutables por anon (${rpc.length} invocables como RPC)`,
          ...rpc.slice(0, 8).map((r) => `  RPC  ${r.sig}`),
          ...(rpc.length > 8 ? [`  … y ${rpc.length - 8} más`] : []),
        ]
  );
}

// ---------------------------------------------------------------------------
// 2. Exposición HTTP sin sesión — G2
// ---------------------------------------------------------------------------
const RPC_EXPUESTAS: [string, Record<string, unknown>][] = [
  ["ai_data_quality", {}],
  ["ai_forecast", {}],
  ["ai_doctor_segments", {}],
  ["ai_pipeline_summary", {}],
  ["ai_rep_performance", {}],
  ["ai_at_risk_doctors", { p_limit: 1 }],
  ["ai_dormant_doctors", { p_limit: 1 }],
  ["ai_accredited_not_activated", { p_limit: 1 }],
  ["ai_prospects", { p_limit: 1 }],
  ["ai_service_issues", { p_limit: 1 }],
  ["ai_cases_by_period", { p_from: "2026-08-01", p_to: "2026-08-10" }],
  ["case_self_similarity", { p_case_id: "00000000-0000-0000-0000-000000000000" }],
];

async function chequeo2() {
  if (!URL || !ANON) {
    return anotar(2, "Exposición HTTP", "Ninguna RPC devuelve datos sin sesión", "OMITIDO", [
      "faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ]);
  }
  const abiertas: string[] = [];
  for (const [fn, body] of RPC_EXPUESTAS) {
    const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 200) abiertas.push(fn);
  }
  // control: las TABLAS tienen que seguir cerradas
  const tabla = await fetch(`${URL}/rest/v1/doctors?select=nombre&limit=1`, {
    headers: { apikey: ANON },
  });

  const detalle = [
    `${abiertas.length} de ${RPC_EXPUESTAS.length} RPC devuelven 200 sin sesión`,
    ...abiertas.slice(0, 6).map((f) => `  200  ${f}`),
    ...(abiertas.length > 6 ? [`  … y ${abiertas.length - 6} más`] : []),
    `control GET /doctors sin sesión → ${tabla.status}${tabla.status === 401 ? " (correcto)" : " ← ¡las tablas también!"}`,
  ];
  anotar(
    2,
    "Exposición HTTP",
    "Ninguna RPC devuelve datos sin sesión",
    abiertas.length === 0 && tabla.status === 401 ? "OK" : "FALLA",
    detalle
  );
  // control positivo: sin un JWT de prueba no se puede verificar que la app siga andando
  if (!process.env.SUPABASE_TEST_JWT) {
    resultados[resultados.length - 1].detalle.push(
      "control positivo (con sesión → 200) OMITIDO: definí SUPABASE_TEST_JWT para correrlo"
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Alta pública de usuarios — G3
// ---------------------------------------------------------------------------
async function chequeo3(db: Client) {
  if (!URL || !ANON) {
    return anotar(3, "Alta pública", "El signup está apagado", "OMITIDO", ["faltan variables"]);
  }
  const res = await fetch(`${URL}/auth/v1/settings`, { headers: { apikey: ANON } });
  const s = (await res.json()) as { disable_signup?: boolean; mailer_autoconfirm?: boolean };
  const apagado = s.disable_signup === true;

  // Cuántas cuentas hay de verdad. Con el alta abierta, este número es el que dice
  // si además de poder entrar, ya entró alguien. Solo cuenta: sin mails ni nombres.
  //
  // handle_new_user() (0003:33) le crea el perfil a TODA alta, con rol VIEWER. Así
  // que un alta espontánea no queda "sin perfil": queda como VIEWER, y la policy de
  // lectura es `using (true)` para todo `authenticated` (0004:34). Es decir que el
  // alta abierta alcanza para leer la base entera.
  const { rows } = await db.query<{ cuentas: string; perfiles: string; viewers: string }>(`
    select (select count(*)::text from auth.users)                     as cuentas,
           (select count(*)::text from profiles)                       as perfiles,
           (select count(*)::text from profiles where rol = 'VIEWER')  as viewers
  `);
  const { cuentas, perfiles, viewers } = rows[0];

  anotar(
    3,
    "Alta pública",
    "El signup está apagado en esta base",
    apagado ? "OK" : "FALLA",
    [
      `disable_signup = ${s.disable_signup}`,
      `mailer_autoconfirm = ${s.mailer_autoconfirm}`,
      `cuentas en auth.users: ${cuentas} · perfiles: ${perfiles} (${viewers} con rol VIEWER)`,
      apagado
        ? "nadie puede crear una cuenta desde afuera"
        : "cualquiera con la clave anónima puede crear una cuenta, y handle_new_user() le" +
          " arma el perfil solo (rol VIEWER) → lectura completa vía la policy `using (true)`",
    ]
  );
}

// ---------------------------------------------------------------------------
// 4. Allowlist de altas — G4 (existe recién después de R-3)
// ---------------------------------------------------------------------------
async function chequeo4(db: Client) {
  const { rows } = await db.query<{ existe: boolean }>(
    "select to_regclass('public.auth_allowlist') is not null as existe"
  );
  if (!rows[0].existe) {
    return anotar(4, "Allowlist de altas", "Un alta fuera de la allowlist se rechaza", "PENDIENTE", [
      "la tabla auth_allowlist todavía no existe (se crea en R-3)",
    ]);
  }
  if (!PROBAR_ALTAS) {
    return anotar(4, "Allowlist de altas", "Un alta fuera de la allowlist se rechaza", "OMITIDO", [
      "el chequeo inserta en auth.users dentro de una transacción revertida;",
      "corré con --probar-altas para habilitarlo",
    ]);
  }
  const permitido = await db.query<{ email: string }>(
    "select email from auth_allowlist where active limit 1"
  );
  const detalle: string[] = [];
  let ok = true;

  // un mail ajeno tiene que ser rechazado
  try {
    await enTransaccionRevertida(db, async () => {
      await db.query(
        `insert into auth.users (id, email, aud, role)
         values (gen_random_uuid(), 'intruso@example.com', 'authenticated', 'authenticated')`
      );
    });
    detalle.push("mail ajeno: ACEPTADO ← el guard no está frenando el alta");
    ok = false;
  } catch {
    detalle.push("mail ajeno: rechazado (correcto)");
  }

  // uno de la allowlist tiene que pasar
  if (permitido.rows.length > 0) {
    try {
      await enTransaccionRevertida(db, async () => {
        await db.query(
          `insert into auth.users (id, email, aud, role)
           values (gen_random_uuid(), $1 || '.test', 'authenticated', 'authenticated')`,
          [permitido.rows[0].email]
        );
      });
      detalle.push("mail de la allowlist: aceptado (correcto)");
    } catch (e) {
      detalle.push(`mail de la allowlist: RECHAZADO ← ${(e as Error).message.slice(0, 70)}`);
      ok = false;
    }
  }
  anotar(4, "Allowlist de altas", "Un alta fuera de la allowlist se rechaza", ok ? "OK" : "FALLA", detalle);
}

// ---------------------------------------------------------------------------
// 5. Guards de clasificación — G8 (el arreglo llega en R-4)
// ---------------------------------------------------------------------------
async function chequeo5(db: Client) {
  const ctx = await db.query<{ uid: string; case_id: string; act_id: string }>(`
    select (select id from profiles order by created_at limit 1)   as uid,
           (select id from cases limit 1)                          as case_id,
           (select id from activities limit 1)                     as act_id
  `);
  const { uid, case_id, act_id } = ctx.rows[0];
  if (!uid || !case_id || !act_id) {
    return anotar(5, "Guards de clasificación", "'ai_confirmado' se acepta y 'import' se rechaza", "OMITIDO", [
      "la base no tiene perfil, caso o actividad para probar",
    ]);
  }

  async function intentar(sql: string, params: unknown[]): Promise<string | null> {
    try {
      await enTransaccionRevertida(db, async () => {
        await comoAutenticado(db, uid);
        await db.query(sql, params);
      });
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  const aiCaso = await intentar(
    `update cases set case_subject_type='DOCTOR_SELF', case_subject_source='ai_confirmado',
       case_subject_set_by=$1, case_subject_set_at=now() where id=$2`,
    [uid, case_id]
  );
  const humanoCaso = await intentar(
    `update cases set case_subject_type='DOCTOR_SELF', case_subject_source='humano',
       case_subject_set_by=$1, case_subject_set_at=now() where id=$2`,
    [uid, case_id]
  );
  const importCaso = await intentar(
    `update cases set case_subject_type='DOCTOR_SELF', case_subject_source='import',
       case_subject_set_by=$1, case_subject_set_at=now() where id=$2`,
    [uid, case_id]
  );
  const aiAct = await intentar(
    `update activities set engagement_quality='MEANINGFUL', engagement_source='ai_confirmado',
       engagement_set_by=$1, engagement_set_at=now() where id=$2`,
    [uid, act_id]
  );

  const detalle = [
    `cases  'humano'        → ${humanoCaso ? "RECHAZADO ← debería pasar" : "aceptado (correcto)"}`,
    `cases  'ai_confirmado' → ${aiCaso ? "rechazado" : "aceptado (correcto)"}`,
    `cases  'import'        → ${importCaso ? "rechazado (correcto)" : "ACEPTADO ← el allowlist no es positivo"}`,
    `activities 'ai_confirmado' → ${aiAct ? "rechazado" : "aceptado (correcto)"}`,
  ];
  const arreglado = !aiCaso && !aiAct && !humanoCaso && importCaso;
  const esElBugConocido = Boolean(aiCaso && aiAct && !humanoCaso && importCaso);
  anotar(
    5,
    "Guards de clasificación",
    "'ai_confirmado' se acepta, 'humano' se acepta, 'import' se rechaza",
    arreglado ? "OK" : esElBugConocido ? "PENDIENTE" : "FALLA",
    esElBugConocido ? [...detalle, "es ALT-02, tal como está descrito; se arregla en R-4"] : detalle
  );
}

// ---------------------------------------------------------------------------
// 6. RLS y fuente única del forecast — G9 (parcial)
// ---------------------------------------------------------------------------
async function chequeo6(db: Client) {
  const detalle: string[] = [];
  let ok = true;

  // 6a. una identidad autenticada sin perfil no puede escribir
  const sinPerfil = await enTransaccionRevertida(db, async () => {
    await comoAutenticado(db, "00000000-0000-4000-8000-000000000001");
    const r = await db.query<{ rol: string | null; escribe: boolean; manager: boolean }>(
      "select current_rol()::text as rol, can_write() as escribe, is_manager() as manager"
    );
    return r.rows[0];
  });
  if (sinPerfil.escribe || sinPerfil.manager) {
    detalle.push("autenticado sin perfil: PUEDE ESCRIBIR ← no debería");
    ok = false;
  } else {
    detalle.push(`autenticado sin perfil: rol=${sinPerfil.rol ?? "null"}, no escribe (correcto)`);
  }

  // 6b. anon no lee tablas
  if (URL && ANON) {
    const r = await fetch(`${URL}/rest/v1/payments?select=amount_mxn&limit=1`, {
      headers: { apikey: ANON },
    });
    if (r.status === 401) detalle.push("anon sobre payments → 401 (correcto)");
    else {
      detalle.push(`anon sobre payments → ${r.status} ← debería ser 401`);
      ok = false;
    }
  }

  // 6c. el forecast no se recalcula a mano en las páginas
  const { readFileSync } = await import("node:fs");
  const paginas = [
    "app/(app)/dashboard/page.tsx",
    "app/(app)/hoy/page.tsx",
    "app/(app)/pipeline/page.tsx",
  ];
  const aMano = paginas.filter((p) => {
    const src = readFileSync(p, "utf8");
    return /\.from\(\s*["']opportunities["']\s*\)/.test(src) && /probability/.test(src);
  });
  if (aMano.length === 0) {
    detalle.push("las 3 pantallas usan ai_forecast() (correcto)");
  } else {
    detalle.push(`${aMano.length} pantallas recalculan el forecast en JS: ${aMano.join(", ")}`);
  }

  anotar(
    6,
    "RLS y fuente del forecast",
    "anon no lee tablas · un autenticado sin perfil no escribe · una sola definición del forecast",
    ok && aMano.length === 0 ? "OK" : ok ? "PENDIENTE" : "FALLA",
    detalle
  );
}

// ---------------------------------------------------------------------------
// 8. Qué alcanza a ver alguien que se dio de alta solo
// ---------------------------------------------------------------------------
//
// Mientras el chequeo 3 esté en FALLA, cualquiera con la clave anónima —que viaja
// en el bundle del navegador, no es un secreto— puede crearse una cuenta. Esa cuenta
// queda `authenticated` sin fila en `profiles`.
//
// QUÉ IDENTIDAD SE SIMULA, Y POR QUÉ ESTA Y NO OTRA
//
// La primera versión de este chequeo simulaba un autenticado SIN perfil. Esa
// identidad casi no existe: handle_new_user() (0003:33) le crea el perfil a TODA
// alta de auth.users, con rol VIEWER. O sea que quien se registra solo no queda
// sin perfil — queda como VIEWER, con perfil propio.
//
// Medir la identidad equivocada tiene un costo concreto: el criterio se podría
// poner en verde (bloqueando a los sin-perfil) sin haber cerrado la fuga real.
// Así que se simula lo que de verdad pasa: un VIEWER recién creado.
//
// El chequeo 6 prueba que esa identidad no ESCRIBE. Esto prueba lo otro: si además
// LEE, el alta abierta expone doctores con teléfono, pagos y nombres de paciente.
//
// Solo cuenta filas. No trae ninguna columna con datos personales.

/** Todas las tablas con RLS del schema public, no una lista escrita a mano. */
async function tablasConRls(db: Client): Promise<string[]> {
  const { rows } = await db.query<{ t: string }>(`
    select c.relname as t
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     order by 1
  `);
  return rows.map((r) => r.t);
}

async function chequeo8(db: Client) {
  const tablas = await tablasConRls(db);
  if (tablas.length === 0) {
    return anotar(8, "Aislamiento de un alta espontánea", "—", "OMITIDO", [
      "ninguna tabla de public tiene RLS habilitado",
    ]);
  }

  // `profiles.id` referencia `auth.users(id)`: el perfil inventado que usaba este
  // chequeo violaba `profiles_id_fkey` y se llevaba puesto el informe entero. Se
  // toma un perfil que ya existe y se lo degrada a VIEWER dentro de la transacción
  // revertida — es la misma identidad que deja un alta espontánea, porque
  // handle_new_user() (0003:33) crea el perfil justamente con rol VIEWER — y así no
  // hace falta escribir en `auth.users`, que es lo que el chequeo 4 mantiene detrás
  // de --probar-altas.
  const molde = await db.query<{ id: string }>(
    "select id from profiles order by created_at limit 1"
  );
  if (molde.rows.length === 0) {
    return anotar(
      8,
      "Aislamiento de un alta espontánea",
      "Un VIEWER recién creado no lee datos del negocio",
      "OMITIDO",
      ["no hay ninguna fila en profiles para usar de molde"]
    );
  }
  const uid = molde.rows[0].id;

  const visto = await enTransaccionRevertida(db, async () => {
    // Dos cotas, porque este chequeo recorre TODAS las tablas con RLS y corre
    // dentro de una transacción que además tiene tomado el row lock de un perfil:
    //   - statement_timeout: una tabla lenta se reporta como tal en vez de colgar
    //     el informe entero.
    //   - idle_in_transaction_session_timeout: si el proceso muere en medio del
    //     recorrido (Ctrl-C, timeout del que lo invoca), el backend queda "idle in
    //     transaction" reteniendo ese lock hasta que alguien lo note. Con la cota,
    //     Postgres lo cierra solo y la transacción revierte, que es adonde iba.
    await db.query("set local statement_timeout = '20s'");
    await db.query("set local idle_in_transaction_session_timeout = '60s'");
    await db.query("select set_config('app.system', 'on', true)");
    await db.query("update profiles set rol = 'VIEWER' where id = $1", [uid]);
    await comoAutenticado(db, uid);

    // Comprobar que el cambio de rol ocurrió de verdad: si `set local role` fuera un
    // no-op, estaríamos midiendo los privilegios de postgres, que BYPASSA RLS, y todo
    // este chequeo daría un número sin sentido.
    const quien = await db.query<{ rol: string; jwt: string | null }>(
      "select current_user as rol, current_setting('request.jwt.claims', true) as jwt"
    );
    if (quien.rows[0].rol !== "authenticated") {
      throw new Error(`el rol quedó en "${quien.rows[0].rol}", no en authenticated`);
    }

    const out: { tabla: string; filas: number | null; error: string | null }[] = [];
    for (const t of tablas) {
      // savepoint: si una tabla falla, la transacción sigue usable para la siguiente
      await db.query("savepoint s");
      try {
        const r = await db.query<{ n: string }>(`select count(*)::text as n from "${t}"`);
        out.push({ tabla: t, filas: Number(r.rows[0].n), error: null });
        await db.query("release savepoint s");
      } catch (e) {
        out.push({ tabla: t, filas: null, error: (e as Error).message.slice(0, 50) });
        await db.query("rollback to savepoint s");
      }
    }
    return out;
  });

  const conDatos = visto.filter((v) => (v.filas ?? 0) > 0);
  const totalFilas = conDatos.reduce((s, v) => s + (v.filas ?? 0), 0);
  anotar(
    8,
    "Aislamiento de un alta espontánea",
    "Un VIEWER recién creado no lee datos del negocio",
    conDatos.length === 0 ? "OK" : "FALLA",
    [
      `${conDatos.length} de ${tablas.length} tablas con RLS son legibles: ${totalFilas} filas en total`,
      ...conDatos
        .sort((a, b) => (b.filas ?? 0) - (a.filas ?? 0))
        .slice(0, 8)
        .map((v) => `  ${v.tabla.padEnd(22)} ${v.filas} filas  ← LEE`),
      ...(conDatos.length > 8 ? [`  … y ${conDatos.length - 8} tablas más`] : []),
      // El cierre depende del chequeo 3, que ya corrió: con el alta abierta esto es una
      // ruta de entrada real; con el alta cerrada es el radio de daño de una cuenta que
      // alguien tendría que conseguir de otra forma. Decirlo mal en cualquiera de los dos
      // sentidos desinforma, así que se lee el resultado en vez de asumirlo.
      conDatos.length === 0
        ? "un alta espontánea no ve nada"
        : resultados.find((r) => r.n === 3)?.estado === "OK"
          ? "el alta pública está cerrada, así que hoy nadie llega acá desde afuera; esto es el" +
            " radio de daño de UNA cuenta cualquiera, porque la policy de lectura es `using (true)`"
          : "con el chequeo 3 en FALLA, cualquiera con la clave anónima llega hasta acá:" +
            " se registra, handle_new_user() le arma el perfil VIEWER y lee todo esto",
    ]
  );
}

// ---------------------------------------------------------------------------
// 7. La otra mitad de G1: cerrar de más también es un defecto
// ---------------------------------------------------------------------------
//
// El chequeo 1 prueba que anon no ejecute nada. Solo con eso, una migración de
// permisos que revoque de más pasa en verde y rompe la aplicación entera: las
// policies RLS evalúan current_rol()/can_write()/is_manager() con los privilegios
// del llamador, así que sin EXECUTE para `authenticated` no se lee ni una fila.
//
// Las firmas salen de leer quién llama a qué:
//   - lib/actions/*, app/(app)/*  → supabase.rpc(...) con la sesión del usuario
//   - lib/ai/tools/read.ts        → callAggregate() usa el cliente de servidor con
//                                   la sesión del usuario, no service_role, así que
//                                   los agregados ai_* también corren como authenticated
//   - case_subject_review_queue() NO es SECURITY DEFINER: corre como el llamador y
//                                   adentro llama a case_self_similarity()
const NECESITA_AUTHENTICATED = [
  // helpers que evalúan las policies RLS — sin estos no funciona nada
  "can_write()",
  "current_rol()",
  "is_manager()",
  // RPC llamadas desde las pantallas y las server actions
  "ai_data_quality()",
  "case_subject_review_queue(integer)",
  "case_self_similarity(uuid)",
  "evaluate_automations()",
  "evento_roi()",
  "purge_demo()",
  "recompute_all()",
  "default_sales_owner()",
  // agregados que usa la capa AI (0023)
  "ai_accredited_not_activated(integer)",
  "ai_at_risk_doctors(integer)",
  "ai_cases_by_period(date,date)",
  "ai_doctor_segments()",
  "ai_dormant_doctors(integer,boolean)",
  "ai_forecast(date)",
  "ai_pipeline_summary(date,integer)",
  "ai_prospects(text,integer,text,text,integer)",
  "ai_rep_performance(integer,date)",
  "ai_second_case_metrics()",
  "ai_service_issues(integer,uuid)",
];

// Lo inverso: son de uso interno (las llaman triggers y funciones SECURITY DEFINER,
// que corren como el dueño). Si `authenticated` las puede ejecutar, sobra un grant.
const NO_DEBE_AUTHENTICATED = [
  "log_audit(text,uuid,text,text,text)",
  "recompute_doctor(uuid)",
  "refresh_cohort_intervals()",
];

async function chequeo7(db: Client) {
  const { rows } = await db.query<{ sig: string; existe: boolean; puede: boolean }>(
    `select sig,
            to_regprocedure(sig) is not null as existe,
            coalesce(
              has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE'),
              false
            ) as puede
       from unnest($1::text[]) as sig`,
    [[...NECESITA_AUTHENTICATED, ...NO_DEBE_AUTHENTICATED]]
  );
  const estado = new Map(rows.map((r) => [r.sig, r]));

  const faltan = NECESITA_AUTHENTICATED.filter((s) => estado.get(s)?.puede !== true);
  const sobran = NO_DEBE_AUTHENTICATED.filter((s) => estado.get(s)?.puede === true);
  const inexistentes = rows.filter((r) => !r.existe).map((r) => r.sig);

  const detalle: string[] = [
    `${NECESITA_AUTHENTICATED.length - faltan.length} de ${NECESITA_AUTHENTICATED.length} funciones que la app necesita están ejecutables por authenticated`,
    ...faltan.map((s) => `  FALTA   ${s}  ← una pantalla va a fallar con "permission denied"`),
    ...sobran.map((s) => `  SOBRA   ${s}  ← es interna, no debería tener grant`),
  ];
  if (inexistentes.length > 0) {
    detalle.push(
      `  ${inexistentes.length} firma(s) no existen en esta base: ${inexistentes.join(", ")}`,
      "  (o la migración no está aplicada, o la lista de este script quedó vieja)"
    );
  }
  if (faltan.length === 0 && sobran.length === 0 && inexistentes.length === 0) {
    detalle.push("ninguna función interna quedó abierta a authenticated");
  }

  anotar(
    7,
    "Permisos de authenticated",
    "La app conserva EXECUTE en todo lo que usa, y nada interno de más",
    faltan.length === 0 && sobran.length === 0 && inexistentes.length === 0 ? "OK" : "FALLA",
    detalle
  );
}

// ---------------------------------------------------------------------------

const ICONO: Record<Estado, string> = {
  OK: "  OK      ",
  FALLA: "  FALLA   ",
  PENDIENTE: "  PENDIENTE",
  OMITIDO: "  OMITIDO ",
};

/**
 * Un chequeo que se rompe no puede llevarse puestos a los otros siete.
 * El informe se imprime recién después de correrlos todos, así que una excepción
 * en cualquiera de ellos descartaba todo lo ya medido y salía con código 2 sin
 * mostrar una sola línea. Ahora el que se rompe queda en FALLA con su motivo y el
 * resto se reporta igual: este script es el tablero del estado de seguridad, y un
 * tablero que se apaga entero por un panel roto no sirve para decidir nada.
 */
async function correr(n: number, nombre: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    anotar(n, nombre, "el chequeo tiene que poder ejecutarse", "FALLA", [
      `no se pudo ejecutar: ${(e as Error).message.slice(0, 160)}`,
    ]);
  }
}

/**
 * Los chequeos usan DOS caminos: conexión directa a Postgres (1, 3, 5, 6, 7, 8) y
 * HTTP con la clave anónima (2, 3). El primero sale de SUPABASE_PROJECT_REF y el
 * segundo de NEXT_PUBLIC_SUPABASE_URL. Si apuntan a bases distintas —cosa fácil al
 * apuntar a producción con una variable suelta— el informe sale mezclado: encabezado
 * de una base, mitad de los chequeos de la otra, y todo con cara de ser correcto.
 * Con dos bases que tienen los mismos datos y schemas que pueden diferir, eso es
 * exactamente el error que más caro sale.
 */
function verificarCoherenciaDeDestino(ref: string) {
  const refDeLaUrl = URL.replace("https://", "").split(".")[0];
  if (!refDeLaUrl || !ref || refDeLaUrl === ref) return;
  throw new Error(
    `Destinos que no coinciden:\n` +
      `    conexión a Postgres : ${ref}   (SUPABASE_PROJECT_REF)\n` +
      `    llamadas HTTP       : ${refDeLaUrl}   (NEXT_PUBLIC_SUPABASE_URL)\n` +
      `  El informe saldría mezclando dos bases. Definí las dos variables para la` +
      ` misma,\n  incluida NEXT_PUBLIC_SUPABASE_ANON_KEY, que también tiene que ser la de esa base.`
  );
}

async function main() {
  const ref = projectRef();
  verificarCoherenciaDeDestino(ref);
  console.log(`\nChequeos de seguridad — base ${ref}${BASELINE ? "  (modo línea de base)" : ""}\n`);

  const db = await connectDb();
  try {
    await correr(1, "Permisos de funciones", () => chequeo1(db));
    await correr(2, "Exposición HTTP", () => chequeo2());
    await correr(3, "Alta pública", () => chequeo3(db));
    await correr(4, "Allowlist de altas", () => chequeo4(db));
    await correr(5, "Guards de clasificación", () => chequeo5(db));
    await correr(6, "RLS y fuente del forecast", () => chequeo6(db));
    await correr(7, "Permisos de authenticated", () => chequeo7(db));
    await correr(8, "Aislamiento de un alta espontánea", () => chequeo8(db));
  } finally {
    await db.end();
  }

  for (const r of resultados) {
    console.log(`${ICONO[r.estado]}  ${r.n}. ${r.nombre}`);
    console.log(`             ${r.criterio}`);
    for (const d of r.detalle) console.log(`             ${d}`);
    console.log("");
  }

  const fallan = resultados.filter((r) => r.estado === "FALLA");
  const pendientes = resultados.filter((r) => r.estado === "PENDIENTE");
  console.log(
    `Resumen: ${resultados.filter((r) => r.estado === "OK").length} OK · ` +
      `${fallan.length} FALLA · ${pendientes.length} PENDIENTE · ` +
      `${resultados.filter((r) => r.estado === "OMITIDO").length} OMITIDO\n`
  );

  if (BASELINE) return;
  if (fallan.length > 0 || pendientes.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(2);
});

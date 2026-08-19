// /api/sync/noloco — actualización periódica del CRM desde Noloco.
//
// La dispara el cron de Vercel (vercel.json, cada 2 horas) con
// `Authorization: Bearer $CRON_SECRET` — header que Vercel agrega solo cuando
// la env CRON_SECRET existe. También se puede disparar a mano con curl y el
// mismo header, que es la forma de "actualizar ya" sin esperar al cron.
//
// El gate acá NO es el de los reportes de Juan (ese exige mantener un hardcode
// y es para la corrida manual): es anti-regresión contra la propia base — un
// mes cerrado no puede volver con menos casos I_1 que los ya guardados, y un
// payload chico es un fetch truncado. Si el gate falla, no se escribe nada y
// el sync_run queda como error para que se vea en la base.
//
// Los scores: recompute_all vía PostgREST puede cortar por statement_timeout;
// no es fatal porque pg_cron (crm-recompute-nightly, 11:00 UTC) lo corre entero
// cada noche. Los casos y doctores quedan al día igual.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  fetchCasosNolocoMx,
  gateAntiRegresion,
  sincronizarNoloco,
} from "@/lib/noloco-sync";

// El fetch de Noloco (6 páginas) + upsert de ~1.000 casos + 170 updates de
// doctores tarda 60-120 s medidos; 300 es el techo del plan Pro.
export const maxDuration = 300;

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  // Service-role a propósito: es el importador (la única vía autorizada a
  // conciliar noloco_id — guard de 0019). No confundir con lib/ai/db.ts, que
  // es exclusivo de la capa AI.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET no configurado: el sync automático está apagado" },
      { status: 503 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const email = process.env.KEEPSMILING_EMAIL;
  const password = process.env.KEEPSMILING_PASSWORD;
  if (!email || !password) {
    return NextResponse.json(
      { error: "Faltan KEEPSMILING_EMAIL / KEEPSMILING_PASSWORD (credenciales Noloco)" },
      { status: 503 }
    );
  }
  const db = serviceClient();
  if (!db) {
    return NextResponse.json(
      { error: "Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" },
      { status: 503 }
    );
  }

  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  try {
    const casos = await fetchCasosNolocoMx(email, password, log);

    const errores = await gateAntiRegresion(db, casos);
    if (errores.length > 0) {
      await db.from("sync_runs").insert({
        source: "noloco",
        status: "error",
        finished_at: new Date().toISOString(),
        log: { gate: errores },
      });
      return NextResponse.json(
        { error: "Gate anti-regresión falló: no se escribió nada", detalles: errores },
        { status: 422 }
      );
    }

    const resumen = await sincronizarNoloco(db, casos, log);
    return NextResponse.json({ ok: true, resumen, logs });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error inesperado en el sync";
    return NextResponse.json({ error: message, logs }, { status: 500 });
  }
}

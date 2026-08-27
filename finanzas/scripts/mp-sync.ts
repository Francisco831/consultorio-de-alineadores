// Sync de movimientos de Mercado Pago vía API oficial (reporte de liberaciones).
//
// La lógica vive en lib/sync/mp.ts: es la MISMA que corre el cron de Vercel
// (app/api/cron/sync). Este script es el camino de terminal.
//
// Requiere token en .env.local: MP_ACCESS_TOKEN_MX (o _AR).
// Cómo generarlo: docs/mercadopago-api.md
//
// Uso:  npx tsx scripts/mp-sync.ts --empresa mx [--desde 2026-08-01] [--hasta 2026-08-21]
//       npx tsx scripts/mp-sync.ts --empresa mx --apply
// Rango: [desde, hasta) — hasta excluido; default desde = watermark del último
// sync ok (o día 1 del mes), default hasta = hoy.

import { serviceClient, argFlags } from "./lib/service-client";
import { sincronizarMp, RangoVacio } from "../lib/sync/mp";

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const flags = argFlags();
  const empresa = (argValor("empresa") ?? "mx") as "mx" | "ar";
  if (!["mx", "ar"].includes(empresa)) throw new Error("--empresa debe ser mx o ar");

  const token = process.env[`MP_ACCESS_TOKEN_${empresa.toUpperCase()}`];
  if (!token) {
    console.error(
      `Falta MP_ACCESS_TOKEN_${empresa.toUpperCase()} en .env.local.\n` +
      `Cómo crear el token (panel de desarrolladores de MP): docs/mercadopago-api.md`
    );
    process.exit(1);
  }

  const db = await serviceClient({
    accion: `sync Mercado Pago ${empresa.toUpperCase()} vía API (reporte de liberaciones)`,
    auto: flags.yes,
  });

  try {
    const r = await sincronizarMp(db, {
      empresa, token,
      desde: argValor("desde"), hasta: argValor("hasta"),
      dryRun: flags.dryRun,
      log: (m) => console.log(m),
    });
    if (!flags.dryRun) {
      console.log(`Listo: ${r.insertadas} líneas nuevas. Conciliar en /${empresa}/movimientos/conciliar → Sugerir.`);
    }
  } catch (e) {
    if (e instanceof RangoVacio) { console.log(e.message); return; }
    throw e;
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

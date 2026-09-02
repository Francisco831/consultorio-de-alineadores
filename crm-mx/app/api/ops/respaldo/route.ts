// /api/ops/respaldo — el respaldo diario de los datos, en la nube.
//
// Cron de Vercel (vercel.json, 06:30 UTC = 00:30 de México, después de que el
// pg_cron nocturno de scores ya corrió... no: ANTES, a propósito — la foto es del
// cierre del día, no de un cálculo a medias). Mismo contrato que /api/sync/*:
// Bearer CRON_SECRET, corrida en sync_runs (source 'respaldo'), aviso a Slack
// si falla. Vuelca cada tabla a Supabase Storage (bucket privado `respaldos`)
// y borra lo de más de 30 días. Detalle y límites: lib/respaldo.ts.
//
// Corrida manual: curl -H "Authorization: Bearer $CRON_SECRET" https://crm-mx-puce.vercel.app/api/ops/respaldo

import { correrCron } from "@/lib/cron";
import { correrRespaldo } from "@/lib/respaldo";

// ~60k filas por PostgREST en páginas de 1.000 + gzip + ~35 subidas: medido
// 40-90 s. El techo generoso es por Storage cuando responde lento.
export const maxDuration = 300;

export async function GET(req: Request) {
  return correrCron(req, {
    source: "respaldo",
    avisarSiFalla: true,
    async run({ db, log }) {
      const sello = new Date().toISOString().slice(0, 16).replace(":", "-");
      const r = await correrRespaldo(db, sello, log);
      return {
        rows: r.filas,
        resumen: { carpeta: r.carpeta, filas: r.filas, mb: Math.round(r.bytes / 1e5) / 10, borradas: r.borradas },
        avisos: r.avisos,
      };
    },
  });
}

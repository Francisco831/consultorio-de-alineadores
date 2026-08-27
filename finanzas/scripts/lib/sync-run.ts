// El registro de corridas vive en lib/sync/ desde que el sync también corre en
// Vercel (app/api/cron/sync). Acá queda el puente para los scripts de terminal.
export { registrarSync, type CorridaSync } from "../../lib/sync/sync-run";

// Deja constancia de cada corrida de sincronización en sync_runs.
//
// La tabla existe desde la 0006 y estaba VACÍA: ningún script de finanzas la
// escribía, así que no había forma de saber desde la app si la caja se
// sincronizó hoy, ayer o hace una semana. El sync corre en la Mac de Pancho
// dentro de una sesión de Claude; si esa sesión no corre, no pasa nada
// visible — y esa es exactamente la falla peligrosa, la que no avisa.
//
// Una corrida que muere sin llamar ok() ni fallo() queda en 'running' para
// siempre: la pantalla la muestra como colgada, que es lo que fue.

import type { SupabaseClient } from "@supabase/supabase-js";

export type CorridaSync = {
  ok: (datos?: { leidas?: number; escritas?: number; log?: unknown }) => Promise<void>;
  fallo: (motivo: string) => Promise<void>;
};

/** Registra el arranque. Nunca tira: un problema al anotar no puede voltear un sync. */
export async function registrarSync(
  db: SupabaseClient, source: string, companyId?: string
): Promise<CorridaSync> {
  let id: string | null = null;
  try {
    const { data } = await db.from("sync_runs")
      .insert({ source, company_id: companyId ?? null, status: "running" })
      .select("id").single();
    id = (data?.id as string) ?? null;
  } catch {
    id = null;
  }
  const cerrar = async (campos: Record<string, unknown>) => {
    if (!id) return;
    try {
      await db.from("sync_runs").update({ finished_at: new Date().toISOString(), ...campos }).eq("id", id);
    } catch { /* anotar el cierre tampoco puede voltear un sync */ }
  };
  return {
    ok: (datos) => cerrar({
      status: "ok",
      rows_read: datos?.leidas ?? null,
      rows_upserted: datos?.escritas ?? null,
      log: datos?.log ?? null,
    }),
    fallo: (motivo) => cerrar({ status: "error", log: { motivo } }),
  };
}

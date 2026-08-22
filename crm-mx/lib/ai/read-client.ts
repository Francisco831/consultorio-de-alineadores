// Cliente de LECTURA de las tools AI.
//
// Con sesión de usuario usa el cliente anon de la request (RLS): la misma
// visibilidad que la pantalla. Sin sesión —el cron del brief (/api/ai/brief/
// cron) corre sin cookies— cae al service client SOLO para leer: el modelo de
// RLS es "todos los autenticados leen todo" (transparencia), así que no ve
// nada que un usuario logueado no vea, y 0027 les da a las ai_*() grant
// explícito a service_role. Sin este fallback, el brief del cron salía con
// las 12 tools en "error de permisos" y cero datos (visto en prod 22/8).
//
// Las ESCRITURAS de CRM siguen fuera de acá: HITL vía server actions con la
// sesión del usuario (docs/AI_ARCHITECTURE.md) — este cliente es de tools de
// lectura y nada más.

import { createClient } from "@/lib/supabase/server";
import { createAiServiceClient } from "@/lib/ai/db";

export type AiReadClient = Awaited<ReturnType<typeof createClient>>;

export async function createAiReadClient(): Promise<AiReadClient> {
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (user) return session;
  return createAiServiceClient() as AiReadClient;
}

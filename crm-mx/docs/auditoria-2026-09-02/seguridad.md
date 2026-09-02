# Auditoría de seguridad — CRM MX (`crm-mx/`)

Fecha: 2/9/2026 · Alcance: código en el working tree (branch `crm-mx-ai`), solo lectura. No se conectó a ninguna base ni se hizo ningún request a producción. Los valores de `.env.local` no se leyeron; solo nombres de variables.

Stack auditado: Next.js 16.3 App Router (`proxy.ts` como middleware), `@supabase/ssr` 0.12.4, Supabase Auth + RLS (migraciones 0001–0051), Vercel (crons en `vercel.json`), Anthropic SDK.

---

## 0. Veredicto en tres líneas

- **No hay P0.** No encontré ninguna vía para que alguien SIN cuenta lea o escriba datos, ni secretos commiteados en git, ni XSS/SSRF/inyección explotable desde afuera.
- **Hay 2 P1** que son "a un paso" de un problema real: un secreto vivo en texto plano dentro del directorio del repo (sin trackear, pero `git add -A` lo sube) y el estado de `disable_signup` en prod que la documentación registra como `false` y el código no puede garantizar.
- **Los P2 son todos de integridad entre usuarios autenticados**: con la anon key + su propio JWT, cualquier no-VIEWER puede (vía PostgREST, salteando las server actions) editar/borrar tareas, oportunidades y eventos ajenos, falsear `created_by`/`completed_at`/`last_seen_at` (los números con los que se mide al equipo) y marcar `is_demo=true` en doctores reales para que el próximo "Borrar datos demo" los elimine. Con 3 personas de confianza es tolerable; con un cuarto usuario deja de serlo. Las correcciones son 1 migración corta.

---

## 1. Hallazgos por severidad

### P1

#### P1-1 · Secreto real del Apps Script en texto plano dentro del repo
- **Dónde:** `gas-pagos-planilla.LISTO.gs:21` (`const SECRET = "<48 hex>"`). Es el mismo valor que `PLANILLA_MX_SECRET` (el `.gs` lo compara en la línea 24 contra `e.parameter.secret`).
- **Estado:** el archivo NO está trackeado (`git ls-files` solo devuelve `gas-calendar.gs`, que tiene placeholder) y el valor no aparece en la historia (`git log -S` = 0 commits). Pero vive en el árbol de trabajo, con nombre "LISTO", y `app/api/sync/pagos/route.ts:78` lo referencia como documentación. Un `git add -A` o un `git add .` lo commitea. Además el `.gitignore` de crm-mx solo tapa `.env*` y `/data/`.
- **Impacto:** el secreto + la URL del `/exec` (que sí está en Vercel/`.env.local`) dan lectura de la planilla "Administración México" completa (pagos, nombres de doctores).
- **Fix (2 minutos):**
  1. Dejar el literal como placeholder igual que `gas-calendar.gs:31` (`"CAMBIAR-POR-UN-SECRETO-PROPIO"`); el valor real vive en Vercel y en el editor de Apps Script, no hace falta que esté acá.
  2. `.gitignore`: agregar `*.LISTO.gs`.
  3. Si ese archivo se mandó por WhatsApp/mail/Drive para pegarlo en Apps Script, rotar `PLANILLA_MX_SECRET` (cambiar la constante en Apps Script + `vercel env`).

#### P1-2 · `disable_signup` en producción: la documentación lo registra en `false` y el código no lo puede forzar
- **Dónde:** `docs/V1_PRODUCCION.md:30` y `:97` (`disable_signup: false` en prod, "CRIT-02 abierto"). El toggle vive en el panel de Supabase; `scripts/security-checks.ts:152-189` (chequeo 3) es lo único que lo verifica.
- **Qué mitiga hoy:** la allowlist de 0031 (`supabase/migrations/0031_auth_allowlist.sql:163-221`) aborta cualquier alta cuyo mail no esté invitado, **cuando la lista no está vacía** (escape de arranque en `:187-201`). Como 0031 siembra desde `auth.users`, en prod la lista tiene al menos los 3 mails.
- **Residual aunque la allowlist funcione:** si el signup está abierto, un mail invitado y **todavía no creado** (`invitarMail` en `lib/actions/allowlist.ts:50` corre antes que `scripts/create-users.ts`) puede ser registrado por cualquiera que lo conozca, con su propia contraseña: `handle_new_user()` le arma perfil VIEWER y la policy `using (true)` (0004:36) le da lectura de doctores con teléfono, pagos, pacientes y `wa_conversations`.
- **Fix:** no hay cambio de código posible — es verificar. Correr `npx tsx scripts/security-checks.ts` apuntando a prod y confirmar chequeo 3 = OK. Como regla operativa: invitar y crear la cuenta en el mismo acto (create-users.ts ya hace las dos cosas, `:63-91`). Si se quiere un cinturón en código: que `handle_new_user()` rechace cuando `raw_app_meta_data->>'rol'` es null (un alta por admin API siempre lo trae; un self-signup nunca), así ni con el toggle abierto entra nadie:
  ```sql
  -- dentro de handle_new_user(), antes del bloque de allowlist
  if new.raw_app_meta_data->>'rol' is null then
    raise exception 'Alta no autorizada: solo se crean cuentas con scripts/create-users.ts';
  end if;
  ```

### P2

#### P2-1 · `is_demo` no está protegido en `doctors`, `tasks` ni `opportunities`: un SALES puede armar la bomba y un manager la detona con "Borrar datos demo"
- **Dónde:** `doctors_guard` (0019:657-723) protege scores, universo y campos de manager, pero **no `is_demo`**; `tasks` y `opportunities` no tienen guard de columnas. `purge_demo()` (0006:281-296) hace `delete from doctors where is_demo` → cascada a cases/payments/activities.
- **Cómo:** `PATCH /rest/v1/doctors?id=eq.<uuid>` con `{"is_demo":true}` usando la anon key + el JWT propio (cualquier no-VIEWER: policy `doctors_update` = `can_write()`, 0004:59). Después, el botón "Borrar datos demo" de `/ajustes` (solo manager, `lib/actions/admin.ts:41`) borra doctores reales. El mismo patrón ya se cerró para `alerts` en 0030 por este motivo exacto (0030:7-12).
- **Fix (migración corta):**
  ```sql
  -- doctors_guard: en la rama UPDATE no-sistema, junto al bloque del universo (0019:706)
  if new.is_demo is distinct from old.is_demo then
    raise exception 'is_demo lo marca el sistema (seed/purge), no un usuario';
  end if;
  ```
  y el guard mínimo para tasks/opportunities del P2-2, que cubre `is_demo` también.

#### P2-2 · Cualquier no-VIEWER edita/completa/cancela tareas y oportunidades ajenas y falsea autoría y fechas (los KPIs del equipo)
- **Dónde:** policies `tasks_update` / `opportunities_update` = `can_write()` sin filtro por dueño (0004:51-66). En código: `completeTask` (`lib/actions/tasks.ts:48-53`) y `cancelTask` (`:95-99`) no chequean `assigned_to`; `createTask` acepta `assigned_to` del form (`:26`); `moveOpportunityStage`/`updateOpportunityMeta`/`markLost` (`lib/actions/opportunities.ts:61,79,123`) ni siquiera leen la sesión. Por PostgREST además se puede escribir `created_by`, `assigned_to`, `completed_at` (el trigger `tasks_transition` 0003:207 hace `coalesce(new.completed_at, now())` → se puede backdatear) y `owner_id` de oportunidades.
- **Impacto:** el cron de asistencia (`app/api/sync/asistencia/route.ts:105-125`) y `/panel`/`/equipo` cuentan `activities.created_by`, `tasks.created_by`, `tasks.completed_at`. Con esto se puede inflar el propio número o "cargarle" trabajo a otro. `activities` ya quedó bien en 0051 (lista blanca + autor); `tasks`/`opportunities`/`events` no.
- **Fix (una función, dos triggers):**
  ```sql
  create or replace function autoria_guard() returns trigger
  language plpgsql security definer set search_path = public as $$
  begin
    if is_system() then return new; end if;
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();          -- la autoría la pone la base
      new.is_demo := false;
      if tg_table_name = 'tasks' then new.completed_at := null; end if;
      return new;
    end if;
    if new.created_by is distinct from old.created_by
       or new.is_demo is distinct from old.is_demo then
      raise exception 'created_by e is_demo los fija el sistema';
    end if;
    return new;
  end $$;
  revoke execute on function autoria_guard() from public, anon, authenticated;
  create trigger tasks_autoria_guard_trg  before insert or update on tasks  for each row execute function autoria_guard();
  create trigger events_autoria_guard_trg before insert or update on events for each row execute function autoria_guard();
  -- activities: mismo INSERT (created_by := auth.uid()) dentro de activities_set_sync_key() (0051:75)
  ```
  Si además se quiere que solo el asignado o un manager complete/cancele: `create policy tasks_update ... using (can_write() and (assigned_to = auth.uid() or created_by = auth.uid() or is_manager()))`. Es decisión de producto (hoy Pancho reasigna tareas desde el panel).

#### P2-3 · Cualquier no-VIEWER borra cualquier evento (con sus asistentes)
- **Dónde:** policy `events_delete` = `can_write()` (0035:39); `borrarEvento` (`lib/actions/events.ts:103-110`) no lee sesión ni autor. 0051 cerró el UPDATE al autor (`0051:225-228`) pero el DELETE quedó abierto; `event_attendees` cascade.
- **Fix:**
  ```sql
  drop policy if exists events_delete on events;
  create policy events_delete on events for delete to authenticated
    using (can_write() and (created_by = auth.uid() or is_manager()));
  ```

#### P2-4 · `profiles.activo = false` no le saca permisos a nadie
- **Dónde:** `current_rol()` (0003:4-7) lee `rol` sin mirar `activo`; `can_write()`/`is_manager()` derivan de ahí. `activo` solo lo usa `default_sales_owner()` (0021:17) y el cron de asistencia. Dar de baja en la allowlist tampoco echa (documentado, 0031:20-21). O sea: la única baja real es borrar el usuario en Supabase Auth (`scripts/remove-itzel.ts`).
- **Fix (una línea):**
  ```sql
  create or replace function current_rol() returns user_role
  language sql stable security definer set search_path = public as $$
    select rol from profiles where id = auth.uid() and activo
  $$;
  ```
  Con eso un inactivo queda como "sin rol": no escribe, no es manager, no invoca agentes (`lib/ai/guard.ts:69` ya rechaza `!profile`). Sigue leyendo por `using (true)` hasta que se borre el usuario.

#### P2-5 · Cookies de sesión sin `Secure`
- **Dónde:** `lib/supabase/server.ts:6-25` y `proxy.ts:7-25` usan `createServerClient` sin `cookieOptions`. Defaults de `@supabase/ssr` 0.12.4 (`node_modules/@supabase/ssr/dist/main/utils/constants.js`): `path=/`, `sameSite=lax`, `httpOnly=false`, `maxAge=400d`; **no hay `secure`** en ningún lado del paquete.
- **Contexto:** `httpOnly:false` es deliberado del paquete (el cliente browser lee la cookie) — implica que cualquier XSS es robo de sesión; no encontré sinks XSS (ver §4). `SameSite=Lax` es correcto. Vercel agrega HSTS por defecto, así que el `Secure` faltante es defensa en profundidad, no agujero abierto.
- **Fix:**
  ```ts
  // lib/supabase/server.ts y proxy.ts, tercer argumento de createServerClient
  { cookieOptions: { secure: process.env.NODE_ENV === "production" }, cookies: { ... } }
  ```

#### P2-6 · Token del webhook en la query string (`?k=`)
- **Dónde:** `app/api/webhooks/periskope/route.ts:92-97` acepta `?k=` o header `x-webhook-token`; `docs/WHATSAPP_PERISKOPE.md:66,74` indica configurar la URL **con** `?k=`. Las URLs completas quedan en los logs de request de Vercel (y en cualquier log drain).
- **Impacto acotado:** con el token se escribe `wa_conversations` (service role, `:191-193`): se puede llenar "esperando respuesta" de basura, vincular chats al doctor equivocado (ver P3-4) o pisar `chat_name`. No da lectura de nada.
- **Fix:** si la consola de Periskope permite headers, mover el token a `x-webhook-token` y documentarlo; si no, aceptar el costo y rotar `PERISKOPE_WEBHOOK_SECRET` cuando el webhook empiece a andar de verdad (hoy no llegó ni un evento, `:5-17`). Y sacar `?k=` del `console.log` implícito: hoy no se loguea la URL desde el código, es solo el access log de Vercel.

#### P2-7 · Sin headers de seguridad
- **Dónde:** `next.config.ts` vacío; `vercel.json` solo crons; no hay `headers()` en ningún lado (grep de `X-Frame`, `Content-Security`, `Strict-Transport` = 0).
- **Qué importa:** clickjacking (la app es toda formularios con sesión) y `nosniff`. HSTS lo pone Vercel. CSP completa sería sobreingeniería para una app interna con `next-themes` y estilos inline; `frame-ancestors` alcanza.
- **Fix:**
  ```ts
  // next.config.ts
  const nextConfig: NextConfig = {
    async headers() {
      return [{
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      }];
    },
  };
  ```

### P3

- **P3-1 · `CRON_SECRET` comparado con `!==`** en 7 rutas (`app/api/sync/{noloco:50,actividades:29,alerta:34,asistencia:47,calendar:30,render:39,pagos:68}/route.ts`, `app/api/ai/brief/cron/route.ts:28`) vs `timingSafeEqual` en el webhook (`periskope/route.ts:54-59`). Un timing attack sobre 64 hex por HTTPS no es práctico; el valor real del fix es **un solo helper** en vez de 8 copias:
  ```ts
  // lib/server/cron-auth.ts
  import "server-only";
  import { timingSafeEqual } from "node:crypto";
  export function cronAuthorized(req: Request): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) return false;
    const a = Buffer.from(req.headers.get("authorization") ?? "");
    const b = Buffer.from(`Bearer ${secret}`);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  ```
- **P3-2 · `SUPABASE_SERVICE_ROLE_KEY` se instancia en 9 lugares** (los 7 sync + webhook + `lib/ai/db.ts:16`), y `server-only` no se importa en ningún archivo del repo. Hoy nada de eso llega al bundle cliente: los `"use client"` de `components/ai/*` importan solo `type` de `lib/ai/types` (verificado), y `lib/ai/db.ts` lo importan `app/(app)/ajustes/page.tsx:24` (server component), `lib/actions/ai.ts:9` (`"use server"`) y la capa AI. Fix: `lib/supabase/service.ts` con `import "server-only"` y que los 9 usen eso; agregar `import "server-only"` también a `lib/ai/db.ts` y `lib/supabase/server.ts`.
- **P3-3 · `profiles.last_seen_at` lo puede escribir el propio usuario** (policy `profiles_update_own` 0004:106; `profiles_guard` 0004:112 solo protege `rol`). `team_signins()` (0050:50) y el cron de asistencia lo usan como "entró hoy". Fix: en `profiles_guard`, `if not is_system() and new.last_seen_at is distinct from old.last_seen_at then new.last_seen_at := old.last_seen_at; end if;` (touch_last_seen es SECURITY DEFINER pero corre con `auth.uid()` → conviene que setee `app.system` o comparar por `current_user`; lo más simple: que `touch_last_seen()` haga `perform set_config('app.system','on',true)` antes del update).
- **P3-4 · Inyección de filtro PostgREST en el webhook**: `periskope/route.ts:163` interpola `last10` (deriva de `chat_id`, controlado por quien tenga el token) en `.or(\`phone.ilike.%${last10}%,whatsapp.ilike.%${last10}%\`)`. Una coma en `chat_id` agrega un filtro y vincula el chat a otro doctor. Fix: `const tel = esGrupo ? null : (chatId.replace(/@.*/, "").replace(/\D/g, "") || null);` (línea 137).
- **P3-5 · Logs con PII / identificadores**: `periskope/route.ts:199-200` loguea `chat=<teléfono>@c.us`; `app/api/sync/pagos/route.ts:46` imprime el texto del aviso (nombres de doctores y montos) si falta el webhook; `app/api/sync/actividades/route.ts:76` mete `INTRANET_EMAIL` en `errores` → `sync_runs.log` (legible por todo autenticado) y en la respuesta HTTP. Ningún log imprime contraseñas ni tokens (verificado en `lib/actividades-sync.ts:170-177`, `lib/noloco-sync.ts:82-92`, `lib/alerta-rechazos.ts:46-58`). Fix: loguear `chat.slice(-4)` y sacar el mail del mensaje de error.
- **P3-6 · Sin rate limit en `/api/ai/*`** más allá del tope diario en USD (`lib/ai/guard.ts:97-111`, default 25). Un usuario con rol puede quemar el presupuesto del día en minutos y dejar sin brief al resto. Login: lo limita Supabase Auth (rate limit por IP en `/token`); no hay lockout por cuenta. Aceptable para 3 usuarios; documentarlo.
- **P3-7 · Webhook sin monotonicidad**: `periskope/route.ts:182` pisa `last_message_at`/`last_message_body` con lo que venga; un evento viejo reentregado retrocede el estado y `wa_conv_unanswered` (0041:152) recalcula sobre el mensaje viejo. Fix: `if (prev?.last_message_at && isoDe(msg.timestamp) < prev.last_message_at) return ok`. Tamaño de body: lo acota Vercel (4.5 MB); `body` se recorta a 2000 (`:84,139`). Malformado: 400/200-ignorado, correcto.
- **P3-8 · `resolved_by` / `decided_by` / `assigned_to` no se fuerzan a `auth.uid()`**: `alerts_guard` (0030:39-45) y `ai_recommendations_guard` (0030:61-67) los dejan editables sin atarlos al usuario; por PostgREST se puede firmar una decisión como otro. Las server actions (`lib/actions/alerts.ts:17`, `lib/actions/ai.ts:89`) sí ponen `user.id`. Fix igual al patrón de 0051:133-134 / 0029:104: en el guard, `new.resolved_by := auth.uid()` cuando cambia `status`.
- **P3-9 · `/login?error=` refleja texto arbitrario** (`app/login/page.tsx:11,48-50`). React escapa → no es XSS; es inyección de texto para phishing (`/login?error=Tu%20cuenta%20venció,%20escribí%20a%20…`). `signIn` siempre manda un mensaje fijo (`lib/actions/auth.ts:12`). Fix: `const error = params.error ? "Email o contraseña incorrectos" : null`.
- **P3-10 · Directorios fantasma vacíos** `lib/actions 2`, `lib/ai 2`, `lib/supabase 2`, `app/(app) 2`, `app/api 2` (artefactos de Finder del 25/8, sin trackear). Inofensivos hoy; si alguien copia un `route.ts` ahí, Next lo sirve bajo `/api%202/…`, fuera de la exclusión del proxy (pediría sesión igual). Borrarlos.
- **P3-11 · `scripts/configurar-sync-vercel.sh:48-51`** deja la respuesta del sync (nombres de doctores) en `/tmp/sync-test.json`. Trivial.

---

## 2. Autenticación y sesión

| Tema | Estado | Referencia |
|---|---|---|
| Login | `signInWithPassword` en server action; redirect fijo a `/hoy` o `/login?error=<msg fijo>` | `lib/actions/auth.ts:6-15` |
| Open redirect | **No hay**: ni `signIn` ni `proxy.ts` aceptan `next`/`returnTo` | `auth.ts:12,14`, `proxy.ts:33-42` |
| Refresh | `proxy.ts` usa `getUser()` (valida contra Auth server, no `getSession()`), reescribe cookies en `setAll` | `proxy.ts:28-31` |
| Cookies | `@supabase/ssr` defaults: `SameSite=Lax`, `httpOnly=false` (por diseño del paquete), `maxAge=400d`, **sin `Secure`** → P2-5 | `constants.js` del paquete |
| Logout | `signOut()` sin scope = `global` → revoca todos los refresh tokens del usuario | `auth.ts:17-21` |
| Protección de rutas | Matcher excluye `_next/static`, `_next/image`, `favicon.ico`, `api/sync/*`, `api/ai/brief/cron`, `api/webhooks/*`, imágenes. **No queda ninguna otra ruta sin sesión**: `app/api/ai/{analyze,ask,brief}` pasan por el proxy Y además chequean adentro (`requireAgentInvoker`/`requireSession`, `lib/ai/guard.ts:55-114`). `app/(app)/layout.tsx:13-17` vuelve a validar (defensa en profundidad). `app/page.tsx` redirige a `/hoy`. | `proxy.ts:46-53` |
| Rutas sin proxy | `/api/sync/*` y `/api/ai/brief/cron`: `Bearer CRON_SECRET`. `/api/webhooks/periskope`: token propio timing-safe. Todas responden 503 si falta la env (apagado explícito) | ver §5 |
| CSRF en server actions | Lo cubre Next (chequeo Origin/Host built-in). Los GET de cron no usan cookie → no hay CSRF | — |
| Sesiones concurrentes | Permitidas (default Supabase). No hay listado/revocación en la UI: la única baja efectiva es borrar el usuario en Auth (ver P2-4) | — |
| Expiración | JWT 1 h (default) + refresh token sin expiración (default Supabase; el time-box de sesiones es opción del panel). La cookie dura 400 días | — |
| Fuerza bruta | Rate limit de Supabase Auth por IP; sin lockout por cuenta; sin captcha. Aceptable para invite-only | — |
| Alta de usuarios | `disable_signup` (panel) + allowlist (0031) + rol solo desde `app_metadata` (0031:204-211, el cliente no puede setearlo). Escape cuando la lista está vacía (0031:187-201). Ver P1-2 | — |
| Reset de contraseña | No hay flujo en la app (solo `scripts/reset-password.ts`, que no imprime la clave salvo cuando la genera, `:98-108`). `/auth/v1/recover` de Supabase sigue disponible con la anon key: manda mail a un usuario existente; el link no tiene handler en la app → inerte | — |

## 3. Autorización (RBAC)

Modelo: 6 roles (`user_role`). En la base solo existen tres "clases": `is_manager()` = ADMIN/COUNTRY_MANAGER/SALES_MANAGER (0003:9), `can_write()` = cualquier rol ≠ VIEWER con perfil (0004:43), y `is_system()` = sin `auth.uid()` (service role) o `app.system=on` (0019:726). **SALES y CLINICAL son idénticos para la base**; la diferencia es solo visual.

### 3.1 Qué puede un VIEWER llamando las actions/endpoints directamente
- **Lee todo** (policy `using (true)` en 30 tablas, 0004:36 y siguientes): doctores con teléfono, pagos, pacientes, `wa_conversations` con último mensaje, `agent_runs.result`, `doctor_ai_profile` (objeciones, malas experiencias), `sync_runs.log`, `audit_log`. Única excepción: `auth_allowlist` (0031:118) y `alerta_rechazos_estado` (0037, sin policy).
- **No escribe** en ninguna tabla CRM (`can_write()` false) salvo: su propia fila de `profiles` (nombre, `periskope_org_phone`, `last_seen_at`), `saved_views` propias, `pendientes` (NO: `pendientes_insert` exige `can_write()`, 0039:64).
- **RPC**: puede ejecutar los agregados `ai_*`, `evento_roi`, `doctores_efemerides`, `case_subject_review_queue`, `touch_last_seen`, `wa_requiere_respuesta` (lectura). `recompute_all`/`evaluate_automations`/`purge_demo` tienen guard interno de manager (0005:396, 0047:32, 0006:284) → excepción. `team_signins` → excepción (0034:21-24). `wa_marcar_respondido` → excepción (0041:189).
- **/api/ai/***: 403 en todos, incluido el GET del brief (`guard.ts:69`).
- Las server actions le devuelven `{error: "tu rol no tiene permisos"}` porque RLS devuelve 0 filas (patrón `.select("id")` + `!data?.length`), o `42501` en inserts.

### 3.2 Tabla por server action

| Action (archivo:línea) | Chequeo en código | Lo que hace cumplir la base | Nota |
|---|---|---|---|
| `auth.ts` signIn/signOut :6/:17 | — | Supabase Auth | — |
| `admin.ts` recalcularScores :25, ejecutarAutomatizaciones :33, purgarDemo :41 | rol manager (`managerClient` :8-23) | guard interno en la RPC (0005:396 / 0047:32 / 0006:284) | doble candado, OK. Errores solo a `console.error` |
| `admin.ts` toggleRegla :49 | rol manager | `automation_rules_update` is_manager (0004:147) | OK |
| `admin.ts` guardarObjetivo :62 | rol manager + whitelist de métrica | `goals_*` is_manager (0004:130-143) | OK |
| `allowlist.ts` invitarMail :50 / revocarInvitacion :92 | rol manager (:21-38) | `auth_allowlist_write` is_manager (0031:122) | OK |
| `alerts.ts` resolveAlert/dismissAlert :30/:34 | sesión | `alerts_update` can_write + guard lista blanca (0030:36) | `resolved_by` no atado a uid (P3-8) |
| `doctors.ts` updateDoctorContact :6 / updateDoctorRedes :61 / updateDoctorObservaciones :115 | ninguno (ni sesión) | `doctors_update` can_write + `doctors_guard` (0019:657) | cualquier no-VIEWER edita cualquier doctor: decisión de producto |
| `journey.ts` moveAcquisitionStage :21 / moveActivationStage :38 / updateProspectProfile :101 | ninguno | RLS + `doctors_guard` + `doctors_journey_sync` (0015:140) | ídem |
| `journey.ts` createProspect :54 | lee sesión pero no la exige (`owner_id: user?.id ?? null`) | `doctors_insert` can_write; guard limpia scores/universo en INSERT (0019:663-680) | OK |
| `journey.ts` acreditarDoctor :149 | sesión | RLS doctors + activities + tasks (cierra tareas de la regla) | OK |
| `activities.ts` logActivity :6 | sesión; `created_by = user.id` | `activities_insert` can_write | por PostgREST `created_by` es libre (P2-2) |
| `activities.ts` editarActividad :67 | sesión + uuid + topes | `activities_edicion_guard` (0051:110): solo texto, solo autor, audit | **bien resuelto** |
| `tasks.ts` createTask :12 | sesión | `tasks_insert` can_write | `assigned_to` viene del form (:26) |
| `tasks.ts` completeTask :38 / cancelTask :92 | sesión / ninguno | `tasks_update` can_write **sin filtro de dueño** | P2-2 |
| `pendientes.ts` crear/toggle/editar/borrar :26-138 | sesión + topes | policies `user_id = auth.uid()` (0039:63-70) | **bien resuelto** |
| `ai.ts` acceptRecommendation :60 / dismissRecommendation :257 | rol ≠ VIEWER (:36-53); claim atómico `.eq("status","propuesta")` | `ai_recommendations_update` can_write + guard lista blanca (0030:58); escrituras CRM con sesión; solo `doctor_ai_profile` por service role tras el chequeo | OK. `decided_by` no atado (P3-8) |
| `events.ts` crearEvento :57 | sesión | `events_insert` can_write | `created_by` libre por PostgREST |
| `events.ts` borrarEvento :103 | **ninguno** | `events_delete` can_write (0035:39) | **P2-3**: cualquiera borra el evento de cualquiera |
| `events.ts` actualizarNotasEvento :142 | sesión + tope | `events_update` autor (0051:226) + `events_guard` solo `notas` (0051:236) | **bien resuelto** |
| `opportunities.ts` createOpportunity :32 | sesión | `opportunities_insert` can_write | — |
| `opportunities.ts` moveOpportunityStage :61 / updateOpportunityMeta :79 / markLost :123 | ninguno | `opportunities_update` can_write sin dueño; `opportunities_transition` deriva probability | P2-2: `owner_id` editable por cualquiera (se audita, 0003:188) |
| `quality.ts` classifyCaseSubject :71 / classifyActivity :111 / reviewServiceAlert :161 | rol ≠ VIEWER (:47-63) + uuid + whitelists | `cases_update_subject` + `cases_subject_guard` (0024/0029), `activities_engagement_guard`, `alerts_guard` | OK. Devuelven `void`, errores a consola |
| `search.ts` searchAll :13 | sanitiza `,()%\` | RLS select | VIEWER busca (por diseño) |
| `team.ts` guardarMetasComercial :24 | rol manager (:31-38) | `goals_*` is_manager | OK (tira `throw`) |
| `team.ts` setLineaPeriskope :83 | formato | `profiles_update_own` (propia o manager, 0004:106) + check 0041:46 | OK |
| `viabilidad.ts` registrarViabilidad :25 | whitelist estado | `opportunities_update` can_write | sin dueño (P2-2) |
| `whatsapp.ts` marcarRespondido :12 | — | RPC `wa_marcar_respondido` valida sesión + can_write adentro (0041:186-191) | OK |

### 3.3 Respuestas puntuales
- **¿Un SALES puede cambiar `owner_id`/`clinical_owner_id`/`categoria`/`potential_override`?** No: `doctors_guard` 0019:713-721 → excepción. **¿`lifecycle_stage`/`acquisition_stage`/`activation_stage`?** Sí, tanto por kanban como por PATCH directo; `doctors_journey_sync` deriva efectos pero no valida transiciones (0015:140-215). Es el diseño ("mover en el pipeline"). **¿`is_accredited`/`accredited_at`/`noloco_id`?** No (0019:706-712). **¿`is_demo`?** Sí → P2-1. **¿`tags`, `observaciones`, `phone`, `email`?** Sí (por diseño).
- **¿Se pueden editar tareas/pendientes/actividades de otro?** Tareas: sí (P2-2). Pendientes: no (0039). Actividades: solo la clasificación de calidad (a propósito); el texto solo el autor (0051). Eventos: notas solo el autor, pero **borrar** cualquiera (P2-3). Oportunidades: sí (P2-2).
- **¿Quién puede borrar?** `is_manager()`: doctors, contacts, opportunities, activities, tasks, segments, goals, campaigns, custom_field_defs, auth_allowlist (+ `saved_views`/`pendientes` ajenos). `can_write()` (cualquier no-VIEWER): **events, event_attendees, calendar_events**. Nadie desde cliente: cases, payments, audit_log, sync_runs, score_snapshots, wa_*, agent_runs, ai_recommendations, doctor_ai_profile, automation_rules, alerts, profiles.
- **¿Allowlist + toggle cubren el alta?** Sí, en conjunto (0031 corre en AFTER INSERT de `auth.users`, también para `auth.admin.createUser` e invitaciones). Residuales: escape con lista vacía; mail invitado y no creado (P1-2); baja de la allowlist no revoca, y `activo=false` tampoco (P2-4).
- **¿`admin.ts` chequea rol?** Sí, las 5 (`managerClient`), y además la base lo vuelve a chequear. 

## 4. Inyección, XSS, SSRF

- **PostgREST `.or()`**: `lib/actions/search.ts:15` limpia `, ( ) % \` antes de interpolar (:24,:29,:34). Residual inofensivo: `*` y `_` son wildcards de PostgREST/`like` (amplían el match; no cambian columnas) y una `"` suelta puede dar 400 en esa búsqueda. `app/(app)/pipeline/page.tsx:83` interpola `monthStartISO` calculado en servidor. `prospeccion/page.tsx:102` y `dashboard/page.tsx:171` son literales. **Único punto con input externo sin sanitizar: `periskope/route.ts:163` (P3-4).**
- **`.ilike(col, \`%${q}%\`)`** en `casos/page.tsx:60`, `prospeccion/lista/page.tsx:82`, `doctores/page.tsx:145`: el valor viaja URL-encoded por el builder, no por la gramática de filtros → solo wildcards. `lib/ai/tools/read.ts:964` además limpia `%_,()`.
- **`.rpc()`**: nombres fijos en todos los llamadores (`admin.ts`, `whatsapp.ts`, `layout.tsx:24`, `panel:109`, `hoy:210`, `equipo:88`, `calidad:119`, `reportes:258`, `forecast.ts:54`, `read.ts:93` con `fn` constante por tool). Args tipados por JSON → no hay inyección. Args de las tools de la IA: los handlers acotan (`clampLimit`, `sanitized`); el runner valida con zod solo `emit` (`runner.ts:131-145,314`).
- **plpgsql dinámico**: `execute format()` solo en 0002:385 y 0004:21-62/131-139 con `%I` sobre listas fijas de tablas. Los demás `format()` (0005/0006/0016/0019/0020/0043/0044/0047) arman **texto** de alertas con `%s`, no SQL. `search_path` fijado en todas las SECURITY DEFINER (0019 §4 cerró la última).
- **XSS**: 0 `dangerouslySetInnerHTML` (grep en app/components/lib). La salida del modelo se renderiza como texto (`components/ai/ask-crm.tsx:136`, `morning-brief.tsx:146`, `recommendation-card.tsx:205`); no hay librería de markdown en `package.json`. Links con datos: `instagram.com/${doctor.instagram}` protegido por el CHECK `^[a-z0-9._]{1,30}$` (0036:25) y normalizado en `doctors.ts:41-51`; `linkRed()` (`doctores/[id]/page.tsx:66-68`) solo deja pasar `http(s)://` o antepone el host → `javascript:` imposible; `waLink`/`telLink` solo dígitos (`lib/phone.ts:61-92`); `periskopeLink` con `encodeURIComponent` (`:19-22`); tags `ig-alt:` van con prefijo `instagram.com/` (`page.tsx:491`).
- **SSRF**: todos los `fetch` van a constantes o envs: `NOLOCO_API`, `API_V2`, `INTRANET`, `CALENDAR_URL*`, `PLANILLA_MX_URL`, `SLACK_WEBHOOK_*` (validados con `startsWith("https://hooks.slack.com/")` en `alerta:47`, `asistencia:53`, `pagos:42`). Ninguna URL sale de la base ni del usuario. `pagos-planilla.ts:188` y `calendar-sync.ts:142` mandan el secreto en query string hacia Apps Script — es como funciona GAS; queda en logs de Google, no nuestros.

## 5. Webhooks y cron

- **Verificación**: cron = `Bearer CRON_SECRET` (Vercel lo agrega solo); webhook = token propio en `?k=`/header con `timingSafeEqual` (`periskope/route.ts:54-59`). Con el secreto, cualquiera dispara: syncs (escriben datos legítimos de Noloco/planilla), `alerta`/`asistencia?forzar=1` (spam a Slack), `brief/cron` (gasta presupuesto AI hasta el tope). Exposición del secreto = costo/ruido, no lectura de datos.
- **Idempotencia**: noloco (upsert + gate anti-regresión, `noloco/route.ts:75-87`), pagos (`external_key`), actividades (`sync_key` congelada, 0051:55-97), alerta (estado en tabla), webhook (upsert por `periskope_chat_id`, sin monotonicidad → P3-7). Duplicados y reintentos: OK salvo lo anterior.
- **Body**: JSON parse con 400 (`:99-104`); `data` string re-parseado; `body` recortado a 2000 (`:139`). Límite de tamaño lo pone Vercel.
- **PII en logs**: `:199-200` (teléfono en `chat=`), ver P3-5.
- **Rate limiting**: ninguno propio; ver P3-6.

## 6. Exposición de datos (tablas legibles por cualquier autenticado)

Con `using (true)` para SELECT: profiles, campaigns, doctors, contacts, cases, payments, opportunities, automation_rules, alerts, tasks, activities, **audit_log**, score_snapshots, segments, saved_views, goals, custom_field_defs, **wa_conversations** (con `last_message_body`), wa_messages, **sync_runs** (con `log`), cohort_intervals, **ai_recommendations, doctor_ai_profile, agent_runs, agent_handoffs**, commercial_offers, events, event_attendees, pendientes, calendar_events.

Cerradas: `auth_allowlist` (manager), `alerta_rechazos_estado` (sin policy → nadie), `ops.*` (service role).

Qué hay adentro que NO debería ver un VIEWER si algún día hay uno "menos de confianza":
- `sync_runs.log`: nombres de doctores adoptados/creados, `external_key paid_at $monto` por pago (`pagos-planilla.ts:250`, `ledger-reconcile.ts:158-167`), el mail del intranet en errores (`actividades/route.ts:76`). **No hay contraseñas ni tokens** (verificado en todos los `log()`).
- `agent_runs`: `tools_called` (args + filas devueltas) y `result` (brief completo). `lib/ai/pii.ts` saca teléfonos y nombres de paciente del prompt; los nombres de doctor se quedan a propósito. La pregunta libre de Ask CRM **no se persiste** (solo `result.answer`, `runner.ts:410`).
- `doctor_ai_profile`: `known_objections`, `previous_bad_experiences`, `relationship_notes`.
- `audit_log`: desde 0051 guarda el texto viejo/nuevo de cada nota corregida.

Recomendación mínima si entra un cuarto usuario: `sync_runs` y `agent_runs` a `is_manager()` (una policy cada una); el resto es la decisión de transparencia de Pancho (8/8).

## 7. Headers

Ver P2-7. Vercel agrega HSTS. CORS: ninguna ruta setea `Access-Control-*` → el browser bloquea cross-origin, correcto. `NEXT_PUBLIC_SUPABASE_ANON_KEY` es pública por diseño (RLS + `disable_signup` son el control).

## 8. Logs con info sensible (grep de `console.*` en app/ y lib/)

| Archivo:línea | Qué imprime | Sensible |
|---|---|---|
| `app/api/webhooks/periskope/route.ts:199` | `chat=<tel>@c.us linea=<línea> from_me body=<largo>` | teléfono (PII) |
| `app/api/webhooks/periskope/route.ts:123` | nombres de campos del evento | no |
| `app/api/webhooks/periskope/route.ts:195` | mensaje de error de PostgREST | no |
| `app/api/sync/pagos/route.ts:46` | texto completo del aviso Slack (doctores, montos) si falta webhook | PII comercial |
| `lib/actions/quality.ts:75-198` | uuids, valores de enum, mensajes de RLS | no |
| `lib/actions/admin.ts:29-86`, `alerts.ts:21` | mensajes de error | no |
| Ninguno imprime env vars, tokens ni contraseñas. `scripts/create-users.ts:91` imprime la contraseña inicial (es su función; corre local). |

Además, los `logs` de cada sync vuelven en el JSON de respuesta al que tiene `CRON_SECRET` (aceptable).

## 9. Secretos: inventario

- `.env.local`: sin trackear (`.gitignore` `.env*`), permisos `0600`. Variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, `SUPABASE_DB_HOST`, `ANTHROPIC_API_KEY`, `VERCEL_OIDC_TOKEN`, `CRON_SECRET`, `PLANILLA_MX_SECRET`, `PLANILLA_MX_URL`, `KEEPSMILING_EMAIL`, `KEEPSMILING_PASSWORD` (+ 3 comentadas de dev). `.env.local.example` solo nombres.
- Grep de `eyJ…`, `sk-ant`, `hooks.slack.com/services`, `postgres://…:…@`, `password="…"` en el repo (sin node_modules/.next): **0 hallazgos en archivos trackeados**; docs limpias. Único literal real: **P1-1**.
- `scripts/configurar-sync-vercel.sh:22-26` lee `../tracer/.env` (fuera del repo) y no imprime valores; escribe `CRON_SECRET` en `.env.local` (esperado).
- Credenciales Noloco/Intranet: solo en env; no se loguean; el mail del intranet termina en `sync_runs` (P3-5).
- Service role: 9 instanciaciones (P3-2); ninguna alcanzable desde código cliente hoy.

## 10. Lo que `scripts/security-checks.ts` ya verifica vs. lo que falta

Cubre (8 chequeos, `:63-623`): (1) ninguna SECURITY DEFINER ejecutable por anon; (2) 12 RPC devuelven 401 sin sesión + control `GET /doctors` 401; (3) `disable_signup` + conteo de cuentas; (4) allowlist rechaza ajeno y acepta invitado (detrás de `--probar-altas`, valida el mensaje del guard); (5) guards de procedencia `humano`/`ai_confirmado`/`import`; (6) autenticado sin perfil no escribe + anon no lee `payments` + forecast único; (7) grants exactos para `authenticated` (lista positiva y negativa); (8) radio de lectura de un VIEWER (FALLA por diseño mientras dure `using (true)`).

Falta (sugerencias, todas encajan en el mismo script con `comoAutenticado()` sobre un perfil degradado a SALES en transacción revertida):
- **9. Escalada horizontal como SALES**: `update doctors set is_demo=true` (debe fallar tras P2-1); `update doctors set owner_id=…` (ya falla); `delete from events where created_by<>uid` (debe fallar tras P2-3); `update tasks set completed_at='2020-01-01', created_by=<otro>` (debe fallar tras P2-2); `insert into activities(created_by=<otro>)` → la fila debe quedar con `created_by=uid`.
- **10. `activo=false` no escribe** (`can_write()` false) tras P2-4.
- **11. Estático**: `grep -rn '\.or(`' app lib` sin `${` no sanitizado; `git ls-files | grep -i LISTO` vacío; `grep -L 'server-only' lib/ai/db.ts lib/supabase/server.ts` vacío.
- **12. HTTP contra prod (HEAD /login)**: `set-cookie` con `Secure`, `x-frame-options`, `strict-transport-security` presentes.
- **13. Webhook**: POST sin token → 401; con token y `chat_id` con coma → no vincula doctor (tras P3-4).

---

## Apéndice — orden sugerido de aplicación

1. P1-1 (placeholder + gitignore; rotar si se compartió) — hoy.
2. P1-2 (correr security-checks contra prod, chequeo 3 en OK) — hoy.
3. Migración 0052 con P2-1 + P2-2 + P2-3 + P2-4 (+ P3-3, P3-8 si se quiere, mismo patrón) y sus asserts al final, como hace 0051.
4. P2-5 + P2-7 (dos archivos de config) + P3-4 (una línea) — mismo deploy.
5. P3-1/P3-2 (helpers `cron-auth` y `service`) cuando se toque la próxima ruta de sync.

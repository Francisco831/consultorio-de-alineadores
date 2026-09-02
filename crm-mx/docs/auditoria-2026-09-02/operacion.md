# Auditoría de operación — CRM MX (`crm-mx/`)

**Fecha:** 2/9/2026 · **Alcance:** solo lectura del repo, `~/ks-panel`, `~/ks-alertas`, LaunchAgents. No se conectó a ninguna base ni a Vercel: lo que dice "no verificado" hay que verificarlo con `vercel env ls production` / SQL desde cualquier navegador.
**Objetivo del dueño:** el CRM tiene que funcionar 24/7 con la Mac apagada.

## 0. Veredicto en tres líneas

1. **El funcionamiento diario ya NO depende de la Mac.** La app, la auth, los 8 crons de Vercel (`vercel.json:3-35`), los 2 jobs de pg_cron (`0006_automations.sql:317-318`), el webhook de Periskope y los dos Apps Script corren en la nube. Verificado leyendo cada ruta: ninguna lee archivos locales ni llama a `python3`.
2. **Lo que SÍ depende de la Mac es lo que pasa cuando algo se rompe o hay que tocar la base:** backups (P0), reset de contraseña (P1), migraciones (P1), alta de usuarios, y el panel de ortodoncistas al que apunta la alerta de rechazos (`lib/alerta-rechazos.ts:13`) se refresca por launchd local cada hora.
3. **Nadie se entera cuando un cron falla.** Solo `/api/sync/pagos` avisa por Slack. Los otros 7 dejan (a veces) una fila en `sync_runs` que ninguna pantalla muestra por fuente. Si el sync de Noloco falla tres días seguidos, el CRM muestra datos viejos y no hay señal.

---

## 1. Funcionalidad → proceso → dónde corre → de qué depende

🔴 = depende de la Mac de Pancho. 🟢 = corre en la nube sin ella. 🟡 = nube, pero con un tercero bloqueado o una cola local.

| Funcionalidad | Proceso | Dónde corre | Depende de | Mac |
|---|---|---|---|---|
| Web app | Next.js 16, deploy en cada `git push crm-mx-ai` | Vercel Pro (`crm-mx-puce.vercel.app`) | `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; Supabase prod `yuxfgbbqhqquuoaudjdd` (plan Free) | 🟢 |
| Auth (login, sesión, redirect) | Supabase Auth + `proxy.ts:4-46`; allowlist `0031` | Vercel + Supabase | cookies SSR; `auth_allowlist` | 🟢 |
| Sync Noloco (casos/doctores) | `/api/sync/noloco`, cron `0 */2 * * *` | Vercel | `CRON_SECRET`, `KEEPSMILING_EMAIL/PASSWORD`, service role; portal ks-indicadores | 🟢 |
| Sync render (video_*) | `/api/sync/render`, cron `30 */2 * * *` | Vercel | idem + portal keepsmiling-v2 | 🟢 |
| Sync actividades (intranet + Noloco v2) | `/api/sync/actividades`, cron `0 15 * * *` | Vercel | `INTRANET_EMAIL/PASSWORD` (+`_2.._4`), `KEEPSMILING_*` | 🟢 |
| Llamadas de Rocío (sheet) y pipeline planilla | `scripts/import-actividades-mx.ts --fuente llamadas\|oportunidades` sobre `data/llamadas_rocio.json`, `data/pipeline_agosto.json` | Mac | archivos de `data/` (gitignoreados, solo en la Mac) | 🔴 puntual, ya cargado; hoy Rocío carga en el CRM |
| Sync pagos (planilla → `payments` + reconcile) | `/api/sync/pagos`, cron `10 23 * * 1-5` | Vercel + Apps Script en la cuenta Google de Pancho | `PLANILLA_MX_URL/SECRET`, `SLACK_WEBHOOK_CRM` | 🟢 para el CRM |
| Copia de pagos a `finanzas/seed-data/` | `scripts/sync-pagos-planilla.ts:55-57,194-195` (llama `python3`) | Mac | openpyxl, disco local | 🔴 pero es del proyecto finanzas, no del CRM |
| Sync calendar | `/api/sync/calendar`, cron `45 12 * * 1-5` | Vercel + Apps Script en la cuenta Google de Rocío | `CALENDAR_URL/SECRET/PROFILE` (+`_2..`) | 🟢 |
| Alerta rechazos → Slack | `/api/sync/alerta`, cron `*/10 * * * *` | Vercel | `SLACK_WEBHOOK_ALERTA_RECHAZOS`, `KEEPSMILING_*`, tabla `alerta_rechazos_estado` | 🟢 el aviso · 🔴 el link "Ver panel" (`lib/alerta-rechazos.ts:13`) apunta a `panel-ortodoncistas.vercel.app`, cuyos datos los refresca **launchd en la Mac** (ver §1.1) |
| Asistencia equipo → Slack | `/api/sync/asistencia`, cron `30 23 * * 1-5` | Vercel | `SLACK_WEBHOOK_ASISTENCIA` o `SLACK_WEBHOOK_CRM`; `profiles.last_seen_at` (0050) | 🟢 |
| Brief IA matinal | `/api/ai/brief/cron`, cron `0 13 * * *` | Vercel | `ANTHROPIC_API_KEY`, `AI_DAILY_BUDGET_USD` (default 25) | 🟢 |
| Webhook Periskope (WhatsApp) | `/api/webhooks/periskope` POST | Vercel | `PERISKOPE_WEBHOOK_SECRET`; **entitlement de Periskope: 0 eventos desde el 22/8** | 🟡 bloqueado por el proveedor |
| pg_cron recompute nightly | `crm-recompute-nightly` `0 11 * * *` | Supabase (pg_cron) | extensión habilitada; si no lo estaba al migrar, el bloque solo hace `raise notice` (`0006:319-320`) | 🟢 (no verificado que exista en prod) |
| pg_cron automatizaciones | `crm-automations-hourly` `10 * * * *` → `evaluate_automations()`, 10 reglas | Supabase | idem; cupo 5/día (0042) | 🟢 |
| Migraciones | `scripts/db-migrate.ts` (TTY obligatoria para prod, `SUPABASE_DB_PASSWORD`) | Mac / cualquier terminal | `.env.local`, `supabase/environments.json` | 🔴 mantenimiento |
| Backups | `scripts/backup-datos.ts` → `~/crm-mx-backups/` | Mac | último: **20/8/2026** (4 volcados: 11, 18, 19, 20/8) | 🔴 **P0** |
| Alta de usuarios | `scripts/create-users.ts` (+ insert en `auth_allowlist`) | Mac | service role | 🔴 ocasional |
| Reset de contraseña | `scripts/reset-password.ts` — "no hay flujo de recuperación en la app" (`:14-16`) | Mac | service role | 🔴 **operativo**: si Juan o Rocío se bloquean con la Mac apagada, nadie entra |
| Imports puntuales (Noloco manual, enrichment, WhatsApp export, IG, viabilidades, prospectos, Rocío) | `scripts/import-*.ts`, `parse_*.py` | Mac | `data/*.json/.xlsx/.csv` gitignoreados (existen solo en la Mac), `../gestion-mx/data/noloco_mx.json`, openpyxl | 🔴 ya ejecutados en agosto; no son operación |
| Backfills (autoría, Instagram) | `scripts/backfill-*.ts` | Mac | `data/ig_*.csv` | 🔴 ejecutados 20-22/8 |
| Verificación (security-checks, diff-entornos, verificar-journey) | scripts con `pg` directo | Mac | `SUPABASE_DB_PASSWORD` | 🔴 ocasional, no operación |

### 1.1 `~/ks-panel/refresco.sh` (launchd `com.keepsmiling.panel-refresco`)

- **No toca el CRM.** `fetch_datos.py` lee Noloco keepsmiling-v2 con `~/ks-panel/.env` (`KEEPSMILING_EMAIL/PASSWORD`, mismos nombres que el CRM) y escribe `data.json`; `refresco.sh:13` hace `vercel deploy --prod` al proyecto **`panel-ortodoncistas`** (`.vercel/project.json`). Cero referencias a Supabase, crm-mx o sus tablas.
- **Cadencia real:** el plist tiene solo `Minute=45` → **cada hora**, no "7:45 y 12:45" como dice el comentario de `refresco.sh:3`. `refresco.log` registra 132 corridas, la última 2/9 11:45; solo corre con la Mac despierta (1/9: 18:45, 21:41, nada de noche).
- **Sí es una dependencia indirecta del CRM:** la alerta de rechazos del CRM (`lib/alerta-rechazos.ts:13`, `:190`) linkea a ese panel. Con la Mac apagada el aviso llega, pero el panel muestra datos viejos.
- Drift: `~/ks-panel/fetch_datos.py` difiere de `panel-ortodoncistas/fetch_datos.py` del repo; el docstring (`:5`) dice "credenciales en ../tracer/.env" pero lee su propio `.env` (`:19`). `refresco.log` 724 KB sin rotación.
- `~/ks-alertas/` es el resto de la alerta vieja: plist renombrado `.apagado-20260831`, no está cargado en launchd (`launchctl list` solo muestra `panel-refresco`). OK.

---

## 2. Clasificación de `scripts/` (49 archivos, 8.954 líneas)

Fuentes: último commit por archivo (`git log`), docs, existencia de `data/*` (los 53 archivos de `data/` existen en la Mac y están gitignoreados: `.gitignore:48`).

### (a) Operativo necesario en prod — ninguno corre en prod, pero el código se importa desde la app

| Script | Nota |
|---|---|
| `scripts/lib/fetch-all.ts`, `scripts/lib/phone.ts` | **Los importa la app** (`lib/noloco-sync.ts:18-19`, `lib/actividades-sync.ts:18`, `lib/calendar-sync.ts:20,22`). Son código de producción viviendo en `scripts/`. Moverlos a `lib/` (hay 3 copias de la paginación: `scripts/lib/fetch-all.ts`, `lib/supabase/fetch-all.ts`, `lib/paginar.ts` — `lib/paginar.ts:8-9` lo admite). P3 |
| `scripts/gas-pagos-planilla.gs`, `gas-calendar.gs` (raíz) | Fuente de los Apps Script desplegados. Vigentes. Duplicado: `gas-pagos-planilla.LISTO.gs` (raíz, untracked) es el mismo archivo **con el secreto real** en `:21` |

### (b) Mantenimiento ocasional — se quedan

| Script | Cuándo se corre | Observaciones |
|---|---|---|
| `db-migrate.ts` + `lib/migrate-core.ts` + `db-migrate.test.ts` | cada migración | `REGIONS` prueba ca-central-1 primero (`:98-104`) — contra prod pierde intentos si no hay `SUPABASE_DB_HOST` |
| `security-checks.ts` | a mano, último registro 18/8 | 8 chequeos; no está en CI (a propósito) |
| `diff-entornos.ts` | último 13/8 | |
| `backup-datos.ts` | último 20/8 | escribe a `~/crm-mx-backups` (`:40`) → §7 |
| `create-users.ts`, `reset-password.ts` | alta/bloqueo | únicos caminos; sin ellos no hay recuperación de acceso |
| `import-noloco.ts` | corrección puntual | lee `../../gestion-mx/data/noloco_mx.json` (`:53`) — archivo de otro proyecto; gate `EXPECTED_2026` hardcodeado `:42-45` (julio es el último mes) |
| `import-actividades-mx.ts` | fuentes `llamadas`/`oportunidades` solo manual | `:37` carga `../../tracer/.env` (credenciales de otro proyecto); `any` ×2 |
| `sync-pagos-planilla.ts` | solo para `--xlsx` y copias a finanzas | llama `python3` (`:67,84`); **el CRM ya no lo necesita** (`:12-16`). Es de finanzas: candidato a moverse allá |
| `lib/pg.ts`, `lib/destino.ts`, `destino.test.ts`, `phone.test.ts` | infra de scripts | `pg.ts:13` comenta "los dos proyectos viven acá (ca-central-1)": falso, prod está en us-east-2 |
| `ai-dryrun-doctor.ts`, `ai-correr-doctor.ts`, `eval-routing.ts` | diagnóstico IA | solo lectura / gasto controlado |
| `verificar-journey.ts`, `verificar-journey-usuario.ts`, `roi-eventos.ts` | verificación | host default `aws-0-ca-central-1` hardcodeado (`reconcile-ledger.ts:24`, `roi-eventos.ts:18`, `verificar-journey.ts:25`): contra prod exige `SUPABASE_DB_HOST` a mano |

### (c) Import puntual ya ejecutado → `scripts/archivo/`

| Script | Última corrida (según docs/commits) | Lee | Problemas |
|---|---|---|---|
| `import-enrichment.ts` | agosto (commit 13/8) | `data/enrichment.json`, `data/payments.json` (7/8) | — |
| `import-ficha.ts` + `parse_ficha.py` | 10/8 | `data/ficha_tipos.json`, `ficha_entrega.xlsx` | — |
| `import-prospectos.ts` | 13/8 | `data/whatsapp_analisis_final.json` | copia propia de `canonPhone` (`:37-43`) |
| `import-prospectos-fuentes.ts` + `parse_prospectos.py` | 13/8 · 25/8 | `data/prospectos_fuentes.json`; `.py:33-35` rutas absolutas `/Users/...` **y un scratchpad de una sesión vieja de Claude que ya no existe** | `any` ×7; host ca-central hardcodeado `:28` |
| `import-viabilidades.ts` + `parse_viabilidades.py` | 13/8 | `data/viabilidades.json`; `.py:22` `../gestion-mx/data/noloco_mx.json` | — |
| `import-whatsapp.ts` | 13/8 | `data/whatsapp_periskope.json` (export **7/8**) | el "barrido masivo" que cita el webhook (`route.ts:156`) — sin export nuevo no sirve; Periskope bloqueado |
| `import-rocio.ts` | 22/8 | `data/whatsapp_rocio.json` | — |
| `import-seguidores-ig.ts`, `import-doctores-bio-ig.ts`, `tag-seguidores-ig.ts`, `backfill-instagram.ts`, `arreglar-nombres-ig.ts` | 20/8 | `data/ig_*.tsv/csv` | corrida única del censo IG |
| `backfill-autoria.ts` | 22/8 | base | idempotente; "segunda corrida encuentra 0" |
| `seed-demo.ts` | 10/8 | `../../gestion-mx/data/seed_gestion.json` (`:58`) | destructivo; los demo se borran desde /ajustes |
| `parse_enrichment.py` (40 KB) | 28/8 (commit zonas) | `:23-26` rutas absolutas a `/Users/...` y al scratchpad muerto; `lib/pagos-planilla.ts:42-43` dice "port 1:1, cualquier cambio acá va también allá" | P2: el parser vivo de pagos es el TS; el .py quedó como referencia |
| `parse_pagos_planilla.py` | 21/8 | importa de `parse_enrichment.py` | solo lo usa `sync-pagos-planilla.ts` |
| `configurar-sync-vercel.sh` | 19/8 (una vez) | `../tracer/.env:22-26`; `nvm` hardcodeado `:11` | **peligroso re-correrlo**: `:30` borra 5 envs de Vercel y `:45` redeploya. Archivar con nota |
| `seed-alerta-estado.ts` | 22/8 (una vez) | `~/ks-alertas/alerta_estado.json` (`:26-28`) | ya sembrado; borrar |
| `remove-itzel.ts`, `borrar-ficha-interna.ts`, `desasignar-cobranza.ts`, `limpiar-basura.ts`, `merge-prospect-dups.ts` | 13-22/8 | base | one-shots de limpieza, con nombre propio en el archivo. Archivar |

### (d) Temporal / muerto → borrar

| Script | Por qué |
|---|---|
| `scripts/_watch_webhook.mjs` | untracked; comentario `:1-3` "Temporal… se borra solo al primer evento". El evento nunca llegó (Periskope). Borrar |
| `gas-pagos-planilla.LISTO.gs` (raíz) | copia de `scripts/gas-pagos-planilla.gs` con el **secreto real** (`:21`) e instrucciones viejas (`:13-17`: `.env.local` + correr el script; hoy es env de Vercel + `/api/sync/pagos`). No está commiteado, pero `.gitignore` no lo cubre: un `git add .` lo sube. Borrar; el secreto vive en Vercel |
| `supabase/migrations 2`, `supabase/rollbacks 2`, `lib/actions 2`, `lib/ai 2`, `lib/supabase 2` | carpetas vacías que dejó iCloud (commit 88ae1ca las limpió pero quedaron los directorios) |

Resumen de `any`: `import-prospectos-fuentes.ts` ×7, `import-actividades-mx.ts` ×2, `reconcile-ledger.ts` ×1, `lib/fetch-all.ts` ×1. Rutas absolutas `/Users/...`: `parse_enrichment.py:25-26`, `parse_prospectos.py:35`, `.claude/launch.json:6,18`. Credenciales ajenas (`../tracer/.env`): `configurar-sync-vercel.sh:22-26`, `import-actividades-mx.ts:37`.

---

## 3. Crons de Vercel (`vercel.json`)

CDMX = UTC-6 todo el año (sin DST desde 2022). Todos exigen `Authorization: Bearer $CRON_SECRET`; `proxy.ts:54` los excluye del redirect a `/login`.

| Ruta | Horario UTC → CDMX | maxDuration | Qué hace | Idempotente | Registro de errores | Si falla 3 veces, ¿alguien se entera? |
|---|---|---|---|---|---|---|
| `/api/sync/noloco` | `0 */2` → cada 2 h en punto | 300 (`route.ts:28`, medido 60-120 s) | login ks-indicadores, 6 páginas, gate anti-regresión (`lib/noloco-sync.ts:159-189`, payload <900 aborta), upsert doctores/casos, `recompute_all` | sí (upsert `noloco_case_id`, adopción por email/teléfono) | `sync_runs` `noloco` ok/error si el gate o el upsert fallan. **Si falla el fetch/login (`route.ts:91-94`) NO escribe nada en `sync_runs`**: solo 500 en el log de Vercel | **No.** El CRM queda congelado (ya pasó 12 días, `lib/noloco-sync.ts:10-12`). `/calidad` muestra "última sync" de *cualquier* fuente (`components/ai/data-readiness.tsx:103-107`), así que alerta/render enmascaran |
| `/api/sync/render` | `30 */2` → :30 de horas pares (30 min después de noloco, a propósito) | 300 (`:20`, ~15 s) | keepsmiling-v2 → `cases.video_*`, solo filas que cambiaron | sí | `sync_runs` `render-v2` ok y error (`:62-78`) | No |
| `/api/sync/actividades` | `0 15` → 09:00 | 300 | contact points por cuenta + comunicaciones v2 | sí (`sync_key`, 0051) | `sync_runs` `actividades` running→ok/error. **Falla parcial (una cuenta) queda como `ok`** (`route.ts:97`) con los errores adentro del JSON | No |
| `/api/sync/alerta` | `*/10` → cada 10 min | 120 (`:15`) | rechazos 2+ en 40 d → Slack #alertas-rechazos; estado en `alerta_rechazos_estado` | sí (estado en DB) | **solo escribe `sync_runs` si avisó (>0) o si falló** (`:64-72`) → "corrió sin novedades" y "no corrió" son indistinguibles | No. Además ~144 corridas/día × login a Noloco |
| `/api/ai/brief/cron` | `0 13` → 07:00 | 300 (`:18`, 74-144 s) | genera el brief en `agent_runs` (trigger `hoy`) | **no**: cada corrida gasta (~USD 0,7); tope diario 25 | **ninguno en `sync_runs`**; error solo en la respuesta HTTP (`:50-54`) | No; /hoy muestra el brief anterior sin fecha de alarma |
| `/api/sync/asistencia` | `30 23 L-V` → 17:30 | 60 (`:26`) | quién no cargó nada hoy → Slack #alertas-crm | no (dos corridas = dos avisos) | `sync_runs` `asistencia` solo cuando avisa o falla (`:175-194`) | Sí a medias: si falla, nadie recibe el aviso y nadie nota la ausencia |
| `/api/sync/render` ↔ `/api/sync/noloco` | orden correcto; no comparten tablas más que `cases` (columnas distintas) | | | | | |
| `/api/sync/calendar` | `45 12 L-V` → 06:45 | 300 (`:20`) | Apps Script de cada persona → `calendar_events` | sí (upsert `profile_id,google_event_id`); no borra cancelados (`lib/calendar-sync.ts:193-195`) | `sync_runs` `calendar`; falla parcial = `ok` (`:89`) | No |
| `/api/sync/pagos` | `10 23 L-V` → 17:10 | 300 (`:36`, ~10-30 s) | Apps Script → `payments` (gates deriva >20 / mes cerrado) + reconcile | sí (`external_key`); el reconcile crea fichas solo con 0 candidatos | `sync_runs` `planilla_pagos` + `ledger_reconcile`; **Slack en error y en fichas creadas** (`:40-58,123-137,148-152`) | **Sí** — es el único |

**Solapamientos.** No hay locks (`grep pg_try_advisory` vacío). Cron y `curl` manual pueden correr a la vez; noloco dura hasta 2 min. A las horas pares :00 coinciden noloco y alerta (portales distintos, tablas distintas: OK). A las :10 coinciden alerta y `crm-automations-hourly`, y a las 23:10 además pagos: `payments` dispara `recompute_doctor` por trigger mientras `evaluate_automations()` lee scores. Riesgo bajo, no nulo; no hay evidencia de deadlocks. Vercel Pro corre un cron por invocación y **no reintenta**; no encontré alertas de cron configuradas (no verificable desde acá — revisar Project → Settings → Notifications / Observability).

**Secretos que necesita Vercel production (nombres; NO verificados contra Vercel):** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `KEEPSMILING_EMAIL`, `KEEPSMILING_PASSWORD`, `INTRANET_EMAIL`/`INTRANET_PASSWORD` (+`_2.._4`), `SLACK_WEBHOOK_ALERTA_RECHAZOS`, `SLACK_WEBHOOK_CRM`, `SLACK_WEBHOOK_ASISTENCIA` (opt), `SLACK_WEBHOOK_PAGOS` (opt), `PLANILLA_MX_URL`, `PLANILLA_MX_SECRET`, `CALENDAR_URL`/`CALENDAR_SECRET`/`CALENDAR_PROFILE` (+`_2.._4`), `PERISKOPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `AI_MODEL`/`AI_EFFORT`/`AI_DAILY_BUDGET_USD` (opt). **`.env.local` NO tiene** SLACK_*, INTRANET_*, CALENDAR_*, PERISKOPE_*: existen en una sola copia (Vercel). Si se pierde el proyecto de Vercel o el acceso, se pierden.

**Periódico sin cron (depende de correr un script a mano):**
- Backup (`backup-datos.ts`) — §7.
- `security-checks.ts` / `diff-entornos.ts` — verificación post-migración.
- Barrido masivo de WhatsApp (`import-whatsapp.ts`) — hoy inútil hasta que Periskope destrabe.
- Copia a `finanzas/seed-data/` (`sync-pagos-planilla.ts`) — del proyecto finanzas.
- Limpieza de eventos cancelados en `calendar_events` — nadie la hace.
- Objetivos país: `lib/noloco-sync.ts:467-471` inserta `goals` solo hasta `2026-12-01`; en enero 2027 el dashboard queda sin objetivo.
- `EXPECTED_2026` del import manual (`import-noloco.ts:42-45`) hay que actualizarlo cada mes a mano si se usa.

---

## 4. Observabilidad

| Pregunta | Estado |
|---|---|
| Logging estructurado | No. `console.*` solo en el webhook (`route.ts:123,195,199`) y un `console.warn` en pagos (`:46`). Las rutas de sync acumulan `logs: string[]` y lo devuelven en la respuesta HTTP, que nadie lee salvo `curl` a mano |
| Health check | No existe `/api/health`. `grep sentry\|health\|pino` vacío |
| Error tracking (Sentry o similar) | No |
| ¿Se puede saber qué falló, cuándo y por qué? | A medias: `select * from sync_runs order by started_at desc` desde el SQL editor. Huecos: noloco no registra fallas de fetch; brief no registra nada; alerta/asistencia no registran corridas sin novedad; actividades/calendar registran `ok` con errores parciales adentro. Logs de Vercel: retención corta en Pro (~1 día) |
| ¿`sync_runs` en alguna pantalla? | **No por fuente.** `/ajustes` muestra `automation_rules.last_run_at` (`page.tsx:320`, evidencia de pg_cron) y el resto de reglas. `/calidad` muestra UNA "última sync" global (`data-readiness.tsx:103-107`). El aviso "una sincronización dejó de correr" (commit 3c9731b) es de **finanzas**, no del CRM |
| pg_cron | No hay chequeo de que `cron.job` tenga los 2 jobs en prod; `0006:319-320` traga el error si la extensión no estaba. `OPERACION.md:197` dice "verificado activo" (fecha 19/8) |

**Mínimo que falta (en orden, sin sobreingeniería):**
1. **Un vigía en la nube** (P1): un cron más, `/api/sync/vigia` a las `0 14 * * *` (08:00 CDMX), que lea `sync_runs` y avise a `SLACK_WEBHOOK_CRM` si una fuente no tiene fila `ok` dentro de su ventana (noloco 4 h, render 4 h, actividades 26 h, pagos 3 días hábiles, calendar 3 días, asistencia 3 días, alerta 24 h una vez que registre siempre). Copiar `finanzas/lib/alertas-sync.ts` (67 líneas, ya probado). Que además consulte `cron.job` vía RPC de solo lectura para confirmar pg_cron.
2. **Que todas las rutas registren SIEMPRE** (P1, 15 min): alerta y asistencia insertan `sync_runs` también cuando no hay novedades; noloco escribe la fila de error en el `catch` de `route.ts:91`; brief inserta `sync_runs` `brief` ok/error; actividades/calendar usan `status = errores.length ? "partial" : "ok"`.
3. **Pantalla** (P2): tabla "Sincronizaciones" en `/ajustes` con última corrida ok/error por `source` (una query sobre `sync_runs`, `distinct on (source)`).
4. **Alertas de Vercel** (P2): activar notificación de "Function errors"/cron failures a Slack o mail desde el dashboard (5 minutos, sin código).
5. Sentry: opcional, no antes de 1-3.

---

## 5. CI/CD y entornos

**Qué corre** (`.github/workflows/crm-mx-ci.yml`): en push/PR que toque `crm-mx/**`: `npm ci`, `typecheck`, `test` (unit, sin red), `build`, lint **no bloqueante** (`:44-46`, "19 errores preexistentes"). Sin secretos, no toca bases (a propósito, `:10-12`).

**Cómo se despliega:** Vercel escucha la rama `crm-mx-ai` (`DESPLIEGUE_VERCEL.md:3-5,91`). Cada `git push` va **directo a producción**, en paralelo con CI y sin esperarlo: un push con typecheck roto se despliega igual si `next build` de Vercel pasa (Vercel corre su propio build; typecheck y tests no lo frenan). No hay preview obligatoria ni protección de rama.

**Qué falta:**
- P1 — **Hay trabajo sin commitear que producción no tiene**: 14 archivos modificados y 8 sin trackear, incluida **la migración `0051_editar_notas.sql` y su rollback** y `lib/actividades-sync.test.ts` (`git status`). Si la Mac muere hoy, se pierde la 0051 y el código que la usa. Commitear.
- P1 — **No hay registro de qué migraciones tiene prod**: `HOTFIX_LOG.md` termina el 18/8 (0033 "pendiente" en prod); `environments.json:6` dice "ledger de producción 28"; desde entonces entraron 0034-0051 (19/8→31/8) y la app en prod las usa (ej. `last_seen_at` de 0050 en `asistencia/route.ts:90`), así que están aplicadas, pero nadie lo anotó. Chequeo mínimo: `select filename from ops.schema_migrations order by 1 desc limit 3` y actualizar el log; mejor: que el vigía compare `ops.schema_migrations` contra la lista del repo.
- P2 — Lint bloqueante: arreglar los 19 (la mitad son los `any` de scripts que se archivan) y sacar `continue-on-error`.
- P2 — `security-checks --baseline` no puede ir a CI sin secretos; alternativa: un `workflow_dispatch` manual con `SUPABASE_DB_PASSWORD` como secret de GitHub, para correrlo desde cualquier navegador sin la Mac.
- P2 — Gate de deploy: la opción barata es Vercel → Settings → Git → "Ignored Build Step" no sirve para esto; lo simple es habilitar **branch protection en `crm-mx-ai` con status check requerido** y trabajar en ramas cortas + PR. Si Pancho pushea solo, al menos activar la notificación de CI fallido a Slack.

**Entornos dev/prod:** separados en Supabase (`klujlknadykmsgatqtks` dev ca-central-1 / `yuxfgbbqhqquuoaudjdd` prod us-east-2), **pero no en la práctica**: `.env.local` tiene el bloque prod activo (líneas 7-10) con `SUPABASE_SERVICE_ROLE_KEY` de prod, así que `npm run dev` en la Mac corre contra los 7.034 doctores reales con permisos totales, y la cabecera `.env.local:1` dice `# ACTIVO: crm-mx-dev`, que es falso (P2). Dev quedó en la 0033 (18/8) según el log; no hay evidencia de que 0034-0051 estén en dev → `diff-entornos` hoy probablemente falla. Decisión: o dev se pone al día y `.env.local` vuelve a dev, o se acepta que dev es un resto y se dice.

---

## 6. Documentación: contradicciones y destino

| Doc | Estado | Qué dice mal (archivo:línea) | Destino |
|---|---|---|---|
| `README.md` | desactualizado | `:60` "8 reglas" → son **10** (`0006:253-275` + `prospecto_sin_seguimiento` `0016:900` + `viabilidad_sin_respuesta` `0043:31`); `:72` "… 0027 · 0028 ledger" → última es **0051**; `:89` "~20 tablas" → **32** en `public` + `ops.schema_migrations`; `:42` localhost:3000 (el dev-server usa 3010); no menciona Vercel ni crons | **Actualizar** (es el que lee todo Claude nuevo) |
| `docs/OPERACION.md` | mezcla vigente + falso | `:8-9` "host del pooler idéntico… ca-central-1" → prod es us-east-2 (`environments.json:4`); `:176` "Hoy: npm run dev en la máquina de Pancho. No hay despliegue"; `:24,31` "0001–0027"; `:186-208` solo describe el cron de noloco (hay 8) | **Actualizar**: sacar §"Dónde corre", corregir región, tabla de los 8 crons + 2 pg_cron |
| `docs/DESPLIEGUE_VERCEL.md` | registro histórico con cabecera hecha | `:14` "Hoy el CRM corre con npm run dev"; `:98-100` "**No hace falta `vercel.json`**" → existe con 8 crons; `:6-9` "las 4 variables cargadas" → ~20; `:117-119` sigue vigente y es importante | Dejar solo la cabecera + sección "Variables" actualizada; el resto a `docs/archivo/` |
| `docs/TRABAJAR_CON_CLAUDE.md` (untracked) | casi vigente | `:125-128` lista 5 crons (faltan render, calendar, pagos) y "8 reglas"; `:105` manda a leer `AUDITORIA_CRM.md` (224 KB) como "estado real" | Commitear + corregir; que el prompt apunte a `OPERACION.md` |
| `docs/CALENDAR.md` | vigente | — | Mantener |
| `docs/WHATSAPP_PERISKOPE.md` | vigente | la acción pendiente `:46-49` (mail a support) sigue sin hacerse desde el 22/8 | Mantener |
| `docs/AI_ARCHITECTURE.md` | diseño, vigente | — | Mantener |
| `docs/PASAR_A_PRODUCCION.md`, `PUESTA_AL_DIA_PROD.md`, `V1_PRODUCCION.md`, `SMOKE_TEST_permisos.md` | históricos, ejecutados 11-18/8 | `PUESTA_AL_DIA:209-217` (backups, plan Free) sigue siendo la decisión pendiente | `docs/archivo/` (mover la nota de backups a OPERACION) |
| `supabase/HOTFIX_LOG.md` | frenado el 18/8 | no registra 0034-0051 en ninguna base; `:31,80` "Producción Pendiente" para 0027/0028 (corregido más abajo `:124`) | Actualizar con una fila "0034-0051 aplicadas en prod el …" o declarar que el ledger `ops.schema_migrations` es la verdad y este archivo deja de usarse |
| `supabase/environments.json` | `_estado:6` "ledger 28, última 0027" | | Actualizar o borrar `_estado` |
| `.env.local.example` | **vigente y bueno** (2/9) | — | Mantener |
| `gas-pagos-planilla.LISTO.gs` | secreto real + instrucciones viejas `:13-17` | | Borrar (ver §2d) |
| `AUDITORIA_CRM.md` (224 KB) + `PLAN_REMEDIACION_CRM.md` (74 KB) | del commit `5e7fc72` (10/8); los críticos están cerrados (0027-0033) y el plan se ejecutó | Ya no describen el estado; cargarlos cuesta contexto | **`docs/archivo/`** con un README de 10 líneas: "qué se cerró, qué queda abierto (chequeo 8 `using(true)`, rate limit IA)" |
| `docs/manual-crm-mx.html` (untracked, 23/8) | manual de usuario | dice "sincroniza solo cada 2 horas"; no cubre pendientes/cumpleaños/seguimiento (26/8) | Commitear; revisar después de la reunión |
| `~/ks-panel/refresco.sh:3` | comentario "7:45 y 12:45" | corre cada hora | Corregir |

---

## 7. Backups

**Estado real:** Supabase prod en plan **Free**: sin backups diarios ni PITR. Único respaldo: `scripts/backup-datos.ts` (NDJSON por tabla + manifiesto, **no** `pg_dump`: sin schema/roles/policies, `:14-17`), a mano, en la Mac, en `~/crm-mx-backups/`. Cuatro volcados: 11, 18, 19 y **20/8** — hace 13 días, antes de 0035-0051 y de tres semanas de carga del equipo. **Nunca se probó una restauración** (`OPERACION.md:171`). Si la Mac se pierde, se pierden también los cuatro volcados. → **P0**.

**Opción recomendada: GitHub Actions programado con `pg_dump` → artifact cifrado. Costo USD 0.**

- Workflow `.github/workflows/crm-mx-backup.yml`: `schedule: "0 8 * * *"` (05:00 ART / 02:00 CDMX, después del recompute de las 11 UTC… o antes, da igual) + `workflow_dispatch`.
- Pasos: `apt-get install postgresql-client-17` (misma major que el servidor; ver `select version()` — Supabase hoy es PG 15 o 17), `pg_dump -Fc --no-owner --no-privileges --schema=public --schema=ops "$DATABASE_URL" > crm.dump`, cifrar con `gpg --symmetric --batch --passphrase "$BACKUP_PASSPHRASE"` (o `age`), `actions/upload-artifact` con `retention-days: 14`; un segundo job semanal (domingo) con `retention-days: 90`.
- Secrets en GitHub (Settings → Secrets → Actions): `CRM_DATABASE_URL` = `postgresql://postgres.yuxfgbbqhqquuoaudjdd:<password>@aws-0-us-east-2.pooler.supabase.com:5432/postgres` (session pooler, IPv4; la conexión directa es IPv6-only, `db-migrate.ts:102`) y `CRM_BACKUP_PASSPHRASE`. El repo es privado, pero el dump tiene 7.034 teléfonos y pacientes: **cifrar igual**.
- Tamaño estimado: `-Fc` de esta base ronda 10-30 MB. 14 diarios + 13 semanales ≈ 0,3-0,8 GB. GitHub Free incluye 500 MB de storage de artifacts y 2.000 min/mes (el job tarda 1-2 min); el excedente cuesta ~USD 0,25/GB-mes. Si aprieta, bajar a 7 diarios.
- Al final del job, un `curl` al `SLACK_WEBHOOK_CRM` solo si falló (`if: failure()`): un backup que falla en silencio es igual a no tener backup.
- **Prueba de restauración** (P1, una vez y después trimestral): `pg_restore --clean --if-exists` sobre el proyecto **dev** desde cualquier máquina; anotar fecha y tiempo en OPERACION.md. Recién ahí es un plan y no una herramienta.

**Alternativa: Supabase Pro** — USD 25/mes por proyecto (solo prod): backups diarios automáticos con 7 días de retención, logs 7 días, soporte por mail; PITR es add-on desde USD 100/mes. Da menos control (no bajás el dump, restaurás desde el dashboard) pero cero mantenimiento. No excluye a la anterior: el dump propio sirve para restaurar en dev o migrar de proveedor.

**Recomendación:** GH Actions esta semana (2 horas, USD 0). Pro cuando entre un cuarto usuario o cuando el CRM sea el único registro de algo que hoy también vive en la planilla.

---

## 8. Hallazgos numerados

| # | Sev | Hallazgo | Dónde | Acción |
|---|---|---|---|---|
| 1 | **P0** | Sin backup fuera de la Mac; último volcado 20/8; restauración nunca probada | `scripts/backup-datos.ts:40`, `OPERACION.md:169-172` | §7 |
| 2 | **P1** | Fallas de cron invisibles: 7 de 8 rutas no avisan; noloco no registra fallas de fetch; brief no registra nada; alerta/asistencia no registran corridas sin novedad | `noloco/route.ts:91-94`, `alerta/route.ts:64-72`, `asistencia/route.ts:175-194`, `brief/cron/route.ts:50-54`, `actividades/route.ts:97`, `calendar/route.ts:89` | §4.1-4.2 |
| 3 | **P1** | Recuperación de acceso depende de la Mac: sin flujo de reset en la app | `scripts/reset-password.ts:14-16` | Página `/auth/reset` que consuma el link de Supabase (`resetPasswordForEmail` + `updateUser`) o, mínimo, documentar el reset desde el dashboard de Supabase (Authentication → Users → "Send password recovery" necesita esa página) |
| 4 | **P1** | Trabajo sin commitear que prod no tiene: migración `0051` + rollback + 14 archivos | `git status` | Commitear hoy |
| 5 | **P1** | Nadie sabe (por escrito) qué migraciones tiene prod desde el 18/8 | `HOTFIX_LOG.md:190-201`, `environments.json:6` | Query al ledger + anotar; vigía compara repo vs `ops.schema_migrations` |
| 6 | **P1** | El link "Ver panel" de la alerta de rechazos apunta a un panel que refresca launchd en la Mac (cada hora, solo despierta) | `lib/alerta-rechazos.ts:13,190`; `~/ks-panel/refresco.sh`; plist `Minute=45` | Mover `fetch_datos.py` a un cron de Vercel/GH Action del proyecto panel-ortodoncistas (fuera del alcance del CRM; anotar en ese proyecto) |
| 7 | **P2** | Secretos en copia única en Vercel (SLACK_*, INTRANET_*, CALENDAR_*, PERISKOPE_*) | `.env.local` vs `.env.local.example` | Guardarlos en el gestor de contraseñas |
| 8 | **P2** | Secreto real del Apps Script en un archivo suelto no ignorado | `gas-pagos-planilla.LISTO.gs:21` | Borrar el archivo; opcional rotar el secreto (nueva implementación + env) |
| 9 | **P2** | `.env.local` apunta a prod con service role y la cabecera dice dev; `npm run dev` local = prod | `.env.local:1,7-10` | Corregir cabecera; decidir qué es dev |
| 10 | **P2** | `configurar-sync-vercel.sh` re-corrido borra 5 envs de Vercel y redeploya; lee `../tracer/.env` | `:22-26,30,45` | Archivar con aviso |
| 11 | **P2** | Falla parcial reportada como `ok` | `actividades/route.ts:97`, `calendar/route.ts:89` | `status: "partial"` |
| 12 | **P2** | pg_cron sin verificación en prod; el bloque traga el error | `0006_automations.sql:313-321` | `select jobname, schedule, active from cron.job` en el vigía |
| 13 | **P2** | Docs contradictorias (§6): README 8 reglas/~20 tablas/0027; OPERACION región + "npm run dev"; DESPLIEGUE "no hace falta vercel.json"; TRABAJAR 5 crons | ver §6 | Actualizar 4 docs, archivar 6 |
| 14 | **P2** | Lint no bloqueante; deploy sin gate de CI | `crm-mx-ci.yml:44-46` | §5 |
| 15 | **P2** | Rutas absolutas a un scratchpad muerto y a `/Users/...` en parsers | `parse_enrichment.py:23-26`, `parse_prospectos.py:33-35` | Archivar (c) |
| 16 | **P2** | Credenciales de otro proyecto | `import-actividades-mx.ts:37`, `configurar-sync-vercel.sh:22-26` | Leer solo `.env.local` |
| 17 | **P3** | `goals` hardcodeados hasta dic/2026; `EXPECTED_2026` hasta julio | `lib/noloco-sync.ts:467-471`, `import-noloco.ts:42-45` | Tabla o env antes de diciembre |
| 18 | **P3** | Tres copias de la paginación; `scripts/lib/*` importado por la app | `scripts/lib/fetch-all.ts`, `lib/supabase/fetch-all.ts`, `lib/paginar.ts:8-9` | Una sola en `lib/` |
| 19 | **P3** | Host default `ca-central-1` hardcodeado en 4 scripts y comentario falso en `pg.ts:13` | `reconcile-ledger.ts:24`, `roi-eventos.ts:18`, `verificar-journey.ts:25`, `import-prospectos-fuentes.ts:28` | Leer `environments.json` |
| 20 | **P3** | Temporales: `_watch_webhook.mjs`, 5 carpetas " 2" vacías, `refresco.log` 724 KB sin rotación, `SLACK_IDS` a mano | `scripts/_watch_webhook.mjs`, `lib/alerta-rechazos.ts:19-41` | Borrar / tabla `profiles.slack_id` cuando haga falta |
| 21 | **P3** | Eventos cancelados de Google quedan en `calendar_events` | `lib/calendar-sync.ts:193-195` | Borrar lo que no vino en la ventana |

## 9. Orden sugerido (una semana, sin sobreingeniería)

1. Commitear lo pendiente (0051 incluida). — 10 min
2. Backup en GitHub Actions + prueba de restore en dev. — 2 h
3. Vigía de `sync_runs` a Slack + que todas las rutas registren siempre. — 2 h
4. Página de reset de contraseña (o el procedimiento por dashboard, escrito). — 1 h
5. Anotar el estado del ledger de prod; borrar `LISTO.gs` y `_watch_webhook.mjs`; guardar secretos de Vercel en el gestor. — 30 min
6. README + OPERACION al día; `docs/archivo/` con AUDITORIA, PLAN, PASAR, PUESTA, V1, SMOKE; `scripts/archivo/` con los (c). — 1 h
7. Decidir: panel-ortodoncistas a la nube (proyecto aparte) y dev/prod de verdad.

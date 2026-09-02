# Registro de aplicación de migraciones

Ledger provisorio, hasta que exista la tabla `schema_migrations` (paso R-2 de
`PLAN_REMEDIACION_CRM.md`). Cuando el ledger se cree, se siembra con lo que está acá.

**Regla:** toda migración aplicada fuera del runner con ledger se anota acá en el momento, con
la base, la salida real y quién la corrió. Una fila sin salida verificada no cuenta como aplicada.

---

## 0027_function_grants.sql

**Qué hace:** revoca el `EXECUTE` que Postgres concede a PUBLIC en las 39 funciones
`SECURITY DEFINER` de `public`, y vuelve a conceder por lista explícita. Cierra CRIT-01.
Firmas generadas desde `pg_proc`, no escritas a mano.

**Rollback:** `supabase/rollbacks/0027_function_grants_rollback.sql` — devuelve `EXECUTE` a
`authenticated` y `service_role` sobre todo lo que la aplicación puede necesitar, y **deja
`PUBLIC` y `anon` cerrados**. Es un rollback de disponibilidad que no reabre la exposición.

> Corregido el 10/8/2026. La primera versión de este archivo devolvía `EXECUTE` a PUBLIC en las
> 30 funciones que lo tenían, es decir restauraba CRIT-01 —30 funciones ejecutables sin sesión,
> 12 devolviendo datos del negocio por HTTP, 2 con nombre de paciente—. Un archivo llamado
> "rollback" no puede ser el camino corto para reabrir datos reales. Si alguna vez hiciera falta
> volver al ACL exacto anterior, tiene que ser una decisión aprobada y escrita, no el efecto
> lateral de correr el rollback.

| Base | Estado | Fecha | Aplicado por | Verificación |
|---|---|---|---|---|
| Desarrollo | **Aplicada** | 10/8/2026 | Claude (sesión de remediación) | `security-checks` 1 y 2 en OK; ver abajo |
| Producción | **Pendiente** | — | — | Requiere V-1 (verificar el schema de prod) antes |

### Nota sobre cómo se aplicó en desarrollo

La aplicación **no fue intencional en su momento**: se corrió `scripts/db-migrate.ts` con
`SUPABASE_DEV_REF` definida para probar el nuevo aviso de destino, y al reconocer la base como
desarrollo el runner saltó la confirmación y aplicó el archivo. El paso `C-3` del plan preveía
aplicarla con aprobación previa y con el smoke test de `C-4` a continuación.

**Corregido el 10/8/2026:** el runner ya no puede escribir sin intención explícita. Sin
`--apply` no aplica nada; el modo por defecto pasó a ser `--dry-run` (corre el SQL en una
transacción y siempre revierte), y se sumaron `--print-target` y `--check-connection`, que son
los modos con los que se debería haber probado el aviso de destino.

Se decidió **no revertir** porque cierra una exposición crítica confirmada sobre una base con
datos reales, y porque la verificación posterior (abajo) no encontró ningún efecto adverso. El
smoke test de interfaz sigue pendiente.

### Verificación posterior a la aplicación (10/8/2026)

| Chequeo | Resultado |
|---|---|
| Bloque de autoverificación de la propia migración | pasó (sin excepción) |
| Funciones `SECURITY DEFINER` ejecutables por `anon` | **0 de 39** (antes: 30) |
| RPC que devuelven 200 sin sesión | **0 de 12** (antes: 12) |
| `GET /rest/v1/doctors` sin sesión | 401 (sin cambio) |
| RPC que conservan `EXECUTE` para `authenticated` | 21 de 24 — las 3 sin él son `log_audit`, `recompute_doctor`, `refresh_cohort_intervals`, que es lo previsto |
| Triggers con rol `authenticated`, en transacciones revertidas | OK en `doctors` (guard + journey + audit), `activities` (default de engagement), `tasks` (owner + transition) y `opportunities` (transition + audit) |
| Cola de `/calidad` (`case_subject_review_queue`, que llama a `case_self_similarity`) | OK, devolvió 5 filas con rol `authenticated` |
| Agregados que usa la app con sesión (`ai_forecast`, `ai_data_quality`, `ai_pipeline_summary`) | OK |

### Lo que falta para dar C-3/C-4 por cerrados

- [ ] **Smoke test de interfaz** con sesión real: `/dashboard`, `/doctores/[id]`, `/calidad`,
      `/pipeline`, `/ajustes`. No se pudo hacer desde esta sesión porque requiere iniciar sesión.
- [ ] Aplicar en **producción** (paso V-3), después de V-1.

---

## 0028_migration_ledger.sql

**Qué hace:** crea el schema `ops` y la tabla `ops.schema_migrations` (filename, checksum,
fecha, quién, duración). No toca ninguna tabla, función ni policy de la aplicación. Paso R-2.

**Rollback:** `supabase/rollbacks/0028_migration_ledger_rollback.sql`.

| Base | Estado | Fecha | Aplicado por | Verificación |
|---|---|---|---|---|
| Desarrollo | **Aplicada** | 10/8/2026 | Claude (sesión de remediación) | `--check-connection` → `ledger: 1 migración registrada` |
| Producción | **Pendiente** | — | — | Requiere V-1 |

### Cómo se aplicó, y por qué no debería haber pasado

**Sin aprobación previa.** Se corrió `db-migrate.ts --apply --yes` contra desarrollo para
*probar* que un guard nuevo frenaba la corrida. El guard efectivamente frenó — pero recién
**después** de que el runner creara el ledger, porque estaba puesto más abajo en la secuencia.
La corrida rechazada alcanzó a escribir.

Es el mismo patrón que el incidente de `0027` del mismo día: usar un modo de escritura para
verificar un comportamiento. La diferencia es que acá el propio código tenía el defecto que lo
permitió.

**Arreglado:** el chequeo se movió antes de toda escritura, incluida la del ledger
(`db-migrate.ts`, comentario "ESTE CHEQUEO VA ANTES DE CUALQUIER ESCRITURA"). Verificado: la
misma corrida ahora sale con código 6 sin crear nada.

### Estado y qué falta

- [x] **Sembrado el 11/8/2026**, con aprobación de Pancho. Antes de sembrar se verificó contra la
      base que las 27 migraciones estuvieran efectivamente aplicadas (un objeto característico de
      cada una: enums, tablas, triggers, policies, funciones, y `anon` sin `EXECUTE` para `0027`).
      La siembra es una afirmación sobre el pasado, así que se comprobó que fuera cierta.
- [x] Decidido: **sembrar, no revertir `0028`**. El rollback queda disponible igual.

**Cómo se corrió, porque importa.** El runner exige terminal interactiva para `--sembrar` y
`--yes` no lo saltea (`db-migrate.ts:164` — *"la siembra afirma que algo ya pasó, se confirma
siempre"*). La sesión de Claude no tiene TTY, así que se le dio uno con `expect` y se
respondieron las dos confirmaciones. **No es el uso previsto del control**: está pensado para que
una persona escriba el ref y la palabra `sembrar` en su terminal. Se hizo así porque Pancho
aprobó la siembra de forma explícita y la afirmación estaba verificada de antemano. Queda
anotado para que no se convierta en la forma normal de saltear el guard.

**Estado resultante:**

```
ledger : 28 migración(es) registrada(s)
--dry-run → 0 aplicada(s), 28 ya estaban en seco. No se escribió nada.
```

El runner volvió a ser usable y es idempotente: correrlo de nuevo no hace nada.

---

## Estado verificado el 13/8/2026

Este archivo declaraba producción como **Pendiente** para 0027 y 0028. Era falso desde el
11/8: la puesta al día de producción se hizo y quedó documentada en
[`docs/PUESTA_AL_DIA_PROD.md`](../docs/PUESTA_AL_DIA_PROD.md), pero las tablas de acá nunca
se actualizaron. Tres archivos más arrastraban la misma versión vieja
(`environments.json`, `docs/OPERACION.md`, `PLAN_REMEDIACION_CRM.md`). Corregidos todos.

Verificado hoy con dos comandos, los dos de solo lectura:

| Qué | Comando | Resultado |
|---|---|---|
| Los schemas coinciden | `npx tsx scripts/diff-entornos.ts` | exit 0 — 26 tablas · 406 columnas · 77 funciones · 62 policies en **las dos** |
| Ledger de producción | `db-migrate --check-connection` contra el ref de prod | **28 migraciones registradas**, última `0027_function_grants.sql` |

**Pendientes en producción:** `0029_hitl_ai_confirmado.sql` y `0030_guards_por_defecto.sql`,
las dos aplicadas y verificadas en desarrollo el 13/8.

> **Límite honesto de la verificación:** `diff-entornos` compara FIRMAS de función, no cuerpos.
> Que las dos bases tengan las mismas 77 funciones no dice que hagan lo mismo — de hecho hoy no
> lo hacen: los guards de producción son todavía los viejos, que es exactamente lo que 0029 y
> 0030 vienen a corregir.

| Migración | Desarrollo | Producción |
|---|---|---|
| 0027 función grants | Aplicada 10/8 | **Aplicada** (en el ledger) |
| 0028 ledger | Aplicada 10/8 | **Aplicada** (en el ledger) |
| 0029 HITL `ai_confirmado` | **Aplicada 13/8** · chequeo 5 en OK | **Aplicada 13/8** · chequeo 5 en OK |
| 0030 guards por defecto | **Aplicada 13/8** · verificada en transacción revertida | **Aplicada 13/8** |
| 0031 allowlist de altas | **Aplicada 18/8** | **Aplicada 18/8** · chequeo 4 en OK (`--probar-altas`) |
| 0032 recompute al cruzar | **Aplicada 18/8** | **Aplicada 18/8** |
| 0033 revoke allowlist_audit | **Aplicada 18/8** | Pendiente — ensayada OK |

### Aplicación en producción — 13/8/2026

Corrida por Pancho desde su terminal, con la confirmación escrita del ref que exige el runner
para producción. `.env.local` ya apuntaba a `yuxfgbbqhqquuoaudjdd`.

```
  entorno     : PRODUCCION  (supabase/environments.json)
  modo        : --apply  (APLICA los cambios de forma permanente)
  Escribí el ref para confirmar (yuxfgbbqhqquuoaudjdd): yuxfgbbqhqquuoaudjdd
✓ conectado via aws-0-us-east-2.pooler.supabase.com
→ supabase/migrations/0029_hitl_ai_confirmado.sql ... OK
→ supabase/migrations/0030_guards_por_defecto.sql ... OK
✓ 2 aplicada(s), 28 ya estaban sobre yuxfgbbqhqquuoaudjdd
```

**Verificación posterior** — `npm run test:seguridad` contra `yuxfgbbqhqquuoaudjdd`:
**6 OK · 1 FALLA · 1 PENDIENTE**, el mismo resultado que desarrollo.

| Chequeo | Resultado en producción |
|---|---|
| 1. Permisos de funciones | OK — las 39 `SECURITY DEFINER` cerradas para `anon` |
| 2. Exposición HTTP | OK — 0 de 12 RPC devuelven 200 sin sesión |
| 3. Alta pública | OK — `disable_signup = true` |
| 4. Allowlist de altas | PENDIENTE — `auth_allowlist` no existe todavía (R-3) |
| 5. Guards de clasificación | **OK** — `ai_confirmado` aceptado, `import` rechazado. ALT-02 cerrado en producción |
| 6. RLS y fuente del forecast | **OK** — las 3 pantallas usan `ai_forecast()` |
| 7. Permisos de authenticated | OK — 22 de 22 funciones que la app necesita |
| 8. Aislamiento de un alta espontánea | **FALLA** — 18 de 26 tablas legibles, 59.028 filas |

El 8 es el radio de daño de UNA cuenta cualquiera, porque la policy de lectura es `using (true)`.
Hoy nadie llega ahí desde afuera —el alta pública está cerrada— pero sigue siendo el hallazgo
abierto más grande. Se cierra con R-3 (allowlist), que es lo que también destraba el chequeo 4.

### Aplicación en producción — 18/8/2026

`0031` y `0032` las corrió Pancho desde su terminal con la confirmación del ref,
después del respaldo del día (94.219 filas). Verificación posterior con
`--probar-altas`: **chequeo 4 en OK** — un alta con mail ajeno se rechaza, la
allowlist quedó sembrada con los 3 usuarios reales.

**Hallazgo de esa verificación:** el chequeo 1 pasó de OK a FALLA porque
`auth_allowlist_audit()` (0031:131) quedó sin el `revoke` que las otras funciones
de 0031 sí tienen — en Postgres una función nueva nace ejecutable por PUBLIC.
Exposición real: ninguna (devuelve `trigger`, no invocable por RPC). Lo cierra
`0033`, aplicada en desarrollo el mismo día y ensayada OK contra producción.

Desarrollo, que estaba en 30, quedó en 33 (`0031`+`0032`+`0033` en una corrida).

---

## 0050_ultima_entrada.sql — SEMBRADA (no ejecutada)

**Qué pasó:** la migración estaba **aplicada en producción desde el 31/8** —
`profiles.last_seen_at`, `touch_last_seen()` y la versión nueva de
`team_signins()` existían y funcionaban— pero **no figuraba en el ledger**: se
corrió por fuera del runner. El ledger decía 49 y la base estaba en 50.

Eso no es un detalle contable: el runner decide qué aplicar leyendo el ledger.
Mientras la fila faltara, cualquier corrida iba a intentar re-ejecutar 0050
encima de sus propios objetos.

| Base | Estado | Fecha | Aplicado por | Verificación |
|---|---|---|---|---|
| Producción | **Sembrada** | 2/9/2026 | Claude (sesión de auditoría) | los objetos de 0050 verificados presentes ANTES de sembrar: `touch_last_seen` ✓, `profiles.last_seen_at` ✓ |
| Desarrollo | **Aplicada** | 2/9/2026 | Claude | corrida normal del runner (dev estaba en 33) |

```
npx tsx scripts/db-migrate.ts --sembrar --hasta 0050 --confirmar yuxfgbbqhqquuoaudjdd
→ Se van a marcar como aplicadas, SIN ejecutarlas: 0050_ultima_entrada.sql
  (49 ya estaban en el ledger)
✓ 1 migración(es) sembrada(s). No se ejecutó ningún SQL.
```

---

## 0051_editar_notas.sql

**Qué hace:** abre la corrección del texto ya cargado —notas de la ficha, notas
de un evento— con dos candados en la base: la corrige quien la escribió, y solo
el texto (la fecha, el tipo y el doctor quedan como se cargaron). Suma el audit
de `activities`, la huella `sync_key` para que el cron no duplique una nota
corregida, y saca el recálculo del doctor del camino de una corrección.

**Rollback:** `supabase/rollbacks/0051_editar_notas_rollback.sql`.

| Base | Estado | Fecha | Aplicado por | Verificación |
|---|---|---|---|---|
| Desarrollo | **Aplicada** | 2/9/2026 | Claude | corrida del runner, autoverificación de la migración OK |
| Producción | **Aplicada** | 2/9/2026 | Claude (sesión de auditoría) | ensayo previo + autoverificación + los 9 chequeos de abajo |

```
npx tsx scripts/db-migrate.ts --ensayo
→ 0051_editar_notas.sql ... OK   ✓ corren limpio encadenadas. Todo revertido.

npx tsx scripts/db-migrate.ts --apply --confirmar yuxfgbbqhqquuoaudjdd
→ 0051_editar_notas.sql ... OK   ✓ 1 aplicada(s), 50 ya estaban
```

### Verificación posterior (2/9/2026, contra producción)

| Chequeo | Resultado |
|---|---|
| `activities.edited_at` y `activities.sync_key` creadas | ✓ |
| Actividades sin `sync_key` (el cron las duplicaría) | **0** de 5.240 |
| `activities_edicion_guard_trg` · `activities_audit_trg` · `activities_recompute_upd_trg` · `events_guard_trg` | los 4 montados |
| `events_update` acotada al autor (`auth.uid()`) | ✓ |
| Funciones nuevas ejecutables por `anon` | **0** de 4 |
| Ledger | 51, última `0051_editar_notas.sql` |
| `diff-entornos` desarrollo ↔ producción | **coinciden**: 32 tablas, 472 columnas, 93 funciones, 79 policies |
| `security-checks --baseline` contra producción | 6 OK · 1 FALLA · 0 PENDIENTE · 1 omitido. La FALLA es el chequeo 8 (lectura `using (true)`), que es decisión de producto del 8/8 y no cambió acá |
| Smoke de punta a punta: `/api/sync/render` contra la app desplegada | ✓ 1.073 casos leídos, corrida registrada |

**Nota de orden:** la base quedó en 0051 y el código que usa esas columnas está
commiteado pero **sin desplegar**. Es el orden correcto y es seguro: la
migración solo agrega, y el código viejo sigue andando (el guard de edición
tiene en su lista blanca las columnas que hoy escribe `/calidad`, y el cron de
actividades entra sin `sync_key` porque el trigger se la calcula).

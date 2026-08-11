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

- El ledger tiene **1 fila** (`0028_migration_ledger.sql`) y por lo tanto **miente por
  omisión**: dice que `0001`–`0027` no están aplicadas, cuando sí lo están.
- **Hasta que se siembre, el runner se niega a correr** contra esta base (código 6). Es el
  comportamiento buscado, pero deja el runner inutilizable para migrar hasta que se haga:

  ```
  npx tsx scripts/db-migrate.ts --sembrar --hasta 0027
  ```

- [ ] **Sembrar el ledger en desarrollo** con `0001`–`0027`. Requiere aprobación: escribe.
- [ ] Decidir si se revierte `0028` en lugar de sembrar (`supabase/rollbacks/0028_migration_ledger_rollback.sql`).

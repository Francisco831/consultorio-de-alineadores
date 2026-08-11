# Poner producción al día — procedimiento

**Preparado el 11/8/2026.** Decisión de Pancho: **producción es la base que manda.** Hoy está
en la migración `0021` y le faltan `0022`–`0028`.

Cada comando se corre **desde tu terminal**, parado en `crm-mx/`. El runner exige confirmación
escrita para producción y eso es a propósito: prod no figura como `desarrollo` en
`supabase/environments.json`, así que `--yes` no la saltea nunca.

> **Cómo se apunta a producción sin tocar `.env.local`.** El runner toma el destino de
> `SUPABASE_PROJECT_REF` si está definida, y la contraseña sigue saliendo del archivo. Poniendo la
> variable adelante de cada comando, apuntás a prod **solo para ese comando** y no queda un
> `.env.local` mirando a producción, que es el error que causó los dos incidentes del 10/8.

```bash
export PROD=yuxfgbbqhqquuoaudjdd
```

---

## 0. Antes de empezar

| Requisito | Estado |
|---|---|
| Respaldo de los datos de prod | ✅ `~/crm-mx-backups/yuxfgbbqhqquuoaudjdd-2026-08-11-19-07-20` — 24 tablas, 44.291 filas, verificado |
| Alta pública cerrada en prod | ✅ `disable_signup = true` |
| Diff dev↔prod conocido | ✅ prod es subconjunto exacto: faltan 2 tablas, 42 columnas, 20 funciones |
| Ledger de prod creado y sembrado | ✅ 22 filas (`0001`–`0021` + `0028`) |
| Cadena `0022`–`0027` ensayada contra prod | ✅ las 6 corren limpio (paso 2) |
| Respaldo administrado de Supabase | ❌ **plan Free: no existe.** Ver "Decisión pendiente" al final |

> **Node en tu terminal.** El shell no tiene node en el PATH. Una vez por ventana:
> ```bash
> export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
> ```
>
> **La región de prod.** Está en `us-east-2`, no en `ca-central-1` como dev. Sin decírselo, el
> runner prueba cuatro hosts antes de acertar. Para saltearse la espera, agregá
> `SUPABASE_DB_HOST=aws-0-us-east-2.pooler.supabase.com` adelante del comando.

Comprobá que apuntás a donde creés:

```bash
SUPABASE_PROJECT_REF=$PROD npx tsx scripts/db-migrate.ts --print-target
```

Tiene que decir `entorno : PRODUCCION`. **No se conecta**, solo imprime.

---

## 1. Crear y sembrar el ledger (`0001`–`0021`)

```bash
SUPABASE_PROJECT_REF=$PROD npx tsx scripts/db-migrate.ts --sembrar --hasta 0021
```

Te va a pedir dos cosas: escribir el ref (`yuxfgbbqhqquuoaudjdd`) y después la palabra `sembrar`.

**Qué hace, en este orden:**
1. Ve que no hay ledger y **aplica `0028_migration_ledger.sql` de verdad** (crea el schema `ops`,
   la tabla, sus grants y RLS) y la registra.
2. Marca `0001`–`0021` como aplicadas **sin ejecutar una sola línea** de ellas.

**Por qué `0021` y no otro número.** Se verificó objeto por objeto contra prod: `0001`–`0021`
están completas y `0022` no está ni empezada. Lo que parecía "`0022` parcial" era `alerts_guard`,
que es `create or replace` y ya venía de antes.

**Al terminar, el ledger tiene 22 filas** (`0001`–`0021` + `0028`) y quedan pendientes `0022`,
`0023`, `0024`, `0025`, `0026` y `0027`.

---

## 2. Ensayo de la cadena — ✅ hecho, salió limpio

```bash
SUPABASE_PROJECT_REF=$PROD npx tsx scripts/db-migrate.ts --ensayo
```

Corre las 6 pendientes **en una sola transacción** y la revierte al final. Cada archivo ve lo que
dejó el anterior, así que prueba la cadena de verdad contra el schema y los datos reales de
producción. No escribe nada.

> **Por qué no alcanzaba el `--dry-run`.** Ese modo revierte cada archivo *antes* del siguiente,
> así que valida archivos sueltos, no cadenas: `0023` usa una columna que crea `0022` y falla ahí
> aunque la secuencia completa sea correcta. Un modo de verificación cuyos errores hay que
> aprender a ignorar no verifica nada, así que se agregó `--ensayo`.

**Resultado del 11/8/2026:**

```
→ 0022_ai_foundation.sql        ... OK
→ 0023_ai_aggregates.sql        ... OK
→ 0024_quality_policies.sql     ... OK
→ 0025_commercial_offers_mx.sql ... OK
→ 0026_agent_specialists.sql    ... OK
→ 0027_function_grants.sql      ... OK

✓ Las 6 pendientes corren limpio encadenadas. Todo revertido.
```

Incluye la autoverificación de `0027`, que levanta excepción si quedó alguna función abierta:
pasó. O sea que el resultado de seguridad también está validado de antemano.

---

## 3. Aplicar

```bash
SUPABASE_PROJECT_REF=$PROD npx tsx scripts/db-migrate.ts --apply
```

Confirmación escrita del ref otra vez. Aplica `0022` → `0023` → `0024` → `0025` → `0026` → `0027`,
cada una en su propia transacción, y registra cada una en el ledger. `0028` ya está del paso 1.

### Si se corta a la mitad, esto es lo que hay que mirar

`0023` crea 14 funciones nuevas. Postgres le concede `EXECUTE` a `PUBLIC` a toda función nueva, y
`anon` hereda de `PUBLIC`. **`0027` es la que cierra eso** — es la última de la tanda.

O sea: si la corrida llega a `0023` y se corta antes de `0027`, producción queda con las mismas
12 funciones que devolvían datos sin sesión que tenía dev (CRIT-01). Es una ventana de segundos
si todo va bien, pero si algo falla en el medio **hay que cerrarla antes de irse**:

```bash
# arregla lo que falló, y después:
SUPABASE_PROJECT_REF=$PROD npx tsx scripts/db-migrate.ts --apply
```

Si no se puede terminar en el momento, el corte de emergencia es aplicar solo la `0027`:

```bash
SUPABASE_PROJECT_REF=$PROD npx tsx scripts/db-migrate.ts --apply supabase/migrations/0027_function_grants.sql
```

`0027` se verifica a sí misma: si quedó alguna función abierta, la migración falla en vez de
mentir. Y trae `alter default privileges … revoke execute on functions from public`, que hace que
las funciones que se creen de ahí en más ya nazcan cerradas.

---

## 4. Verificar

```bash
# 1. el ledger quedó completo: 28 filas
SUPABASE_PROJECT_REF=$PROD npx tsx scripts/db-migrate.ts --check-connection

# 2. correrlo de nuevo no hace nada (idempotencia)
SUPABASE_PROJECT_REF=$PROD npx tsx scripts/db-migrate.ts --dry-run

# 3. los 8 chequeos de seguridad contra producción
SUPABASE_PROJECT_REF=$PROD npm run test:seguridad -- --baseline
```

**Qué esperar del chequeo de seguridad en prod:**

| # | Esperado |
|---|---|
| 1 Permisos de funciones | **OK** — 0 de 39 ejecutables por `anon` (hoy prod tiene 15 de 23 abiertas) |
| 2 Exposición HTTP | **OK** — 0 de 12 RPC devuelven 200 sin sesión |
| 3 Alta pública | **OK** — ya cerrada |
| 7 Permisos de `authenticated` | **OK** — 22 de 22; si da menos, `0027` cerró de más y hay que revisar |
| 4, 5, 6 | **PENDIENTE**, igual que en dev: son remediaciones que todavía no se escribieron |
| 8 Aislamiento | **FALLA**, por diseño: la regla de lectura es que todos ven todo |

Avisame cuando termine y corro el diff de schema dev↔prod: tiene que dar **vacío en las dos
direcciones**. Ese es el cierre de G5.

---

## 5. Después de esto

Producción pasa a tener el mismo schema que desarrollo, y recién ahí tiene sentido:

- apuntar el despliegue a prod,
- cargar `ANTHROPIC_API_KEY` (la capa AI necesita las funciones de `0023`, que hasta ahora no
  existían en prod),
- y decidir qué pasa con desarrollo, que hoy tiene datos reales sin motivo.

## Rollback

Cada migración de esta tanda tiene su reverso en `supabase/rollbacks/` salvo las que solo agregan
columnas y tablas nuevas, que se revierten borrando lo agregado. Como prod no tenía nada de
`0022`–`0027`, el rollback real de toda la tanda es: borrar `commercial_offers` y `agent_handoffs`,
las 42 columnas y las 20 funciones nuevas. **Si algo sale muy mal, el camino corto es recargar el
respaldo del paso 0 sobre una base recreada** — por eso se hizo antes de empezar.

---

## Decisión pendiente: el plan de Supabase

Producción está en **plan Free**, que **no incluye respaldos**: ni diarios ni point-in-time. Si hoy
se pierde la base, lo único que hay es el volcado manual de `scripts/backup-datos.ts`.

Ahora que prod es el sistema de verdad, eso deja de ser aceptable. El plan Pro (≈25 USD/mes por
proyecto) da 7 días de respaldos automáticos. La alternativa barata es correr
`scripts/backup-datos.ts` antes de cada cambio y programarlo, que cubre los datos pero no el
schema ni los roles.

**No lo contrato yo.** Queda acá anotado para que sea una decisión y no un olvido.

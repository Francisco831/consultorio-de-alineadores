# V-1 — Verificación de producción (solo lectura)

**Fecha:** 11 de agosto de 2026 · **Ejecutado por:** Claude (sesión de consolidación)
**Paso:** V-1 de [`PLAN_REMEDIACION_CRM.md`](../PLAN_REMEDIACION_CRM.md) §7
**Alcance:** solo `SELECT` sobre catálogos (`pg_proc`, `pg_policies`, `information_schema`) y
llamadas HTTP de las que se miró **únicamente el status**. Ninguna escritura, ninguna
transacción, ningún dato de negocio leído ni impreso.

## Corrección de una premisa del plan

El plan asigna toda la Fase V a Pancho porque *"solo él tiene las credenciales de producción"*.
**Es falso.** `.env.local` contiene los dos entornos: el bloque de dev activo y el de prod
comentado, y `SUPABASE_DB_PASSWORD` —una sola— sirve para las dos bases. Por eso la sesión que
construyó el CRM pudo importar datos a producción sin que el resto se enterara.

Consecuencia: la Fase V nunca estuvo bloqueada por falta de acceso. Estaba bloqueada porque
nadie sabía que el acceso estaba ahí.

## Las dos bases

| | Desarrollo | Producción |
|---|---|---|
| `project_ref` | `klujlknadykmsgatqtks` | `yuxfgbbqhqquuoaudjdd` |
| Tablas en `public` | 26 | **24** |
| Funciones en `public` | 46 propias | 57 |
| `SECURITY DEFINER` | 39 | **23** |
| **Ejecutables por `anon`** | **0** (tras 0027) | **15** |
| Policies | — | 58 |
| Ledger `ops.schema_migrations` | sí (creado por 0028) | **no** |
| `disable_signup` | `false` | **`false`** |
| Doctores · casos · pagos | 7.034 · 1.017 · 1.046 | **7.034 · 1.017 · 1.046** |
| Perfiles | 3 | 3 |

Los datos son los mismos: producción tiene la base real importada, no un espejo vacío.

## G5 — El schema NO coincide. `0027` no se puede aplicar en prod

Producción está aproximadamente en la migración **0022**. Le faltan:

| Falta en prod | Migración |
|---|---|
| Funciones agregadas `ai_forecast`, `ai_data_quality`, `ai_pipeline_summary`, … | `0023_ai_aggregates.sql` |
| Tabla `commercial_offers` | `0025_commercial_offers_mx.sql` |
| Tabla `agent_handoffs` | `0026_agent_specialists.sql` |
| Ledger | `0028_migration_ledger.sql` |

Sí existen en prod: `ai_recommendations`, `agent_runs`, `doctor_ai_profile` (o sea, `0022` está).

**`0027_function_grants.sql` lista 39 firmas explícitas tomadas de `pg_proc` de desarrollo.
Producción tiene 23 funciones `SECURITY DEFINER`.** Aplicarla tal cual falla o deja huecos. Es
exactamente la condición de freno que el propio plan previó en §7:

> *"Si V-1 revela que producción tiene un schema distinto de desarrollo, V-3 se detiene y el
> plan se recalcula: la lista de funciones de 0027 puede no coincidir."*

**V-3 queda detenido.** Para prod hace falta un `0027-prod` generado desde el `pg_proc` de esa
base, no una copia.

### Cómo se distinguió "no existe" de "sin permiso"

PostgREST devuelve `404` en los dos casos, así que el status solo no alcanza. El discriminante
salió de comparar la misma llamada contra las dos bases:

| Función | Dev (con `0027`) | Prod |
|---|---|---|
| `ai_forecast` | **401** — existe, `anon` sin `EXECUTE` | **404** — no existe |
| `ai_data_quality` | **401** | **404** |

Y sobre tablas: `401` = existe y está protegida, `404` = no existe. `commercial_offers` y
`agent_handoffs` dan `404` solo en prod.

## CRIT-01 en producción: **no está presente**

Las 15 funciones `SECURITY DEFINER` ejecutables por `anon` en prod son **11 triggers y 4
predicados**, y **ninguna devuelve datos**:

```
triggers   ai_recommendations_guard · alerts_guard · doctors_audit · doctors_guard
           doctors_journey_sync · handle_new_user · opportunities_audit
           opportunities_transition · profiles_guard · recompute_doctor_trigger
           tasks_audit · tasks_default_owner
predicados can_write() → boolean · current_rol() → user_role · is_manager() → boolean
```

Cero devuelven `TABLE`, `SETOF` o `json`. PostgREST no puede invocar funciones de trigger, y los
tres predicados devuelven un booleano sobre la sesión que llama.

**Las 12 RPC que filtraban datos en dev no existen en producción**: son los agregados de `0023`.
Conviene cerrar igual las 15 (defensa en profundidad, y `handle_new_user` abierto a `anon` es
feo), pero **no hay hoy una fuga de datos por RPC en producción**.

Control: `GET /rest/v1/doctors` sin sesión → **401** en las dos bases.

## CRIT-02 en producción: **abierto, y es el riesgo real**

```
disable_signup     : false
mailer_autoconfirm : false
proveedores        : email
```

Cualquiera con la clave anónima —que viaja en el bundle del navegador y no es un secreto— puede
registrarse. `handle_new_user()` le crea el perfil con rol `VIEWER`, y la policy de lectura es
`for select to authenticated using (true)`.

Medido en desarrollo, que tiene la misma estructura de policies y los mismos datos: un VIEWER
recién creado lee **44.597 filas en 18 de 26 tablas** — 7.034 doctores con teléfono, 1.046 pagos,
1.017 casos y 1.487 conversaciones de WhatsApp.

**Este es el único hallazgo de producción que hay que cerrar hoy**, y son dos minutos de consola:
Supabase → Authentication → Sign In / Providers → *Allow new users to sign up* = **off**.

## Estado de los criterios Go/No-Go, corregido

| # | Criterio | Dev | Prod |
|---|---|:---:|:---:|
| **G1** | Ninguna `SECURITY DEFINER` ejecutable por `anon` | 🟢 0 de 39 | 🔴 15 de 23 (ninguna devuelve datos) |
| **G2** | Ninguna RPC devuelve datos sin sesión | 🟢 0 de 12 | 🟢 las que filtraban no existen |
| **G3** | Alta pública apagada | 🔴 `false` | 🔴 `false` |
| **G5** | El schema de prod coincide con el de dev | — | 🔴 **no coincide** (prod ≈ 0022) |
| **G10** | Se sabe qué migración tiene cada base | 🟡 ledger creado, sin sembrar | 🔴 sin ledger |

## Lo que sigue, en orden

1. **Apagar el alta pública en las dos bases** (C-0 y V-2). Consola, 2 minutos cada una. Es lo
   único urgente que sale de acá.
2. **Sembrar el ledger de dev** con `0001`–`0027`. El runner exige terminal interactiva:
   `npx tsx scripts/db-migrate.ts --sembrar --hasta 0027`
3. **Decidir qué es producción.** Hoy tiene los datos reales y un schema viejo. O se la pone al
   día con `0023`–`0028` (y recién ahí un `0027` regenerado tiene sentido), o se acepta que la
   base que usa el equipo es dev y prod es un resto. Mientras la pregunta esté abierta, hay dos
   bases con 7.034 doctores reales y nadie sabe cuál manda.
4. **Registrar el ref de prod en `environments.json`** — hecho en esta sesión.

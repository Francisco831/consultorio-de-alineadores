# Pasar la operación a producción

**Estado al 13/8/2026.** Decisión de Pancho: **producción es la base que manda**. Faltan dos
pasos y los dos los tiene que hacer una persona en una terminal — no por burocracia, sino
porque el runner exige que alguien escriba el ref de producción a mano antes de escribir en
ella, y eso no se puede automatizar sin desarmar la protección.

## Qué falta, exactamente

| # | Paso | Estado |
|---|---|---|
| 1 | Apuntar `.env.local` a producción | Pendiente — decisión + edición manual |
| 2 | Aplicar `0029` y `0030` en producción | Pendiente — verificado en seco, corre limpio |
| 3 | Verificar con `security-checks` contra producción | Pendiente — depende de 1 y 2 |

Lo que **ya está** en producción, verificado el 13/8 con dos comandos de solo lectura:
schema idéntico al de desarrollo (26 tablas · 406 columnas · 77 funciones · 62 policies) y
**28 migraciones en el ledger**, la última `0027_function_grants.sql`.

## Antes de empezar: respaldo

No hay backups administrados (plan Free). El único respaldo es el que se corre a mano:

```
npx tsx scripts/backup-datos.ts
```

Escribe fuera del repositorio (`~/crm-mx-backups/<ref>-<fecha>/`) porque el volcado tiene
7.034 teléfonos y nombres de paciente.

## Paso 1 — apuntar la app a producción

En `.env.local`: comentar el bloque de desarrollo y descomentar el de producción. Son las
tres variables juntas —`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` y
`SUPABASE_SERVICE_ROLE_KEY`— y tienen que ser las tres de la misma base: `security-checks`
se niega a correr si la conexión a Postgres y las llamadas HTTP apuntan a proyectos
distintos, justamente para que ningún informe salga mezclando dos bases.

Conviene agregar también, para que el runner no pruebe región por región:

```
SUPABASE_DB_HOST=aws-0-us-east-2.pooler.supabase.com
```

Producción vive en **us-east-2** y desarrollo en **ca-central-1**. No comparten región.

**La consecuencia que hay que decidir a conciencia:** todo lo que la capa AI escribió hasta
hoy —`agent_runs`, `ai_recommendations`, `doctor_ai_profile`— está en **desarrollo** y no
viaja solo. Después de la mudanza, producción arranca sin ese historial. Si importa
conservarlo, hay que moverlo antes; si no, se pierde el registro de por qué la IA recomendó
lo que recomendó hasta esta fecha.

Verificar antes de seguir (no se conecta a nada):

```
npx tsx scripts/db-migrate.ts --print-target
```

Tiene que decir `entorno : PRODUCCION`. Si dice otra cosa, parar.

## Paso 2 — aplicar las dos migraciones pendientes

Siempre en tres tiempos. El modo por defecto no escribe.

```
npx tsx scripts/db-migrate.ts --dry-run
```

Corre las pendientes en una transacción y las revierte. Ya se hizo contra producción el
13/8: `0029` y `0030` dieron OK, y las otras 28 figuran como ya aplicadas.

```
npx tsx scripts/db-migrate.ts --apply
```

Va a pedir que **escribas el ref de producción** antes de tocar nada. `--yes` no alcanza acá
y es a propósito: hasta el 13/8 registrar producción en `environments.json` —hecho para
protegerla— tenía el efecto contrario y habilitaba `--apply --yes` sin preguntar nada.

Qué hace cada una:

- **`0029_hitl_ai_confirmado`** — los guards aceptan `ai_confirmado` además de `humano`, con
  la atribución a `auth.uid()` intacta. Sin esto, aceptar una clasificación propuesta por la
  IA falla siempre y la recomendación queda quemada en estado `aceptada`. Es el circuito HITL
  del que dependen los dos tipos de recomendación que los agentes más producen.
- **`0030_guards_por_defecto`** — los guards de `alerts` y `ai_recommendations` pasan a
  proteger por defecto (lista de editables + diff jsonb). Cierra que cualquier no-VIEWER
  pudiera marcar una alerta como `is_demo` o reescribir el razonamiento de un agente.

Las dos tienen rollback en `supabase/rollbacks/`. El de `0029` reabre el bug a propósito y lo
dice en su cabecera: es de emergencia, no un camino de vuelta cómodo.

## Paso 3 — verificar

```
npm run test:seguridad
```

Escribe solo dentro de transacciones que siempre revierte. Contra desarrollo hoy da
**6 OK · 1 FALLA · 1 PENDIENTE**. En producción debería dar lo mismo:

- **Chequeo 5** tiene que decir OK. Si dice PENDIENTE, `0029` no quedó aplicada.
- **Chequeo 6** tiene que decir OK — es el que verifica que las pantallas usen `ai_forecast()`.
- **Chequeo 4 (PENDIENTE) y 8 (FALLA)** son el mismo tema y siguen abiertos también en
  desarrollo: el alta pública está cerrada por un toggle del panel de Supabase, sin allowlist
  en código que lo respalde. Es el paso R-3 del plan y no lo destraba esta mudanza.

Y el smoke test que ninguna herramienta reemplaza: entrar a `/dashboard`, `/hoy`, `/pipeline`,
`/doctores/[id]` y `/calidad` con una sesión real y confirmar que los números tienen sentido.
En el tablero, "Pagados / objetivo" sale del ledger de pagos y "Casos nuevos" de los casos
ingresados: son dos métricas distintas y ahora están etiquetadas como tales.

## Después

Anotar en [`supabase/HOTFIX_LOG.md`](../supabase/HOTFIX_LOG.md) que `0029` y `0030` quedaron
aplicadas en producción, con la fecha y la salida real. La regla del archivo es que una fila
sin salida verificada no cuenta como aplicada.

# Operar el CRM

Cómo migrar, verificar y recuperar. Corto a propósito: si algo acá no se entiende en
una lectura, está mal escrito.

## Las dos bases

El host del pooler es **idéntico** para desarrollo y producción (los dos proyectos viven en
`ca-central-1`). El único discriminante es el `project_ref`. Está registrado en
[`supabase/environments.json`](../supabase/environments.json).

Un ref que no figura ahí se trata como **desconocido** y exige confirmación escrita, aunque se
pase `--yes`. Es deliberado: adivinar acá es el camino corto para escribir en producción
creyendo que es desarrollo.

> **Producción está registrada en `supabase/environments.json`, y aun así toda corrida contra
> ella pide confirmación escrita** — `--yes` no alcanza. Registrarla la identifica; no la
> destraba. (Hasta el 13/8/2026 pasaba lo contrario: estar registrada habilitaba `--apply --yes`
> sin preguntar nada.)

## Antes de migrar por primera vez: sembrar el ledger

**Solo una vez por base, y solo en bases que ya tenían migraciones aplicadas.** Desarrollo es
una de esas: tiene `0001`–`0027` puestas desde antes de que el ledger existiera.

El ledger nace vacío. Vacío significa "no hay nada aplicado", así que el runner intentaría
re-aplicar desde `0001` — y `0001_extensions_enums.sql` hace `create type … as enum`, que
Postgres no admite con `if not exists`. Muere con *"already exists"* en el archivo 1 de 28.

```bash
npx tsx scripts/db-migrate.ts --sembrar --hasta 0027
```

Escribe las filas del ledger **sin ejecutar una sola línea** de esas migraciones. Es una
afirmación sobre el pasado, así que el runner lista exactamente qué va a marcar y pide que
escribas `sembrar` para confirmar.

> Si la base es **nueva** y de verdad no tiene nada aplicado, no sembrés: `--apply` crea el
> ledger y aplica todo. El runner frena si detecta un ledger casi vacío con 28 migraciones
> por delante, justamente para que esta decisión sea explícita.

## Migrar

Siempre en tres pasos, en este orden:

> **Antes de poner al día una base atrasada, usá `--ensayo` y no `--dry-run`.** El `--dry-run`
> revierte cada archivo antes del siguiente: valida archivos sueltos, así que una migración que
> use algo creado por la anterior falla ahí aunque la cadena entera sea correcta. El `--ensayo`
> corre **todas** las pendientes en una sola transacción y la revierte al final, así que cada una
> ve lo que dejó la anterior. Tampoco escribe nada.

```bash
npx tsx scripts/db-migrate.ts --print-target
```
Dice a qué base apuntaría. **No se conecta.**

```bash
npx tsx scripts/db-migrate.ts --dry-run
```
Corre las migraciones pendientes de verdad, cada una en una transacción que **siempre**
termina en `ROLLBACK`. Si algo no compila o choca, se entera acá sin escribir nada.

> Cada archivo se revierte antes de que corra el siguiente. Una migración que dependa de la
> anterior va a fallar en seco aunque la cadena completa sea correcta. `--dry-run` valida
> **una** migración pendiente bien; una cadena de varias, no.

```bash
npx tsx scripts/db-migrate.ts --apply
```
Recién esto escribe. **Sin `--apply` el runner nunca escribe** — el modo por defecto es
`--dry-run`.

Para un archivo puntual, va como argumento:
`npx tsx scripts/db-migrate.ts supabase/migrations/0027_function_grants.sql --apply`

### Qué garantiza el runner

- **Atomicidad.** Cada archivo corre en una transacción junto con su fila del ledger. O quedan
  las dos cosas o no queda ninguna: el ledger no puede decir que algo se aplicó si el SQL
  falló a la mitad.
- **Idempotencia.** Lo que ya está en el ledger se saltea. No depende de que cada migración
  sea idempotente por su cuenta.
- **Detección de divergencia.** Si un archivo cambió después de haberse aplicado, la corrida
  **frena**. El repo y la base estarían diciendo cosas distintas, y eso solo se descubre
  cuando alguien recrea la base desde cero. Se destraba con `--permitir-divergencia`, a
  conciencia y sabiendo por qué.

### El ledger

`ops.schema_migrations` — filename, checksum, cuándo, quién y cuánto tardó.

Vive en el schema `ops`, no en `public`, porque PostgREST expone `public` por HTTP y la
aplicación no tiene ningún motivo para ver esta tabla.

```sql
select filename, applied_at, applied_by from ops.schema_migrations order by filename;
```

Si el ledger no existe, el runner lo crea aplicando `0028_migration_ledger.sql` antes que nada
—salvo en `--dry-run`, donde esa creación también se revierte, y salvo si lo único que se pidió
correr son rollbacks, que no lo usan.

Para ver contra qué base estás hablando y en qué estado está el ledger, sin correr ningún SQL:

```bash
npx tsx scripts/db-migrate.ts --check-connection
```

### Los rollbacks

Viven en [`supabase/rollbacks/`](../supabase/rollbacks/), **no** en `supabase/migrations/`.
Estuvieron mezclados y una corrida sin argumentos aplicaba `0027` e inmediatamente después su
propio rollback, en orden alfabético. El runner además los filtra por nombre.

Un rollback se corre siempre nombrándolo:
`npx tsx scripts/db-migrate.ts supabase/rollbacks/0027_function_grants_rollback.sql --apply`

El runner **no anota los rollbacks en el ledger**: no son migraciones aplicadas, y en el caso
de `0028` era además imposible (el rollback borra la tabla, así que el insert posterior abortaba
la transacción y revertía el propio rollback).

> Ningún rollback de este proyecto puede devolver `EXECUTE` a `PUBLIC` o `anon`. Si alguna vez
> hiciera falta, es una decisión aprobada y escrita, no el efecto lateral de correr un archivo
> llamado "rollback".

## Verificar

```bash
npm run typecheck   # tsc --noEmit
npm test            # decisiones del runner; no toca la red ni ninguna base
npm run build
npm run lint        # 19 errores preexistentes: es material de la Etapa 4
```

Los tres primeros corren solos en CI ([`crm-mx-ci.yml`](../../.github/workflows/crm-mx-ci.yml))
ante cualquier cambio en `crm-mx/`. **CI no toca ninguna base y no tiene secretos.**

Los chequeos que sí necesitan Postgres van a mano, contra desarrollo:

```bash
npm run test:seguridad
```

Ocho chequeos. No escribe: lo que necesita probar escrituras va en transacciones que siempre
terminan en `rollback`, y de las respuestas HTTP mira **solo el status**, nunca el cuerpo, así
que ningún nombre de doctor o de paciente entra en la salida.

> **Hoy no puede dar verde, y no es un error.** Sale con código 1 si hay algo en `FALLA` **o en
> `PENDIENTE`**, y quedan tres pendientes conocidos (allowlist de altas, guards de clasificación,
> forecast con fuente única) más el chequeo 3 en `FALLA` hasta que se apague el alta pública en
> la consola de Supabase. Todavía no sirve como puerta de CI; sirve como tablero. Usá
> `--baseline` para que reporte sin fallar.

El chequeo 4 intenta un alta en `auth.users` dentro de una transacción revertida. Está apagado
salvo que se pase `--probar-altas`.

## Recuperar

**Una migración falló a la mitad.** No puede pasar: la transacción se revierte sola y el
ledger no registra la fila. Corregí el archivo y volvé a correr `--dry-run`.

**Una migración se aplicó y rompió algo.** Buscá su rollback en `supabase/rollbacks/`. Si no
hay, escribilo antes de tocar nada.

**Los permisos de funciones rompieron una pantalla.** Está documentado aparte, con el árbol de
decisión completo: [`SMOKE_TEST_permisos.md`](SMOKE_TEST_permisos.md). Resumen: agregar el
`grant` que falta es casi siempre mejor que correr el rollback.

**Respaldos.** Respondido: el proyecto está en plan **Free**, o sea **sin backups administrados
ni PITR**. El único respaldo es el que se corre a mano con `scripts/backup-datos.ts`, que vuelca
cada tabla a NDJSON fuera del repositorio. **Nunca se probó una restauración**, así que sigue sin
haber un plan de recuperación verificado — hay una herramienta, no un procedimiento probado.

## Lo que este documento no cubre

- **Dónde corre la aplicación.** Hoy: `npm run dev` en la máquina de Pancho. No hay despliegue.
  Es el paso V-5 del plan.
- **Crear usuarios.** `scripts/create-users.ts`. Imprime contraseñas iniciales una sola vez.
  Desde `0031` hay una allowlist: un alta cuyo mail no esté invitado aborta con
  `Alta no autorizada`. El script invita solo a los de su propia lista; para cualquier otro,
  primero `insert into auth_allowlist (email, note) values ('...', 'motivo');` y después el
  alta. Sacar un mail de la lista NO echa a nadie: el trigger es AFTER INSERT y no vuelve a
  correr para quien ya existe.
- **La capa de IA.** [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md).

## Actualización automática desde Noloco

Desde el 19/8/2026 el CRM se actualiza solo: un cron de Vercel (`vercel.json`) llama a
`/api/sync/noloco` **cada 2 horas**. La ruta baja todos los casos MEXICO de Noloco
(ks-indicadores), pasa un gate anti-regresión (un mes cerrado no puede volver con menos
casos I_1 que los ya guardados; un payload < 900 casos es un fetch truncado) y hace el
mismo upsert que el import manual — la lógica es literalmente la misma:
[`lib/noloco-sync.ts`](../lib/noloco-sync.ts), compartida entre el script y la ruta.

- Cada corrida queda en `sync_runs` (source `noloco`): las OK y las que frenó el gate.
- Los scores pueden quedar hasta 24 h atrás si `recompute_all` corta por timeout: los
  cierra el pg_cron nocturno `crm-recompute-nightly` (11:00 UTC), verificado activo.
- Secretos que necesita en Vercel (production): `CRON_SECRET`,
  `KEEPSMILING_EMAIL`, `KEEPSMILING_PASSWORD`. Se cargan una sola vez con
  `bash scripts/configurar-sync-vercel.sh` (también guarda `CRON_SECRET` en `.env.local`).
- Actualizar YA sin esperar al cron:
  `curl -H "Authorization: Bearer $CRON_SECRET" https://crm-mx-puce.vercel.app/api/sync/noloco`
- Qué NO cubre: casos que todavía no llegaron a Noloco. El circuito del equipo (planilla
  "Control de casos Mex") va días adelante de Noloco — un caso recién subido a la intranet
  puede tardar días en aparecer acá. Ese hueco es de la fuente, no del cron.

El import manual (`scripts/import-noloco.ts`) sigue existiendo para correcciones puntuales:
mismo upsert, pero con el gate EXPECTED (conteos de Juan) y confirmación de destino.

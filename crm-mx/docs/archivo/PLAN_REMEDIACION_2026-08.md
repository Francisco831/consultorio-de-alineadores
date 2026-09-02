# Plan de remediación — CRM KeepSmiling México · **v2**

**Proyecto:** `crm-mx/` · **Commit:** `5e7fc72`, rama `crm-mx-ai`
**Fecha:** 10 de agosto de 2026 · **Diagnóstico base:** `AUDITORIA_CRM.md` (revisión 2, aprobada)

> **Estado real al 13/8/2026.** Este encabezado se corrigió dos veces; la versión de abajo
> (11/8) también quedó vieja. Lo verificado hoy, con dos comandos de solo lectura:
>
> - **Los schemas de las dos bases COINCIDEN** (`diff-entornos`, exit 0): 26 tablas, 406
>   columnas, 77 funciones y 62 policies en ambas. La afirmación "prod ≈ 0022" que sostenía
>   este documento y `environments.json` era falsa desde el 11/8.
> - **El ledger de producción tiene 28 migraciones**, la última `0027`. O sea: **V-3 no está
>   detenido, está hecho**, y CRIT-01 está cerrado también en producción.
> - Pendientes en prod: `0029` (HITL) y `0030` (guards), aplicadas en desarrollo el 13/8.
> - **R-4 (ALT-02) está CERRADO**: migración `0029`, con el chequeo 5 de `security-checks`
>   pasando de PENDIENTE a OK contra la base real.
> - **Decisión de Pancho (13/8): producción es la base que manda.** La app todavía apunta a
>   desarrollo; mudarla es el paso que queda.
>
> Detalle en [`supabase/HOTFIX_LOG.md`](supabase/HOTFIX_LOG.md).
>
> ---
>
> **Estado al 11/8/2026 — este encabezado decía "nada de esto está aplicado" y ya no es
> cierto.** Corregido en la sesión de consolidación:
>
> - **`0027` y `0028` están aplicadas en desarrollo**, las dos por accidente y en días distintos.
>   La causa y el arreglo de cada una están en [`supabase/HOTFIX_LOG.md`](supabase/HOTFIX_LOG.md).
> - **La Fase V nunca estuvo bloqueada por falta de credenciales**: las de producción están en
>   `.env.local`, comentadas. **V-1 ya se ejecutó** → [`docs/V1_PRODUCCION.md`](docs/V1_PRODUCCION.md).
> - **V-3 (aplicar `0027` en prod) queda detenido** por la cláusula de §7: el schema de producción
>   no coincide con el de desarrollo (prod ≈ `0022`).
> - **CRIT-01 no está presente en producción** — las RPC que filtraban datos son las de `0023` y
>   ahí no existen. **CRIT-02 sí lo está**, y es el único hallazgo urgente de prod.
>
> El resto del documento se conserva tal como fue aprobado.

El diagnóstico está aprobado y no se rediscute acá. Este documento es solo el plan de ejecución.

---

## Qué cambió respecto de la v1 del plan

| # | Observación | Qué hice |
|---|---|---|
| 1 | Dependencia circular (el ledger antes de P0-2/P0-4, pero el ledger en P1) | **Resuelta con la estrategia (b)**, y con una parte de la (a) adelantada. §5 explica por qué el ledger nunca fue prerrequisito real de un archivo único, explícito e idempotente — y qué sí lo es |
| 2 | La contención no puede esperar al análisis de producción | El plan pasa a **tres fases**: **Fase C** (contención, mismo día), **Fase V** (verificación y contención de producción) y **Fase R** (remediación definitiva versionada). §6 y §7 |
| 3 | No devolver una recomendación fallida a `propuesta` | Aceptado, y encontré una segunda razón: el índice único parcial `ai_recommendations_dedupe_idx` (`0017:60-62`) solo cubre `status='propuesta'`, así que volver a ese estado puede **violar el índice** si mientras tanto entró otra propuesta igual. Máquina de estados completa en §8.1, con idempotencia y transacción por tipo de payload |
| 4 | Limpiar el demo no es requisito para arreglar el forecast | Correcto y verificado: `ai_forecast()` (`0023:305-314`) ya filtra `not is_demo` en las cuatro subconsultas. Las dos tareas quedan **desacopladas** en §8.4 |
| 5 | Falta el diseño de la allowlist | Diseño completo en §8.2, con las seis preguntas respondidas. La respuesta clave sale de un hecho verificado: `on_auth_user_created` es **AFTER INSERT** (`0003:61-63`), así que sacar un mail de la allowlist **no puede echar a nadie** |
| 6 | Un README no cierra el punto de privacidad | El criterio de cierre pasa a cinco condiciones, tres de ellas externas y con responsable nombrado. No se elige ni se afirma ninguna base legal desde el código. §8.3 |
| 7 | Adelantar las pruebas mínimas | `scripts/security-checks.ts` se escribe en la **Fase C**, antes del primer cambio de permisos, y es lo que verifica ese cambio. §9 |
| 8 | Frases residuales de "no hay respaldo" | Corregidas en `AUDITORIA_CRM.md` (§12 punto 4, checklist G6 y la etiqueta de G4). La formulación es ahora: *no existe un respaldo verificado ni una restauración probada* |

**Un cambio de alcance que conviene señalar.** La v1 ponía la minimización de datos como tarea P0. Sigue
siendo obligatoria, pero no es contención: no hay nada que contener, porque `ANTHROPIC_API_KEY` está vacía y
`agent_runs` tiene 0 filas. Pasa a ser un **candado** (§8.3): la clave no se carga hasta que el criterio esté
cumplido. Eso libera espacio en la fase urgente para lo que sí está expuesto ahora mismo.

---

## 1. Hallazgos consolidados

59 hallazgos: 2 críticos, 7 altos, 28 medios, 22 bajos. La primera versión del informe tenía 66; ocho eran
duplicados y se consolidaron, y se agregó un crítico nuevo que antes figuraba como condicional.

### IDs retirados — ninguno se reutilizó

| ID retirado | Absorbido por | Motivo |
|---|---|---|
| ALT-05 | **ALT-01** | Mismo problema (migraciones sin ledger ni idempotencia), otra redacción |
| ALT-08 | **ALT-01** | Subcaso: el runner no identifica contra qué base corre |
| ALT-06 | **CRIT-02** | Se verificó la premisa que lo tenía en condicional; sube a crítico |
| MED-24 | **MED-01** | Mismas citas, mismo hallazgo, dos categorías |
| BAJ-09 | **MED-08** | Mismo hallazgo (sin gate de calidad), misma cita |
| BAJ-05 | **MED-10** | Subcaso: las acciones de `admin.ts` |
| BAJ-10 | **MED-10** | Duplicado de BAJ-05, mismo archivo |
| BAJ-16 | **MED-15** | Mismo botón, mismas citas |

### Los 9 hallazgos que gobiernan el plan

| ID | Título corto | Severidad | Estado |
|---|---|---|---|
| **CRIT-01** | 30 de 39 funciones `SECURITY DEFINER` con EXECUTE público; 12 devuelven datos sin sesión | Crítica | Confirmado por ejecución |
| **CRIT-02** | Alta pública encendida + todo autenticado lee toda la base | Crítica | Confirmado (salvo el alta real, no ejecutada a propósito) |
| **ALT-01** | Migraciones sin ledger, no re-ejecutables, runner que no dice qué base toca | Alta | Confirmado |
| **ALT-02** | Aceptar una recomendación de clasificación falla siempre y no se puede reintentar | Alta | Confirmado por ejecución |
| **ALT-03** | El Forecast del tablero es 96 % demo: muestra 19 cuando el real es 6 | Alta | Confirmado y cuantificado |
| **ALT-04** | La probabilidad no se recalcula al mover de etapa | Alta | Confirmado |
| **ALT-07** | Cero tests sobre lo que escribe en la base | Alta | Confirmado |
| **ALT-09** | Sin procedimiento de respaldo documentado; backups administrados sin verificar | Alta | **Mixto** |
| **ALT-10** | El prompt lleva teléfono y nombres de paciente; la clave está vacía y nada salió aún | Alta | **Mixto** |

---

## 2. Evidencia corregida respecto de la primera versión

| Afirmación anterior | Corrección | Cómo se verificó |
|---|---|---|
| "15 de 16 funciones `ai_*` ejecutables por `anon`" | 39 `SECURITY DEFINER` en `public`; **30 con EXECUTE para PUBLIC**; 15 invocables por RPC; **12 devuelven datos sin sesión**, dos con nombre de paciente. Tres de las "16 ai_*" ni siquiera eran SECURITY DEFINER | `pg_proc` + `aclexplode` + 20 llamadas HTTP |
| "Si el signup está habilitado (es el default)…" | **Está habilitado**: `disable_signup: false` | `GET /auth/v1/settings` |
| "`ANTHROPIC_API_KEY` no está cargada" / "está presente" | La variable **existe con valor vacío**; `aiConfigured()` devuelve false; ningún agente corrió nunca | Parseo de `.env.local` sin imprimir valores + `agent_runs` = 0 filas |
| "No hay respaldo de nada" | Confirmado: no hay documentación, procedimiento ni exportación. **No verificado**: si Supabase tiene backups administrados, ni si alguna vez se restauró | grep exhaustivo; el resto depende del plan contratado |
| "No existe artefacto de despliegue" | Confirmado: no hay procedimiento reproducible **en el repositorio**. **No verificado**: si la app está desplegada fuera de él | `ls` en ambos directorios |
| "El envío a Anthropic ocurre sin base legal" | Confirmado: el prompt incluye teléfono, WhatsApp y nombres de paciente. **No verificable desde el repositorio**: consentimiento, base legal, contrato con el proveedor y retención | Lectura de `context.ts` / `runner.ts`; el resto son documentos externos |
| "40 oportunidades demo, ~16 casos de inflado" | **39** demo, y el inflado real es **13 casos sobre un forecast de 19** (real: 6) | Consulta que replica la fórmula de `dashboard/page.tsx:187-191` |
| Desglose del lint (mezclaba errores y advertencias) | **19 errores + 3 advertencias**: 12 `no-explicit-any` (todos en `scripts/`), 7 `react-hooks/purity` (reportes 5, doctores 1, equipo 1), 3 `no-unused-vars` | `npx eslint . -f json` |
| "10 server actions devuelven void" (sin base) | Correcto, y ahora con el denominador: **28 acciones exportadas** en 11 archivos, 10 con firma `Promise<void>` | Conteo archivo por archivo |
| Riesgo de backups referenciado como ALT-10 | Es **ALT-09**; ALT-10 es privacidad | — |
| §6 citaba MED-04 para "VIEWER lee todo" | Es **MED-05**; MED-04 es la ausencia de capa de lecturas | — |

---

## 3. Contradicciones resueltas

**`ANTHROPIC_API_KEY`.** Era la contradicción interna del informe. Estado verificado, sin exponer el valor:

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿La variable existe? | **Sí**, la línea está declarada en `.env.local` | Lectura del archivo (solo nombres) |
| ¿Tiene valor no vacío? | **No: valor vacío**, longitud 0 | Parseo sin imprimir valores |
| ¿La aplicación puede cargarla? | **No.** `aiConfigured()` es `Boolean(process.env.ANTHROPIC_API_KEY)` (`lib/ai/db.ts:26-28`); la cadena vacía es falsy | Código |
| ¿Qué pasa en runtime? | Las 3 rutas cortan con 503; `runner.ts:170-171` lanza excepción | Código |
| ¿Se hizo alguna llamada real al modelo? | **Ninguna, nunca** | `agent_runs` = 0, `ai_recommendations` = 0, `doctor_ai_profile` = 0, `agent_handoffs` = 0 |

**Qué de la capa AI quedó verificado solo por lectura estática:** el bucle de tool-use de `runner.ts`
(reintentos, `HARD_REQUEST_LIMIT`, parseo del `emit`), la validación zod contra una salida real del modelo, el
cálculo de costo contra tokens reales, la persistencia en `agent_runs` / `ai_recommendations`, y el camino
HITL completo de `lib/actions/ai.ts` — de ahí que ALT-02 haya sobrevivido a la primera pasada sin detectarse.
Lo que **sí** está verificado por ejecución es la capa determinística: `scripts/eval-routing.ts` corre 32
escenarios + 20 regresiones sin modelo ni base, y pasa.

**"Apto para producción resuelto un solo hallazgo".** Falso, y corregido: hay dos críticos y siete cuestiones
sin verificar. El veredicto pasa a ser un checklist (§6), no una frase.

---

## 4. Riesgos confirmados vs. riesgos condicionales

### Confirmados — verificados contra el sistema, no inferidos

| # | Riesgo | Prueba |
|---|---|---|
| 1 | 12 endpoints RPC devuelven datos del negocio con la clave pública y sin sesión; dos incluyen **nombre de paciente** | 20 llamadas HTTP registradas (CRIT-01) |
| 2 | El alta pública de usuarios está encendida | `GET /auth/v1/settings` → `disable_signup: false` (CRIT-02) |
| 3 | Cualquier identidad autenticada —aun sin fila en `profiles`— lee las 26 tablas: 7.034 doctores, 1.046 pagos, 1.016 nombres de paciente | Transacción revertida con `set local role authenticated` (CRIT-02) |
| 4 | Aceptar una recomendación de clasificación levanta excepción siempre, deja la fila como aceptada y no se puede reintentar | Excepciones reproducidas en transacciones revertidas (ALT-02) |
| 5 | El Forecast del tablero muestra 19 casos cuando el número real es 6, y un gap de 5 cuando el real es 18 | Consulta que replica la fórmula del dashboard (ALT-03) |
| 6 | No hay forma de saber qué migración se aplicó a qué base, y correr el runner dos veces aborta | Lectura del runner + `grep schema_migrations` = 0 (ALT-01) |
| 7 | La probabilidad y la categoría de forecast nunca se recalculan al mover de etapa | Lectura de `opportunities_transition` (ALT-04) |
| 8 | Diez server actions se tragan todo fallo | Conteo y lectura de las 28 acciones (MED-10) |
| 9 | El lint falla y no hay ningún gate automático | `npx eslint .` exit ≠ 0; sin `.github/` (MED-08) |

### Condicionales — dependen de algo que no se pudo verificar

| # | Riesgo | De qué depende | Cómo se resuelve la incógnita |
|---|---|---|---|
| C1 | Que producción esté igual de expuesta que desarrollo | Del schema y los privilegios reales de la base de producción | Repetir contra prod la consulta a `pg_proc` y las llamadas HTTP |
| C2 | Que el signup de producción también esté abierto | De la configuración de Auth de ese proyecto | `GET /auth/v1/settings` contra prod |
| C3 | Que una pérdida de datos sea irrecuperable | Del plan de Supabase contratado y de si hay PITR | Mirar Settings → Database → Backups y anotarlo |
| C4 | Que un backup existente no sirva | De si alguna vez se restauró | Hacer una restauración de prueba y registrarla |
| C5 | Que el envío a Anthropic sea un incumplimiento | Del consentimiento, la base legal y el contrato con el proveedor | Revisar los documentos comerciales; hoy es discutible **y todavía no salió ningún dato** |
| C6 | Que el sistema se caiga sin que nadie se entere | De dónde corre realmente la aplicación | Responder por escrito dónde está desplegada |
| C7 | Que la capa AI se comporte distinto de lo analizado | De cargar una clave y correrla | Ejecutar los agentes contra dev con presupuesto acotado |

**Regla de lectura:** un riesgo condicional no es un riesgo menor. Es un riesgo cuyo tamaño no se conoce. C1
y C2 podrían ser peores que CRIT-01 y CRIT-02; hasta que se verifiquen, hay que asumir el peor caso.

---

## 5. La dependencia circular: por qué existía y cómo se rompe

### El diagnóstico del ciclo

La v1 decía dos cosas incompatibles:

```
P1-1 (ledger) ──> P0-2 (permisos), P0-4 (allowlist)     "sin ledger, aplicar una migración es un acto de fe"
P0-1 (verificar prod) ──> P1-1 (ledger)                 "la siembra depende del schema real de cada base"
```

O sea: para aplicar la migración urgente hacía falta el ledger, para el ledger hacía falta verificar
producción, y verificar producción no arreglaba nada mientras tanto. Un ciclo.

### Dónde estaba el error

El ciclo se apoyaba en una premisa falsa: *"no se puede aplicar ninguna migración sin ledger"*. Eso no es
cierto. El ledger protege contra **la corrida masiva y desatendida** — `npx tsx scripts/db-migrate.ts` sin
argumentos, que hoy recorre los 26 archivos y aborta en el primero (ALT-01, subcaso b). No protege ni hace
falta para aplicar **un archivo único, nombrado explícitamente, idempotente y que se verifica a sí mismo**,
que es exactamente lo que el runner ya soporta:

```bash
# 1. ver el destino sin conectarse
npx tsx scripts/db-migrate.ts supabase/migrations/0027_function_grants.sql --print-target
# 2. probar que aplica limpio, en una transacción que siempre revierte
npx tsx scripts/db-migrate.ts supabase/migrations/0027_function_grants.sql --dry-run
# 3. recién acá se escribe
npx tsx scripts/db-migrate.ts supabase/migrations/0027_function_grants.sql --apply
```

> Actualizado 10/8/2026, después del incidente que registra `supabase/HOTFIX_LOG.md`. El runner ya no aplica
> nada sin `--apply`: sin modo explícito hace `--dry-run`. El comando de una línea que estaba acá antes hoy
> no escribe.

Lo que **sí** es prerrequisito real de cualquier aplicación —masiva o no— es saber **contra qué base se está
corriendo**. Hoy el runner imprime `✓ conectado via aws-0-ca-central-1.pooler.supabase.com`, que es idéntico
para desarrollo y producción (`db-migrate.ts:26, 43, 50`). Ese es el riesgo concreto, y cuesta diez líneas
arreglarlo.

### Estrategia elegida: (b), con la parte barata de (a) adelantada

**Hotfix de seguridad controlado, registrado, y después incorporado al ledger inicial.** Con una condición
previa que no es negociable:

| Decisión | Qué implica |
|---|---|
| **Se adelanta a la Fase C** la identificación de base en el runner (parte de la opción (a)) | 10 líneas. Sin esto no se aplica **nada** a ninguna base. Es el único prerrequisito real |
| **NO se adelanta el ledger completo** | Requiere verificar el schema real de las dos bases para sembrarlo, y eso tarda. El ledger va en Fase R, sembrado con todo lo aplicado **incluido** `0027` |
| El hotfix se aplica **como archivo de migración numerado**, no como SQL suelto en la consola | Así hay un solo conjunto canónico de migraciones y el ledger después lo reconoce sin excepciones |
| El hotfix se registra en `supabase/HOTFIX_LOG.md` en el momento de aplicarlo | Ese archivo es el ledger provisorio: qué se aplicó, a qué base, cuándo, con qué salida y quién lo hizo |
| El hotfix trae su propio `0027_rollback.sql`, escrito y revisado **antes** de aplicar | Ver §11 |

### Grafo de dependencias resultante — sin ciclos

```
C-1  security-checks.ts (línea de base)
  └─> C-2  runner: imprime ref + exige confirmación      ← único prerrequisito de aplicar migraciones
        ├─> C-3  0027 en DESARROLLO
        │     └─> C-4  smoke test de la app en dev
        │           └─> V-3  0027 en PRODUCCIÓN
        └─> R-2  ledger (siembra: 0001–0027, por base)
              └─> R-3 … R-14  (toda migración posterior)

C-0  apagar signup en dev ────────────────────────────── independiente, sin migración, riesgo cero
V-1  verificar producción (solo lectura) ─────────────── independiente
  └─> V-2  apagar signup en prod
  └─> R-2  (la siembra del ledger necesita el schema real de prod)

R-5  forecast desde ai_forecast() ────────────────────── independiente de R-6 (ver §8.4)
R-6  limpieza de datos demo ──────────────────────────── requiere respaldo (R-14) antes de borrar
R-4  máquina de estados ──────────────────────────────── requiere R-2; incluye el arreglo de ai_confirmado y BAJ-02
R-13 minimización ────────────────────────────────────── candado de ANTHROPIC_API_KEY, no bloquea nada más
```

Ninguna flecha vuelve hacia atrás. `C-0` y `V-1` no dependen de nada y por eso van primero.

---

## 6. Fase C — Contención inmediata en desarrollo (mismo día)

**Por qué desarrollo primero y no producción.** No es una preferencia técnica: la base de desarrollo
**contiene datos reales** —7.034 doctores con teléfono, 1.046 pagos, 1.016 nombres de paciente— y es la que
está verificada como expuesta. Producción se verifica en la Fase V, en paralelo, pero contener dev no espera a
ese resultado. Además, aplicar primero en dev es lo que prueba que el cambio no rompe la aplicación antes de
tocar producción.

**Regla de la fase:** no se aplica ninguna migración masiva. Solo `0027`, por archivo explícito, después de
`C-2`.

| # | Acción | Responsable | Duración | Rollback | Prueba de cierre |
|---|---|---|---|---|---|
| **C-0** | **Apagar el alta pública en desarrollo.** Supabase → Authentication → Sign In / Providers → *Allow new users to sign up* = off | **Pancho** (consola) | 2 min | Volver a encender el toggle | `curl {URL}/auth/v1/settings -H "apikey: <anon>"` → `"disable_signup": true` |
| **C-1** | **Escribir `scripts/security-checks.ts`** con los 6 chequeos de §9 y correrlo para dejar la línea de base documentada | Implementación | 2 h | Borrar el archivo (no toca nada) | El script corre y reporta el estado actual: 30 funciones abiertas, 12 RPC en 200, signup on/off |
| **C-2** | **El runner identifica la base.** `db-migrate.ts` imprime `ref` y host **antes** de conectar y exige confirmación (o `--yes`) si el `ref` no es el de desarrollo | Implementación | 30 min | `git revert` del commit | Correr el runner con un archivo inocuo muestra el `ref` y pide confirmación al apuntar a prod |
| **C-3** | **Aplicar `0027_function_grants.sql` en desarrollo** por archivo explícito. Registrar en `supabase/HOTFIX_LOG.md` antes y después | Implementación + **Pancho** (aprueba la ventana) | 20 min | `0027_rollback.sql` (§11) | `security-checks` → chequeos 1 y 2 en verde |
| **C-4** | **Smoke test de la aplicación en desarrollo**, con sesión real: `/dashboard`, `/doctores/[id]`, `/calidad` (cola de casos y de interacciones), `/pipeline`, `/ajustes` | **Pancho** (única persona con la app corriendo) | 20 min | Si algo falla → C-3 rollback, ajustar la lista de `grant`, repetir | Las cinco pantallas cargan sin error; `/calidad` muestra la cola ordenada (esa es la que depende de `case_self_similarity`) |
| **C-5** | **`chmod 600 .env.local`** | **Pancho** (máquina local) | 1 min | `chmod 644` | `ls -l .env.local` → `-rw-------` |

**Criterio de salida de la Fase C:** chequeos 1, 2 y 3 de `security-checks` en verde contra desarrollo, y las
cinco pantallas funcionando.

---

## 7. Fase V — Verificación y contención de producción (mismo día, en paralelo)

**Por qué es una fase aparte.** Todo lo de acá necesita credenciales de producción, que solo tiene Pancho. Se
puede arrancar al mismo tiempo que la Fase C; lo único que no puede adelantarse es `V-3`, que espera el smoke
test de dev.

| # | Acción | Responsable | Duración | Rollback | Prueba de cierre |
|---|---|---|---|---|---|
| **V-1** | **Verificar producción, solo lectura:** `GET /auth/v1/settings`; la consulta de `pg_proc` con `has_function_privilege`; el listado de tablas, policies y funciones. Guardar las tres salidas | **Pancho** (credenciales) + Implementación (consultas) | 1 h | No aplica: solo lectura | Las tres salidas archivadas, y un `diff` contra las mismas consultas en dev |
| **V-2** | **Apagar el alta pública en producción** | **Pancho** (consola) | 2 min | Volver a encender el toggle | `GET /auth/v1/settings` de prod → `"disable_signup": true` |
| **V-3** | **Aplicar `0027` en producción** por archivo explícito, con la lista de `grant` ya validada en dev. Registrar en `HOTFIX_LOG.md` | Implementación + **Pancho** (aprueba y provee credenciales) | 20 min | `0027_rollback.sql` | `security-checks` apuntado a prod → chequeos 1 y 2 en verde |
| **V-4** | **Averiguar el estado real del respaldo:** Supabase → Settings → Database → Backups. Anotar plan, frecuencia, retención y si hay PITR | **Pancho** (consola) | 15 min | No aplica: solo lectura | Las cuatro respuestas escritas en el README. Esto cierra dos de las cinco filas de ALT-09 |
| **V-5** | **Responder por escrito dónde corre la aplicación** hoy: qué comando, en qué máquina, quién la reinicia | **Pancho** | 10 min | No aplica | Párrafo en el README. Cierra la fila "NO VERIFICADO" de MED-28 |

**Si `V-1` revela que producción tiene un schema distinto de desarrollo**, `V-3` se detiene y el plan se
recalcula: la lista de funciones de `0027` puede no coincidir. Ese es el motivo por el que `V-1` es lo primero
de esta fase.

**Criterio de salida de la Fase V:** las dos bases con signup apagado y sin funciones ejecutables por `anon`;
el estado del respaldo y del despliegue, escritos.

---

## 8. Diseños que hay que cerrar antes de escribir código

Cuatro decisiones de diseño que la v1 daba por obvias y no lo son. Ninguna se implementa hasta que estén
aprobadas.

### 8.1 Máquina de estados de recomendaciones

**Por qué no se puede volver a `propuesta`.** Dos razones, no una:

1. La que señalaste: si la escritura ocurrió pero se perdió la respuesta, reintentar duplica el efecto.
2. Una que estaba en el schema y la v1 no vio: `ai_recommendations_dedupe_idx` (`0017:60-62`) es un índice
   **único parcial** sobre `(doctor_id, agent, recommendation_type) where status = 'propuesta'`. Si mientras
   la recomendación estaba fallida entró otra propuesta del mismo agente para el mismo doctor y tipo, volver a
   `propuesta` **viola el índice** y el rollback falla con un error de constraint.

#### Estados

| Estado | Significado | Quién lo pone | Sale hacia |
|---|---|---|---|
| `propuesta` | Emitida por el agente, sin decidir | el runner (service-role) | `procesando`, `descartada`, `expirada` |
| `procesando` | Reclamada por un usuario; la ejecución arrancó | el usuario, en la transacción | `ejecutada`, `fallida_definitiva`, `fallida_reintentable` |
| `ejecutada` | El efecto ocurrió y está confirmado por su clave de deduplicación | la transacción, o el reconciliador | terminal |
| `aceptada` | Decidida sin efecto que ejecutar (`payload.kind = 'none'` o payload null) | la transacción | terminal |
| `fallida_definitiva` | Falló por algo que no va a cambiar reintentando | la transacción o el server action | terminal |
| `fallida_reintentable` | Falló por algo transitorio **y** se comprobó que el efecto no ocurrió | el reconciliador | `procesando` |
| `descartada` | El usuario la descartó con motivo | el usuario | terminal |
| `expirada` | Superada por una propuesta nueva | el runner | terminal |

Los cinco valores nuevos exigen ampliar el `check` de `0017:43-44`, que hoy solo admite
`('propuesta','aceptada','descartada','ejecutada','expirada')`.

#### La regla que pediste, hecha mecanismo

> *El reintento debe ser posible solo cuando pueda demostrarse que el efecto anterior no ocurrió.*

La demostración no es un juicio: es una consulta. Cada payload lleva una **clave de deduplicación** que apunta
de vuelta a la recomendación, y el reconciliador la busca:

| `payload.kind` | Clave de deduplicación | Cómo se hace idempotente | Transacción |
|---|---|---|---|
| `task` | **columna nueva** `tasks.recommendation_id uuid unique` | `insert … on conflict (recommendation_id) do nothing returning id`; si no devuelve fila, se lee la existente | dentro de la RPC |
| `activity` | **columna nueva** `activities.recommendation_id uuid unique` | ídem | dentro de la RPC |
| `case_subject` | `cases.id` + valor destino | El `update` fija valores constantes: aplicarlo dos veces da el mismo resultado (solo cambia `set_at`) | dentro de la RPC |
| `activity_classification` | `activities.id` + valor destino | ídem | dentro de la RPC |
| `profile_update` | `doctor_ai_profile.doctor_id` | `upsert` con los mismos campos: naturalmente idempotente | ver nota abajo |
| `none` | — | No hay efecto | trivial |

Las dos columnas nuevas son la pieza central: convierten *"¿se ejecutó?"* en
`select id from tasks where recommendation_id = $1`, que se puede responder siempre.

#### Transacción: una RPC `SECURITY INVOKER`

Hoy son tres viajes sueltos a la base (`ai.ts:84-95`, el payload, `:234-245`). La corrección es una función
plpgsql que haga reclamo + efecto + cierre en una sola transacción:

```sql
create function ai_accept_recommendation(p_id uuid)
returns jsonb language plpgsql
security invoker              -- ← INVOKER, no DEFINER: ver la nota
set search_path = public as $$ … $$;
```

**`SECURITY INVOKER` no es un detalle.** Si fuera `DEFINER`, correría como `postgres`, `auth.uid()` sería null,
`is_system()` daría true y los guards de 0024 y el `doctors_journey_sync` harían *early-return*: se perdería la
atribución humana y no se registrarían las conversiones del journey. Es exactamente la invariante que
`docs/AI_ARCHITECTURE.md` protege y que `lib/actions/ai.ts:4-6` documenta. Con `INVOKER`, PostgREST fija el rol
del JWT, RLS aplica, `auth.uid()` funciona y los triggers corren — y todo eso pasa a estar dentro de una única
transacción.

**Nota sobre `profile_update`.** `doctor_ai_profile` no tiene policy de escritura para clientes (`0017:197-198`:
solo service-role escribe). Hay dos caminos y hay que **elegir uno**:

| Opción | Qué implica | Recomendación |
|---|---|---|
| **A** — abrir una policy acotada de INSERT/UPDATE a `authenticated` con `can_write()`, más un guard trigger que fuerce `last_source='ai_confirmado'` y `updated_by = auth.uid()` | Todo queda en la misma transacción. Rompe la regla "solo service-role escribe tablas `ai_*`", que pasa a ser "…salvo el camino HITL, con guard de procedencia" — el mismo patrón que 0024 ya aplica a `cases` | **Recomendada.** Es coherente con lo que ya se hizo para `cases` |
| **B** — dejar `profile_update` fuera de la RPC, con service-role como hoy | Ese payload sigue sin ser atómico. Mitigado porque el `upsert` es idempotente, así que su reintento es seguro | Aceptable si la opción A se considera un riesgo |

#### Flujo completo

```
[propuesta]
   │  usuario aprieta Aceptar
   ▼
BEGIN (RPC security invoker)
   update … set status='procesando', claimed_at=now(), decided_by=auth.uid()
     where id=$1 and status in ('propuesta','fallida_reintentable')   ← 0 filas ⇒ ya la tomó otro
   validaciones duras ─────────────► si fallan: RAISE  ⇒ el server action marca [fallida_definitiva]
     · payload requiere doctor_id y rec.doctor_id es null
     · el case_id / activity_id NO pertenece a rec.doctor_id      ← BAJ-02, acá adentro
     · el tipo de actividad está fuera del enum
   efecto con clave de deduplicación
   update … set status='ejecutada', executed_ref=…, action_completed=true
COMMIT
   │
   ├─ COMMIT OK ──────────────────► [ejecutada]
   ├─ RAISE de validación ────────► rollback total; el action escribe [fallida_definitiva] + last_error
   └─ timeout / conexión perdida ─► la fila queda en [procesando] con claimed_at viejo
                                      │
                                      ▼  reconciliador (§ abajo)
                                   ¿existe el efecto por su clave?
                                      ├─ sí ─► [ejecutada]
                                      └─ no ─► [fallida_reintentable]   ← única puerta al reintento
```

**Importante:** cuando la transacción hace rollback, el reclamo también se revierte. Por eso el estado
`fallida_reintentable` no hace falta para los fallos que la base ve — solo para los que la base **no** ve,
que son exactamente aquellos en los que se perdió la respuesta.

#### El reconciliador

Un chequeo que corre al abrir `/hoy` o `/doctores/[id]` (o como job) sobre las filas en `procesando` con
`claimed_at < now() - interval '2 minutes'`:

```sql
-- para cada fila trabada, la pregunta es siempre la misma: ¿existe el efecto?
select exists (select 1 from tasks       where recommendation_id = r.id)
    or exists (select 1 from activities  where recommendation_id = r.id)
    or (r.payload->>'kind' = 'case_subject'
        and exists (select 1 from cases c
                    where c.id = (r.payload->>'case_id')::uuid
                      and c.case_subject_source = 'ai_confirmado'
                      and c.case_subject_set_by = r.decided_by))
```

Si existe → `ejecutada`. Si no → `fallida_reintentable`. Eso es "demostrar que el efecto no ocurrió".

#### Columnas y constraints nuevos

```
ai_recommendations: + claimed_at timestamptz
                    + attempt_count int not null default 0
                    + last_error text
                    ~ check(status in (… los 8 valores …))
tasks:              + recommendation_id uuid unique references ai_recommendations(id)
activities:         + recommendation_id uuid unique references ai_recommendations(id)
```

**Ojo con `ai_recommendations_guard`** (`0017:160-195`): enumera columna por columna lo que un cliente **no**
puede cambiar, así que cualquier columna nueva queda editable por omisión. Al agregar `claimed_at`,
`attempt_count` y `last_error` hay que decidir explícitamente cuáles puede tocar la sesión, y conviene
aprovechar para invertir el guard al patrón "protegido por defecto" que usa `cases_subject_guard`
(`0024:31-43`, con `to_jsonb(new) - editable`).

#### Y el arreglo original de ALT-02

Va dentro de este mismo cambio, con **allowlist positiva**:

```sql
if new.case_subject_source not in ('humano', 'ai_confirmado') then raise exception … end if;
```

No `<> 'import'`: con una negación, cualquier origen futuro entra por omisión.


### 8.2 Allowlist de altas

**El hecho que ordena todo el diseño.** `on_auth_user_created` es **AFTER INSERT** sobre `auth.users`
(`0003:61-63`), y corre en la misma transacción que el alta. Consecuencias, las dos verificadas leyendo la
migración:

- un `raise exception` adentro **aborta el alta completa** — el guard funciona;
- el trigger **solo se dispara al crear un usuario**, nunca después. Por lo tanto **sacar un mail de la
  allowlist no puede echar a nadie ni invalidar ninguna sesión**. Esa es la respuesta a "qué pasa si se
  elimina accidentalmente un email".

**El otro hecho que hay que respetar.** Los usuarios de hoy se crean con `scripts/create-users.ts`, que usa
`auth.admin.createUser` con service-role y pone el rol en `app_metadata`. Ese camino **también dispara el
trigger**, así que el guard tiene que dejarlo pasar — si no, la herramienta de invitación deja de funcionar.
La solución es que el mail esté en la allowlist *antes* de invitar, no una excepción para el admin API
(depender de `raw_app_meta_data` como escape sería confiar en que el cliente nunca pueda escribirlo).

#### Diseño

```sql
create table auth_allowlist (
  email       citext primary key,
  active      boolean     not null default true,
  added_by    uuid        references profiles(id),
  added_at    timestamptz not null default now(),
  removed_by  uuid        references profiles(id),
  removed_at  timestamptz,
  note        text
);
```

| Pregunta | Respuesta |
|---|---|
| **Cómo se cargan los usuarios actuales** | La propia migración se siembra desde `auth.users`, no desde una lista escrita a mano: `insert into auth_allowlist (email, note) select u.email, 'sembrado al crear la allowlist' from auth.users u on conflict do nothing;`. Es imposible dejar afuera a alguien que ya existe |
| **Quién agrega o quita** | `is_manager()` (hoy, solo ADMIN). Policy `for all to authenticated using (is_manager()) with check (is_manager())`; el resto solo lee. Interfaz en `/ajustes`, junto a los otros controles de manager |
| **Cómo funciona una invitación nueva** | Dos pasos, en este orden: (1) el manager agrega el mail en `/ajustes`; (2) se invita con `scripts/create-users.ts` o con el panel de Supabase. Si el paso 1 falta, el paso 2 falla con un mensaje claro en lugar de crear un usuario sin permiso |
| **Qué pasa si se elimina un email por accidente** | **Nada para los usuarios existentes**: el trigger es AFTER INSERT y no vuelve a correr. El único efecto es que ese mail no puede volver a darse de alta. Además el borrado es **lógico** (`active = false` + `removed_by` + `removed_at`), así que se revierte poniendo `active = true` |
| **Cómo se auditan los cambios** | Trigger `AFTER INSERT OR UPDATE OR DELETE` que escribe en `audit_log` con `entity='auth_allowlist'`, reusando `log_audit(...)`. Sirve además como primer caso de registro de borrados, que hoy no existe (MED-27) |
| **Cómo se prueba sin bloquear a los tres usuarios** | Con dos `insert into auth.users` en **transacciones revertidas**: uno con un mail de la allowlist (tiene que pasar) y otro con un mail ajeno (tiene que levantar excepción). Cero riesgo: los usuarios existentes no se re-insertan nunca, así que el guard no los toca. Se agrega como chequeo 4 de `security-checks.ts` |

#### El guard

```sql
-- dentro de handle_new_user, ANTES del insert en profiles
if not exists (select 1 from auth_allowlist a
               where a.email = new.email and a.active) then
  raise exception 'Alta no autorizada: % no está en la lista de invitaciones', new.email;
end if;
```

**Modo de despliegue en dos tiempos.** Para no correr el riesgo de romper el alta de usuarios el primer día:
primero se despliega el guard en **modo aviso** (`raise warning` + fila en `audit_log`) durante unos días, se
revisa que no haya falsos negativos, y recién entonces se cambia a `raise exception`. Es una línea de
diferencia y elimina el único riesgo real de este cambio.

**Qué NO reemplaza.** La allowlist es el respaldo en código, no el control principal. El control principal es
el toggle de `disable_signup` (C-0 / V-2). Los dos, no uno.


### 8.3 Privacidad: criterio de cierre y candado

**Postura del informe:** este plan **no elige ni afirma ninguna base legal**. Desde el código se puede
determinar qué datos saldrían y hacia dónde; nada más. Si se necesita una determinación legal, la toma una
persona con esa responsabilidad, no una auditoría técnica.

**Candado.** `ANTHROPIC_API_KEY` **no se carga** —ni en desarrollo ni en producción— hasta que las cinco
condiciones estén cumplidas. Hoy la variable está declarada con valor vacío y `agent_runs` tiene 0 filas: no
hay un solo dato enviado. Esa ventana no se repite; una vez cargada la clave, "editar dos líneas" pasa a ser
"editar dos líneas y decidir qué hacer con lo que ya se envió".

| # | Condición | Responsable | Qué la cierra |
|---|---|---|---|
| **P-1** | **Minimización técnica.** `context.ts:1266` deja de mandar el número: pasa a `tel: sí/no · WhatsApp: sí/no`. Decisión explícita sobre `patient_name` en `:1311` (seudónimo tipo "Paciente 1", o se justifica por escrito por qué el nombre es necesario) | Implementación | `grep -n 'Canales: tel' lib/ai/context.ts` sin el número, y `npx tsx scripts/eval-routing.ts` sigue en 32 + 20 |
| **P-2** | **Inventario de lo que sale.** Documento corto: qué campos exactos viajan en el prompt, de qué tablas, con qué volumen potencial, hacia qué proveedor y con qué modelo | Implementación (lo redacta) · **Pancho** (lo valida) | Documento en `docs/` referenciado desde el README, con la lista de campos generada del código, no de memoria |
| **P-3** | **Aprobación explícita del responsable de privacidad/legal** de KeepSmiling sobre P-2 | **Responsable de privacidad/legal de KeepSmiling (a designar; hoy no hay nadie asignado)** | Aprobación por escrito, fechada, referida a la versión concreta de P-2 |
| **P-4** | **Revisión del contrato y las condiciones del proveedor**: si hay contrato o DPA, qué dice sobre uso para entrenamiento, retención, subprocesadores y ubicación del tratamiento | **Pancho** con el responsable legal | Resumen de una página con las cuatro respuestas y el enlace al documento contractual |
| **P-5** | **Política de retención propia**, con job de purga: cuánto tiempo se conservan `agent_runs.result` y `ai_recommendations`, y qué se borra | **Pancho** decide el plazo · Implementación lo programa | Job de purga escrito y probado, y el plazo documentado |

**Lo que este plan afirma y lo que no.** Afirma que hoy el sistema **no minimiza** —manda un número de
teléfono a un tercero cuando el modelo nunca marca ni escribe, solo recomienda un canal— y que ese dato está
de más independientemente de cualquier consideración legal. No afirma que haya un incumplimiento: el
consentimiento, la base legal, el contrato y la retención del proveedor son documentos externos que no se
pudieron ver.


### 8.4 Forecast y limpieza de demo: desacoplados

Tenías razón y lo verifiqué en el archivo. `ai_forecast()` (`0023:305-314`) filtra `is_demo` en **las cuatro**
subconsultas, no solo en oportunidades:

```sql
from opportunities where not is_demo and stage not in ('ganada', 'perdida')   -- opp
from cases c, per     where not c.is_demo and c.is_new_case …                  -- nuevos
from payments p, per  where not p.is_demo and p.paid_at >= per.m …             -- pagados
from doctors d, per   where not d.is_demo and d.accredited_at >= per.m …       -- acred
```

Por lo tanto **apuntar las tres pantallas a la RPC corrige el KPI de inmediato, sin tocar un solo dato**. La
v1 hacía de la limpieza un prerrequisito y estaba mal.

Quedan como dos tareas independientes:

| | **R-5 · Corregir la métrica** | **R-6 · Limpiar el demo** |
|---|---|---|
| Qué hace | `/dashboard`, `/hoy` y `/pipeline` llaman a `ai_forecast()` en vez de recalcular en JS | Resuelve las 282 filas `is_demo` que cuelgan de doctores reales |
| Toca datos | **No.** Solo lectura | **Sí.** Borra filas |
| Urgencia | Alta: hoy la pantalla dice 19 y el número real es 6 | Media: molesta, pero ya no afecta al KPI una vez hecho R-5 |
| Requiere respaldo previo | No | **Sí** (R-14) |
| Reversible | Sí, `git revert` | Solo con respaldo |
| Prueba de cierre | Las tres pantallas y `select ai_forecast(null)` dan el mismo número | `select count(*) from opportunities where is_demo` → 0, y los conteos previos guardados |

**Cómo hacer R-6 reversible.** Antes de borrar: `create table demo_purge_backup_YYYYMMDD as select …` con las
282 filas de las cuatro tablas (39 oportunidades, 197 actividades, 24 tareas, 22 alertas), o un `pg_dump` de
esas tablas. Recién entonces el `delete`. La tabla de respaldo se conserva 30 días y después se borra. Sin
eso, R-6 no se ejecuta.

**Un detalle que hay que decidir, no adivinar.** Las 282 filas cuelgan de **doctores reales** y no hay ningún
doctor `is_demo`. Antes de borrar hay que confirmar que ninguna de esas filas es trabajo real que alguien
marcó mal — sobre todo las 197 actividades, que son la timeline que la capa AI usa para medir contacto. Una
revisión de una muestra de 20 filas por tabla, hecha por Pancho, alcanza para decidir.

---

## 9. Pruebas mínimas, adelantadas

**Dónde van.** `scripts/security-checks.ts` se escribe en **C-1**, o sea *antes* del primer cambio de
permisos, y es lo que verifica ese cambio. No hace falta instalar vitest ni playwright para eso: el proyecto
ya corre scripts con `tsx` y ya tiene `pg` y `dotenv`. Instalar un framework de tests es P2 y no puede
bloquear la contención.

**Cómo se corre:** `npx tsx scripts/security-checks.ts [--base dev|prod]`. Sale con código ≠ 0 si algún
chequeo falla, así que sirve igual desde la consola que desde un CI.

| # | Chequeo | Fase | Qué afirma | Cómo lo verifica |
|---|---|---|---|---|
| **1** | Permisos de funciones | **C-1** (línea de base) → verde en **C-3** / **V-3** | Ninguna función `SECURITY DEFINER` de `public` es ejecutable por `anon` | `select count(*) … where n.nspname='public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')` → 0 |
| **2** | Exposición HTTP | **C-1** → verde en **C-3** / **V-3** | Ninguna RPC devuelve datos sin sesión, y la app sigue funcionando con sesión | Las 12 RPC con la clave anónima → 401. Control: las mismas con un JWT válido → 200. Control: `GET /rest/v1/doctors` sin sesión → 401 |
| **3** | Alta pública | **C-1** → verde en **C-0** / **V-2** | El signup está apagado en las dos bases | `GET /auth/v1/settings` → `"disable_signup": true` |
| **4** | Allowlist de altas | **R-3** | Un alta fuera de la allowlist se rechaza; una de adentro pasa | Dos `insert into auth.users` en transacciones **revertidas**: mail permitido → OK, mail ajeno → excepción |
| **5** | Guards de clasificación | **R-4** | `'ai_confirmado'` se acepta, `'import'` se rechaza, y un caso de otro doctor se rechaza | Tres `update` en transacciones **revertidas** con `set local role authenticated` |
| **6** | RLS y forecast | **C-1**, y de nuevo en **R-5** | `anon` no lee ninguna tabla; un autenticado sin perfil no puede escribir; y el forecast tiene una sola definición | `anon` sobre `doctors` → 401. Con `role authenticated` y un `sub` inexistente: `can_write()` = false. Y ninguna página recalcula el forecast en JS (chequeo textual sobre `.from("opportunities")` en `app/**/page.tsx`, al estilo del que ya hace `harness.ts`) |

**Nota honesta sobre el chequeo 6.** El modelo de lectura de hoy es "todo autenticado lee todo" y este plan
**no lo cambia** (ver §14). El chequeo por lo tanto afirma lo que debe ser cierto hoy —que `anon` no lee nada
y que un autenticado sin perfil no escribe— y no lo que uno querría que fuera cierto. Si más adelante se
decide restringir la lectura, el chequeo se endurece ahí.

**Qué NO cubre esto y sigue en P2:** los agregados `ai_*` contra un dataset fijo (ALT-07), la interfaz, la
accesibilidad y la capa AI con un modelo real. Decirlo explícitamente es parte del entregable: estas seis
pruebas cubren la seguridad y los guards, no la correctitud de los números.

---

## 10. Fase R — Remediación definitiva versionada

Empieza cuando las fases C y V están cerradas. Acá sí se usa el runner con ledger.

### R1 — Base operativa (habilita todo lo demás)

| # | Tarea | Responsable | Cierra | Prueba de cierre |
|---|---|---|---|---|
| **R-1** | Convertir `0027` de hotfix a migración normal: verificar que el archivo aplicado y el del repositorio son idénticos (checksum) | Implementación | ALT-01 | El checksum del archivo coincide con lo registrado en `HOTFIX_LOG.md` |
| **R-2** | **Ledger de migraciones**: tabla `schema_migrations(filename, applied_at, checksum)`, runner que aplica solo lo faltante con una transacción por archivo y falla si cambió un checksum. Sembrar **por base**, con el schema real de cada una a la vista (salida de V-1) | Implementación · **Pancho** aprueba la siembra de prod | ALT-01, G10 | `select * from schema_migrations` en dev y prod; correr el runner dos veces seguidas no hace nada la segunda |

### R2 — Correctitud y seguridad de datos

| # | Tarea | Responsable | Cierra | Prueba de cierre |
|---|---|---|---|---|
| **R-3** | **Allowlist de altas** según §8.2, desplegada primero en modo aviso | Implementación · **Pancho** carga los mails | CRIT-02, G4 | Chequeo 4 de `security-checks` |
| **R-4** | **Máquina de estados + idempotencia + ALT-02 + BAJ-02** según §8.1 | Implementación · **Pancho** decide entre las opciones A y B de `profile_update` | ALT-02, BAJ-02, BAJ-06, G8 | Chequeo 5 · una recomendación aceptada dos veces produce un solo efecto · una fila trabada en `procesando` se reconcilia sola |
| **R-5** | **Forecast desde `ai_forecast()`** en las tres pantallas | Implementación | ALT-03, MED-07, MED-16, G9 | Chequeo 6 · las tres pantallas y la RPC dan el mismo número |
| **R-6** | **Limpieza del demo** con respaldo previo, según §8.4 | Implementación · **Pancho** revisa la muestra y autoriza | MED-15 (parcial) | `select count(*) from opportunities where is_demo` → 0, con la tabla de respaldo creada |
| **R-7** | **Recalcular probabilidad y categoría al mover de etapa** | Implementación | ALT-04 | Mover una tarjeta en `/pipeline` cambia su probabilidad y su columna de forecast |
| **R-8** | **Errores visibles**: las 10 acciones `void` devuelven `{ok}`/`{error}` y la UI lo muestra | Implementación | MED-10, G12 | Provocar un fallo en cada una: las 10 muestran mensaje |
| **R-9** | **Confirmación en la purga de demo** (Dialog con conteos de un dry-run) | Implementación | MED-15 | El botón exige confirmación y el dry-run coincide con el borrado |
| **R-10** | **Idempotencia de `completeTask`** (`.eq("status","pendiente")` + chequear el error del insert) | Implementación | MED-02 | Completar dos veces produce un solo efecto |
| **R-11** | **Límite de tasa y tope de gasto** en las 3 rutas AI + cota de longitud de `question` | Implementación | MED-01, G13 | Superar el límite devuelve 429 |
| **R-12** | **`error.tsx`, `not-found.tsx`** y distinguir error de vacío en las listas | Implementación | MED-13, MED-14 | Un error de consulta se muestra como error, no como "sin resultados" |

### R3 — Cierre de los puntos externos

| # | Tarea | Responsable | Cierra | Prueba de cierre |
|---|---|---|---|---|
| **R-13** | **Privacidad**: las cinco condiciones de §8.3. Recién al terminar se carga `ANTHROPIC_API_KEY` | Implementación (P-1, P-2, P-5) · **Pancho** (P-4, P-5) · **responsable de privacidad/legal** (P-3) | ALT-10, G7 | Las cinco filas de §8.3 con su evidencia |
| **R-14** | **Respaldo**: procedimiento escrito + una restauración de prueba real contra un proyecto descartable | **Pancho** | ALT-09, G6 | Párrafo en README con plan, frecuencia, retención y responsable, y bitácora de la restauración con fecha y duración |
| **R-15** | **Despliegue**: definir dónde corre y con qué garantías; si se queda local, `npm run build && npm start` bajo launchd | **Pancho** decide · Implementación ejecuta | MED-28 | El README responde dónde corre, con qué comando y quién lo reinicia |

### P2 — cuando lo de arriba esté cerrado

`npm test` + `typecheck` + CI (MED-08, G11) · lint en verde (MED-08, BAJ-17, G14) · vitest con tests de los
agregados `ai_*` y de RLS por rol (ALT-07) · capa de lecturas `lib/queries/` (MED-04, MED-07, BAJ-04, BAJ-13,
BAJ-15, BAJ-19) · registro de borrados en `audit_log` (MED-27) · exportación a CSV (BAJ-20) · responsive y
kanban por teclado (MED-12, BAJ-18) · README y `.env.local.example` (MED-03, MED-06, BAJ-07) · helpers
duplicados (BAJ-14) · delimitar texto libre en los prompts (MED-25).

---

## 11. Rollback de cada cambio

Regla general: **ningún paso se ejecuta si su rollback no está escrito y probado antes.** Para los cambios de
migración eso significa que el `_rollback.sql` se escribe junto con el `.sql`, no después.

| Paso | Tipo de cambio | Rollback | Probado antes de aplicar | Ventana |
|---|---|---|---|---|
| **C-0 / V-2** signup off | Configuración de plataforma | Volver a encender el toggle | No hace falta: es un switch, y la app **nunca llama a `signUp`** (verificado: no hay una sola llamada en el código; los usuarios se crean con `auth.admin.createUser`) | Inmediata |
| **C-1** `security-checks.ts` | Archivo nuevo | Borrar el archivo | — (no toca nada) | Inmediata |
| **C-2** runner con `ref` | Código | `git revert` del commit | Correrlo contra dev con un archivo inocuo | Inmediata |
| **C-3 / V-3** `0027` permisos | Migración (solo privilegios, **sin efecto sobre datos**) | `supabase/rollbacks/0027_function_grants_rollback.sql`: devuelve `EXECUTE` a `authenticated`/`service_role` sobre todo lo que la app puede necesitar, **sin reabrir `PUBLIC` ni `anon`** (ver nota abajo) | **Sí**: se aplica y se revierte en dev antes de tocar prod | < 5 min |

> **Corregido el 10/8/2026.** Esta fila decía que el rollback «re-concede `execute … to public`
> en las mismas 39 firmas. Restaura la vulnerabilidad, que es el punto». Eso ya no es cierto y no
> debe volver a serlo: un archivo llamado "rollback" no puede ser el camino corto para reabrir
> CRIT-01 sobre una base con datos reales. El rollback actual solo restaura el acceso de
> `authenticated`. Consecuencia honesta: **con `0027` intacta, correrlo no cambia nada** —su
> utilidad es reparar una revocación de más, no deshacer `0027`. Si una pantalla falla por un
> `grant` faltante, el arreglo es agregar ese `grant`, no correr el rollback
> (ver `docs/SMOKE_TEST_permisos.md`).
| **C-5** `chmod 600` | Permisos de archivo | `chmod 644 .env.local` | — | Inmediata |
| **R-1 / R-2** ledger | Migración + código | `drop table schema_migrations` + `git revert`. La tabla es solo registro: borrarla no altera ningún dato del CRM | Sembrar primero en dev y correr el runner dos veces | < 10 min |
| **R-3** allowlist | Migración + código | Dos niveles: (1) volver el guard a modo aviso (una línea); (2) `drop trigger` + `drop table auth_allowlist`. **El modo aviso es el rollback real**: se despliega así a propósito | Sí, el modo aviso **es** la prueba en producción | Inmediata (nivel 1) |
| **R-4** máquina de estados | Migración + código + **columnas nuevas** | Código: `git revert`. Schema: las columnas nuevas (`claimed_at`, `attempt_count`, `last_error`, `recommendation_id`) son **aditivas y nullable**, así que revertir el código las deja inertes — no hace falta borrarlas. El `check` de `status` sí hay que revertirlo, y solo se puede si ninguna fila quedó en los estados nuevos | Sí, con `ai_recommendations` en 0 filas hoy: es el mejor momento posible para este cambio | < 15 min |
| **R-5** forecast | Código | `git revert` | Comparar los tres números contra la RPC antes de mergear | Inmediata |
| **R-6** limpieza demo | **DML destructivo** | `insert into … select * from demo_purge_backup_YYYYMMDD`. **Sin la tabla de respaldo creada y verificada, el paso no se ejecuta** | Sí: crear el respaldo, contar filas, comparar con lo que va a borrar el `delete` | Mientras exista el respaldo (30 días) |
| **R-7** probabilidad por etapa | Migración (redefine `opportunities_transition`) | Re-aplicar la definición de `0011:2-32`, que queda guardada en el `_rollback.sql` | Sí, en dev, moviendo una oportunidad de prueba | < 10 min |
| **R-8 … R-12** | Código | `git revert` por tarea | Smoke test de la pantalla afectada | Inmediata |
| **R-13** minimización | Código + documentos | `git revert` del cambio de `context.ts`. **Los documentos no se revierten** | `eval-routing.ts` en 32 + 20 | Inmediata |
| **R-14 / R-15** | Configuración y documentación | No aplica | — | — |

**Los dos pasos con rollback caro:** `R-6` (borra datos; por eso exige respaldo previo) y `R-4` (cambia un
`check` constraint; por eso conviene hacerlo **ahora**, con `ai_recommendations` en 0 filas, y no después de
meses de uso).

---

## 12. Responsables de las acciones externas

Todo lo que no es código lo tiene que hacer una persona con acceso o autoridad. La lista completa, para que
nada quede sin dueño:

| Acción | Responsable | Por qué no puede hacerlo la implementación |
|---|---|---|
| Apagar el signup en dev y en prod (**C-0**, **V-2**) | **Pancho** | Consola de Supabase; no hay API en el repositorio para eso |
| Credenciales y consultas contra producción (**V-1**, **V-3**) | **Pancho** | No hay credenciales de producción en el entorno auditado |
| Aprobar la ventana para aplicar `0027` en cada base (**C-3**, **V-3**) | **Pancho** | Es un cambio en un sistema en uso |
| Smoke test de la aplicación (**C-4**) | **Pancho** | Es la única persona con la app corriendo y una sesión válida |
| `chmod 600 .env.local` (**C-5**) | **Pancho** | Máquina local |
| Estado de los backups y restauración de prueba (**V-4**, **R-14**) | **Pancho** | Consola de Supabase y decisión de plan/costo |
| Decir dónde corre la aplicación (**V-5**, **R-15**) | **Pancho** | Información que no está en el repositorio |
| Aprobar la siembra del ledger en producción (**R-2**) | **Pancho** | Requiere confirmar qué se aplicó realmente en prod |
| Cargar los mails en la allowlist (**R-3**) | **Pancho** (rol ADMIN) | Decisión de negocio sobre quién entra |
| Elegir opción A o B para `profile_update` (**R-4**, §8.1) | **Pancho** | Cambia una invariante de arquitectura declarada |
| Revisar la muestra de filas demo antes de borrar (**R-6**, §8.4) | **Pancho** | Requiere saber si esa actividad fue trabajo real |
| **Aprobación de privacidad (P-3)** | **Responsable de privacidad/legal de KeepSmiling** — hoy **no hay nadie designado**; designarlo es parte de la tarea | Determinación legal, fuera del alcance de una auditoría técnica |
| Revisión del contrato con el proveedor de IA (**P-4**) | **Pancho** con el responsable legal | Documento contractual externo |
| Decidir el plazo de retención (**P-5**) | **Pancho** | Decisión de negocio |
| Cargar `ANTHROPIC_API_KEY` (después de **R-13**) | **Pancho** | Es la llave del candado de §8.3 |

Todo lo demás —migraciones, código, scripts, pruebas— lo ejecuta quien tome la implementación.

---

## 13. Orden exacto de implementación

Secuencia lineal. Cada número espera al anterior salvo donde dice *en paralelo*.

| Orden | Paso | Fase | Bloquea a | Duración |
|---:|---|---|---|---|
| **1** | **C-0** apagar signup en dev | C | — | 2 min |
| **1'** | **V-1** verificar producción *(en paralelo con 1)* | V | 2', 5 | 1 h |
| **2** | **C-1** `security-checks.ts` + línea de base | C | 4 | 2 h |
| **2'** | **V-2** apagar signup en prod *(apenas termine 1')* | V | — | 2 min |
| **3** | **C-2** runner imprime `ref` y pide confirmación | C | 4, 5, 6 | 30 min |
| **4** | **C-3** aplicar `0027` en **dev** + `HOTFIX_LOG.md` | C | 5 | 20 min |
| **5** | **C-4** smoke test de la app en dev | C | 6 | 20 min |
| **6** | **V-3** aplicar `0027` en **prod** + `HOTFIX_LOG.md` | V | — | 20 min |
| **7** | **C-5** `chmod 600 .env.local` | C | — | 1 min |
| **8** | **V-4** estado de los backups · **V-5** dónde corre la app | V | 18 | 25 min |
| — | *— fin de la contención: CRIT-01 y CRIT-02 cerrados en las dos bases —* | | | |
| **9** | **Aprobación de los cuatro diseños de §8** | — | 10-13 | — |
| **10** | **R-1** + **R-2** ledger de migraciones, sembrado por base | R1 | 11-17 | 1 día |
| **11** | **R-3** allowlist (modo aviso → excepción) | R2 | — | 4 h |
| **12** | **R-5** forecast desde `ai_forecast()` | R2 | — | 2 h |
| **13** | **R-4** máquina de estados + ALT-02 + BAJ-02 | R2 | — | 1-2 días |
| **14** | **R-7** probabilidad por etapa · **R-10** `completeTask` | R2 | — | 1 día |
| **15** | **R-8** errores visibles · **R-12** `error.tsx` | R2 | 16 | 1 día |
| **16** | **R-9** confirmación de purga · **R-11** límite de tasa | R2 | 17 | 1 día |
| **17** | **R-14** respaldo + restauración probada | R3 | 18 | según plan |
| **18** | **R-6** limpieza del demo *(requiere 17)* | R2 | — | 2 h |
| **19** | **R-13** privacidad, las cinco condiciones | R3 | 20 | según legal |
| **20** | **Cargar `ANTHROPIC_API_KEY`** | — | — | 1 min |
| **21** | **R-15** despliegue definido | R3 | — | según decisión |
| **22** | P2 completo | P2 | — | — |

**Tres reglas que no se saltean:**

1. **Nada de migraciones antes del paso 3.** El runner tiene que decir a qué base apunta.
2. **Nada en producción antes del paso 5.** El smoke test de desarrollo es lo que autoriza tocar prod.
3. **La clave del modelo se carga en el paso 20 y no antes.** Es el único paso irreversible en el sentido que
   importa: después de cargarla, la minimización deja de ser gratis.

---

## 14. Qué NO hacer

- **No** relajar los guards de 0024 con una negación (`<> 'import'`): la allowlist tiene que ser positiva, o
  cualquier origen futuro entra por omisión.
- **No** revocar EXECUTE "de todo a todos": `case_self_similarity`, `is_manager`, `can_write` y `current_rol`
  las necesita `authenticated` — las evalúan las policies de RLS, y la cola de `/calidad` corre como
  `SECURITY INVOKER`. La lista del Anexo A es explícita por eso.
- **No** hacer la RPC de aceptación `SECURITY DEFINER`: apagaría `auth.uid()`, los guards de procedencia y el
  `doctors_journey_sync`. Tiene que ser `SECURITY INVOKER` (§8.1).
- **No** devolver una recomendación fallida a `propuesta` de forma automática: además de poder duplicar el
  efecto, choca con el índice único parcial `ai_recommendations_dedupe_idx`.
- **No** cargar `ANTHROPIC_API_KEY` antes del paso 20.
- **No** activar el ledger sin sembrarlo con lo ya aplicado **en cada base por separado**, después de ver el
  schema real de cada una (salida de V-1).
- **No** condicionar el arreglo del forecast a la limpieza del demo: `ai_forecast()` ya filtra `is_demo`.
- **No** tocar el modelo de autorización (`using (true)`) en el mismo cambio que cierra CRIT-02. Son dos cosas
  distintas: apagar el signup es de esfuerzo mínimo y riesgo cero; cambiar el modelo de lectura obliga a
  revisar las ~91 consultas de la aplicación y toda la capa AI. Primero se cierra la puerta; después se
  discute quién ve qué adentro.
- **No** afirmar una base legal desde el código (§8.3).
- **No** introducir multi-tenancy, microservicios ni un ORM: agregarían costo sin cerrar ninguno de los 59
  hallazgos.

---

## 15. Checklist Go/No-Go

**Veredicto actual: NO-GO.** Cada fila pasa a verde solo con la prueba ejecutada y su salida guardada.
La columna *Paso* indica en qué número de §13 se cierra.

### Bloqueantes de seguridad y datos

| # | Criterio | Hoy | Paso | Prueba exacta que lo cierra |
|---|---|:---:|:---:|---|
| **G1** | Ninguna función `SECURITY DEFINER` de `public` es ejecutable por `anon` | 🔴 30 de 39 lo son | 4, 6 | `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon',p.oid,'EXECUTE');` → **0**, en dev **y** en prod |
| **G2** | Ninguna RPC devuelve datos sin sesión, y con sesión la app sigue andando | 🔴 12 devuelven 200 | 4, 5, 6 | Las 12 RPC con la clave anónima → **401**; las mismas con JWT válido → 200; `GET /rest/v1/doctors` sin sesión → 401 |
| **G3** | El alta pública está apagada en las dos bases | 🔴 `disable_signup: false` en dev; prod sin verificar | 1, 2' | `GET /auth/v1/settings` en ambos proyectos → `"disable_signup": true` |
| **G4** | Un alta no autorizada no puede obtener sesión útil | 🔴 sin control en código | 11 | Chequeo 4: dos `insert into auth.users` en transacciones revertidas — mail permitido pasa, mail ajeno levanta excepción |
| **G5** | El schema de producción coincide con el de desarrollo | 🔴 sin verificar | 1' | Volcado de `information_schema.tables`, `pg_policies` y `pg_proc` (con privilegios) de las dos bases + `diff`, con cada diferencia justificada por escrito |
| **G6** | Hay un respaldo **verificado** con menos de 24 h **y** una restauración probada | 🔴 ninguna de las dos cosas está verificada | 8, 17 | Captura de la configuración de backups + bitácora de una restauración real con fecha y duración |
| **G7** | El envío a un tercero está minimizado, documentado y aprobado | 🔴 sin minimizar; clave vacía | 19 | Las cinco condiciones de §8.3, cada una con su evidencia, incluida la aprobación firmada de P-3 |

### Bloqueantes de correctitud

| # | Criterio | Hoy | Paso | Prueba exacta que lo cierra |
|---|---|:---:|:---:|---|
| **G8** | Aceptar una recomendación funciona, es idempotente y no escribe fuera del doctor | 🔴 falla siempre | 13 | Chequeo 5 · aceptar dos veces la misma recomendación produce **un solo** efecto · un `case_id` de otro doctor la deja en `fallida_definitiva` · una fila trabada en `procesando` se reconcilia sola |
| **G9** | El Forecast que ve el equipo es el número real | 🔴 19 vs 6 | 12 | Las tres pantallas y `select ai_forecast(null)` dan el mismo número |
| **G10** | Se puede decir con certeza qué migración tiene cada base | 🔴 sin ledger | 10 | `select * from schema_migrations` en dev y prod; correr el runner dos veces seguidas no hace nada la segunda |

### Recomendado antes de sumar usuarios (no bloqueante hoy)

| # | Criterio | Paso | Prueba |
|---|---|:---:|---|
| G11 | `npm test` y `npm run typecheck` existen y un CI los corre | 22 | Un push con el harness roto no pasa el CI |
| G12 | Ninguna acción de la interfaz falla en silencio | 15 | Las 10 acciones `void` devuelven resultado y la UI lo muestra |
| G13 | Las 3 rutas AI tienen límite de tasa y tope de gasto | 16 | Superar el límite devuelve 429 |
| G14 | El lint está en verde | 22 | `npm run lint` sale con código 0 |

**Cuándo pasa a GO.** Con G1–G10 en verde el sistema queda apto para la operación interna de tres personas.
G11–G14 son la condición para sumar un cuarto usuario o exponerlo a alguien menos confiable.

---

## Anexo A — Matriz completa de funciones y permisos

Consulta directa a `pg_proc` de la base de desarrollo, 10/8/2026. Excluye las funciones de la extensión
`pg_trgm`: quedan 46 funciones propias del proyecto, de las cuales **39 son `SECURITY DEFINER`**.

**Por qué esta matriz existe.** En Postgres, `CREATE FUNCTION` concede `EXECUTE` a `PUBLIC` por defecto, y en
Supabase el rol `anon` hereda de `PUBLIC`. Por eso **revocar de `anon` no sirve de nada mientras `PUBLIC`
conserve el privilegio** — el repositorio contiene un ejemplo exacto de ese error en `0006:309-311`, tres
`revoke ... from anon` que hoy siguen sin efecto. La columna **RPC** indica si PostgREST la expone como
endpoint: las funciones de trigger no lo son (comprobado: devuelven `404 PGRST202`).

| Resumen | Cantidad |
|---|---:|
| `SECURITY DEFINER` en `public` | **39** |
| … con `EXECUTE` para `PUBLIC` | **30** |
| … de esas, invocables como RPC | **15** |
| … de esas, que devuelven datos del negocio por HTTP sin sesión | **12** |

**A. `SECURITY DEFINER`, invocables como RPC (15 con PUBLIC + 9 ya cerradas)**



| Función (firma) | RPC | PUBLIC | `anon` | `authenticated` | `service_role` | Permiso que debe conservar |
|---|:---:|:---:|:---:|:---:|:---:|---|
| `ai_accredited_not_activated(p_limit integer)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_at_risk_doctors(p_limit integer)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_cases_by_period(p_from date, p_to date)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_data_quality()` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_doctor_segments()` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_dormant_doctors(p_limit integer, p_include_lost boolean)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_forecast(p_period date)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_pipeline_summary(p_period date, p_limit integer)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_prospects(p_stage text, p_limit integer, p_city text, p_source text, p_min_interest integer)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_rep_performance(p_days integer, p_period date)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_second_case_metrics()` | sí | no | no | sí | sí | `authenticated`, `service_role` (ya correcto) |
| `ai_service_issues(p_limit integer, p_doctor_id uuid)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `can_write()` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` — ídem |
| `case_self_similarity(p_case_id uuid)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` — la llama `case_subject_review_queue`, que es SECURITY INVOKER |
| `current_rol()` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` — la evalúan las policies de RLS con el rol invocante |
| `default_sales_owner()` | sí | no | no | sí | sí | `authenticated`, `service_role` (ya correcto) |
| `evaluate_automations()` | sí | no | no | sí | sí | `authenticated`, `service_role` (ya correcto) |
| `evento_roi()` | sí | no | no | sí | sí | `authenticated`, `service_role` (ya correcto) |
| `is_manager()` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` — ídem |
| `log_audit(p_entity text, p_id uuid, p_field text, p_old text, p_new text)` | sí | no | no | no | no | ninguno (ya correcto) |
| `purge_demo()` | sí | no | no | sí | sí | `authenticated`, `service_role` (ya correcto) |
| `recompute_all()` | sí | no | no | sí | sí | `authenticated`, `service_role` (ya correcto) |
| `recompute_doctor(p_id uuid)` | sí | no | no | no | sí | `service_role` (ya correcto) |
| `refresh_cohort_intervals()` | sí | no | no | no | sí | `service_role` (ya correcto) |

**B. `SECURITY DEFINER` de trigger — no alcanzables por HTTP, pero con EXECUTE público**



| Función (firma) | RPC | PUBLIC | `anon` | `authenticated` | `service_role` | Permiso que debe conservar |
|---|:---:|:---:|:---:|:---:|:---:|---|
| `activities_default_engagement()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `activities_engagement_guard()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `ai_recommendations_guard()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `alerts_guard()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `cases_subject_guard()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `doctors_audit()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `doctors_guard()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `doctors_journey_sync()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `handle_new_user()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `opportunities_audit()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `opportunities_transition()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `profiles_guard()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `recompute_doctor_trigger()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `tasks_audit()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `tasks_default_owner()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |

**C. `SECURITY INVOKER` (no saltan RLS; se listan para que el inventario sea completo)**



| Función (firma) | RPC | PUBLIC | `anon` | `authenticated` | `service_role` | Permiso que debe conservar |
|---|:---:|:---:|:---:|:---:|:---:|---|
| `ai_mx_date(p timestamp with time zone)` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_mx_month_start()` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `ai_mx_today()` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `case_subject_review_queue(p_limit integer)` | sí | no | no | sí | sí | `authenticated`, `service_role` |
| `is_system()` | sí | **sí** | **sí** | sí | sí | `authenticated`, `service_role` |
| `set_updated_at()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |
| `tasks_transition()` | no | **sí** | **sí** | sí | sí | ninguno — los triggers no necesitan EXECUTE |

### Privilegios por defecto

`pg_default_acl` de la base dev tiene hoy `postgres / public / functions → {postgres=X/postgres}`, es decir con
`PUBLIC` ya revocado para funciones **nuevas**. Pero esa entrada es posterior a la creación de las funciones de
arriba —las de 0022–0023 tienen `=X/postgres` en su ACL, o directamente `proacl` NULL— y por eso no las
alcanzó. En producción su estado se desconoce. La migración `0027` debe incluir el `alter default privileges`
explícitamente, para que quede versionado en el repositorio y sea reproducible en las dos bases.

### Forma de la migración `0027_function_grants.sql`

```sql
-- 0027_function_grants.sql  (BORRADOR — no aplicar hasta aprobación)

-- 1. Cerrar todo lo que hoy está abierto. La firma con tipos tiene que ser EXACTA:
--    una firma mal escrita no revoca nada y da falsa tranquilidad.
revoke all on function ai_data_quality()                     from public;
revoke all on function ai_at_risk_doctors(int)               from public;
--  … las 39, una por una, según la matriz de arriba …
revoke all on function case_self_similarity(uuid)            from public;
revoke all on function is_manager()                          from public;
revoke all on function can_write()                           from public;
revoke all on function current_rol()                         from public;
revoke all on function doctors_guard()                       from public;   -- trigger: sin grant posterior
--  …

-- 2. Volver a conceder por lista explícita (columna "Permiso que debe conservar").
grant execute on function ai_data_quality()        to authenticated, service_role;
grant execute on function case_self_similarity(uuid) to authenticated, service_role;  -- la usa /calidad
grant execute on function is_manager()             to authenticated, service_role;    -- la usan las policies
--  …

-- 3. Que las próximas no vuelvan a nacer públicas.
alter default privileges for role postgres in schema public
  revoke execute on functions from public;

-- 4. Verificar acá mismo: si queda alguna abierta, la migración falla.
do $$
declare n int;
begin
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.prosecdef
    and has_function_privilege('anon', p.oid, 'EXECUTE');
  if n > 0 then
    raise exception 'Quedan % funciones SECURITY DEFINER ejecutables por anon', n;
  end if;
end $$;
```

El paso 4 es lo que convierte la migración en su propia prueba: no hace falta acordarse de verificar después,
porque no se aplica si quedó algo abierto.


---


---

*Plan v2 preparado el 10 de agosto de 2026 sobre `AUDITORIA_CRM.md` (revisión 2, diagnóstico aprobado).
**No se aplicó ninguna corrección**: el código y la base están como estaban. Las verificaciones que
sustentan este plan fueron de solo lectura o transacciones revertidas. La única edición al informe fue la
del punto 8 —las frases residuales sobre respaldo—, que ahora dicen: no existe un respaldo verificado ni una
restauración probada.*

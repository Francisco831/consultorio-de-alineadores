# Smoke test de permisos — paso C-4

Cierra el paso **C-4** de `PLAN_REMEDIACION_CRM.md`. Es la única parte de la Fase C que
**no se puede automatizar desde acá**: requiere una sesión iniciada de verdad, y los scripts
tienen prohibido crear usuarios o manejar contraseñas.

**Lo corre Pancho.** Tarda ~15 minutos.

## Qué está probando en realidad

La migración `0027_function_grants.sql` le sacó a `PUBLIC` el permiso de ejecutar las 39
funciones `SECURITY DEFINER` y se lo devolvió por lista explícita a `authenticated` y
`service_role`. El riesgo del cambio no es que quede algo abierto —eso lo verifica
`security-checks.ts` sin intervención— sino **que se haya cerrado de más**: si a una función
le faltó el `grant`, la pantalla que la usa falla con `permission denied for function ...`.

El chequeo 7 de `security-checks.ts` compara los permisos contra la lista de funciones que la
aplicación usa, así que la mayor parte del riesgo ya está cubierta automáticamente. Este smoke
test cubre lo que esa lista no puede ver: rutas que llaman funciones por caminos que no se
leen del código (triggers al escribir, `pg_cron`, RPC armadas dinámicamente).

## Antes de empezar

```bash
cd crm-mx && npx tsx scripts/security-checks.ts
```

Los chequeos **1, 2 y 7** tienen que dar `OK`. Si el 7 da `FALLA`, no sigas: la salida ya dice
qué función perdió el permiso, y el arreglo es agregarle el `grant` a `0027`, no correr el
rollback.

Después, con la app levantada (`npm run dev`) e **iniciando sesión con un usuario manager**:

## Las cinco pantallas

Para cada una: **cargar la página, mirar la consola del navegador y la del servidor.**
Un `permission denied for function <nombre>` es el fallo que buscamos; anotá el nombre exacto.

| # | Ruta | Qué tiene que verse | Función que ejercita |
|---|---|---|---|
| 1 | `/dashboard` | Los KPI con números, no en cero ni en blanco. El forecast del mes muestra un valor | `ai_forecast`, `ai_pipeline_summary`, `ai_data_quality` |
| 2 | `/doctores/[id]` | Abrir **un doctor con casos**. Timeline con actividades, score de salud con su etiqueta de confianza | policies RLS → `current_rol`, `can_write`, `is_manager` |
| 3 | `/calidad` | **La más importante.** La cola de casos aparece **ordenada y no vacía** | `case_subject_review_queue` → `case_self_similarity` |
| 4 | `/pipeline` | Las columnas con oportunidades. **Arrastrar una oportunidad de columna** y que el cambio persista al recargar | escritura + triggers `opportunities_transition`, `opportunities_audit` |
| 5 | `/ajustes` | Las 8 reglas de automatización listadas, con sus umbrales | lectura de `automation_rules` |

## Las dos escrituras

Las pantallas de arriba son casi todas de lectura. Los triggers solo se ejercitan escribiendo:

| # | Acción | Qué confirma |
|---|---|---|
| 6 | En `/doctores/[id]`, **registrar una actividad** | `activities_default_engagement`, `doctors_journey_sync`, `doctors_audit` |
| 7 | En `/ajustes`, **apagar y volver a encender** una regla de automatización | escritura de manager + `audit_log` |

> El paso 4 y el 6 escriben datos reales. Son operaciones normales de la app (mover una
> oportunidad, registrar una actividad), reversibles desde la propia interfaz. **No** corras
> "Borrar datos demo" ni "Recalcular scores" como parte de este smoke test.

## Resultado

- [ ] Las 5 pantallas cargan sin error
- [ ] `/calidad` muestra la cola con filas
- [ ] Mover una oportunidad persiste
- [ ] Registrar una actividad persiste
- [ ] Ningún `permission denied` en consola de navegador ni de servidor

**Si las cinco casillas están tildadas:** anotá la fecha en `supabase/HOTFIX_LOG.md`, en la
sección "Lo que falta para dar C-3/C-4 por cerrados". C-4 queda cerrado.

**Si aparece un `permission denied for function X`:**

1. Anotá `X` con su firma completa.
2. **No corras el rollback todavía.** El rollback es para cuando la app está inutilizable, no
   para una pantalla rota. Agregar el `grant` que falta es más rápido y no reabre nada.
3. Agregá `X` a la lista de `grant` de `0027_function_grants.sql` **y** a
   `NECESITA_AUTHENTICATED` en `scripts/security-checks.ts`, para que la próxima vez lo
   detecte el chequeo 7 sin necesidad de smoke test.
4. Re-aplicar `0027` (es idempotente).

**Si la app queda inutilizable** (no carga ninguna pantalla): correr
`supabase/rollbacks/0027_function_grants_rollback.sql`, que le devuelve `EXECUTE` a
`authenticated` sobre todo lo que la app puede necesitar **sin reabrir `anon` ni `PUBLIC`**.
Después volver al punto 3.

# CRM Comercial — KeepSmiling México

Commercial Operating System para el equipo MX. KPI central: **casos pagados/mes**.
Principio: el CRM te dice qué hacer (Next Best Action), no te pide administrarlo.

## Stack

Next.js 16 · TypeScript · Tailwind 4 · shadcn/ui (Base UI) · Supabase (Postgres + Auth + RLS) · Recharts · dnd-kit.

## Setup (una vez)

1. **Crear proyectos en supabase.com** (gratis): uno `crm-mx-dev` y uno `crm-mx-prod`.
   En Settings → API copiar URL, anon key y service_role key.
2. **Configurar env**: `cp .env.local.example .env.local` y completar las 3 claves (empezar con dev).
   Además hace falta `SUPABASE_DB_PASSWORD` —la contraseña de Postgres, en Settings → Database
   → *Database password*— que es la que usan `db-migrate.ts` y `security-checks.ts`.
   `chmod 600 .env.local`: el archivo tiene las claves de una base con datos reales.
3. **Aplicar migraciones** con el runner, siempre en tres pasos. Detalle en
   [`docs/OPERACION.md`](docs/OPERACION.md).
   ```
   npx tsx scripts/db-migrate.ts --print-target   # a qué base apuntaría (no conecta)
   npx tsx scripts/db-migrate.ts --dry-run        # corre y revierte: verifica sin escribir
   npx tsx scripts/db-migrate.ts --apply          # recién esto escribe
   ```
   Sin `--apply` el runner **nunca** escribe. Registra lo aplicado en `ops.schema_migrations`,
   así que re-correrlo es seguro: saltea lo que ya está.
   - Si `pg_cron` no está habilitado: Dashboard → Database → Extensions → habilitar `pg_cron`,
     y re-correr el bloque final de `0006_automations.sql`.
4. **Crear usuarios**: `npx tsx scripts/create-users.ts` (imprime contraseñas iniciales una sola vez).
5. **Importar datos reales**:
   ```
   npx tsx scripts/import-noloco.ts      # 175 doctores + 1.024 casos (con gate de validación)
   npx tsx scripts/seed-demo.ts          # potenciales reales + demo sintético marcado
   npx tsx scripts/import-enrichment.ts  # teléfonos/ciudades/pagos minados de Drive (requiere data/*.json)
   ```
6. **Correr**: `npm run dev` → http://localhost:3000

## Datos: qué es fuente de verdad

| Dato | Fuente | Regla |
|---|---|---|
| Casos (producción) | Noloco → `cases` | Espejo read-only. **Caso nuevo = etapa `I_1`** (sumar etapas infla ~70%). |
| Pagos | Planilla Administración MX → `payments` | El KPI "pagado" de verdad. |
| Doctores: owner, lifecycle, teléfonos, notas | El CRM | Nunca los pisa un import. |
| Scores (health/potential/priority) | Calculados (pg_cron nightly + triggers) | Nadie los edita a mano; `potential_override` es del manager. |

## Lo que hay que saber del motor

- **Health** compara a cada doctor contra SU propio ritmo (mediana de sus últimos 8 gaps
  entre casos). Con <3 casos usa la mediana de su categoría (label "cohort"); sin casos,
  "insuficiente" — la UI siempre muestra la confianza.
- **Priority** es explicable: cada señal guarda su razón en español con números reales
  (`priority_reasons`), y la pantalla Hoy agrupa por bucket (Crítico/Alto impacto/…).
- **Automatizaciones** (8 reglas, tabla `automation_rules`): umbrales editables en Ajustes.
  Corren cada hora; idempotentes por dedupe de alertas abiertas.
- **Datos demo** siempre `is_demo=true` → botón "Borrar datos demo" en Ajustes.

## Estructura

```
app/(app)/          hoy · dashboard · doctores(/[id]) · pipeline · casos · tareas · reportes · equipo · ajustes
lib/actions/        server actions (todas las escrituras)
lib/supabase/       clients server/browser
lib/ai/             capa multi-agente (ver docs/AI_ARCHITECTURE.md)
supabase/migrations 0001 enums · 0002 tablas · 0003 triggers+audit · 0004 RLS · 0005 scores ·
                    0006 automatizaciones · … · 0027 permisos de funciones · 0028 ledger
supabase/rollbacks/ el rollback de cada migración que tiene uno. NO son migraciones:
                    vivían mezclados y una corrida sin argumentos los aplicaba.
scripts/            db-migrate (runner) · security-checks (8 chequeos) · create-users ·
                    import-noloco · seed-demo · parse_enrichment.py · import-enrichment
docs/               OPERACION.md (migrar/verificar/recuperar) · SMOKE_TEST_permisos.md · AI_ARCHITECTURE.md
```

## Verificar

```
npm run typecheck && npm test && npm run build   # no tocan ninguna base; corren en CI
npm run test:seguridad                            # 8 chequeos contra la base (a mano)
```

## Decisiones de diseño (resumen)

- 28 tablas del spec → ~20: clínicas como columnas del doctor, un solo `audit_log`
  (5 tablas de historial), custom fields como JSONB, workflows como reglas parametrizadas.
- RLS real sin teatro: todos leen todo (transparencia), escribe todo no-VIEWER,
  columnas sensibles y tablas de sistema protegidas por triggers/policies.
- WhatsApp-ready: `wa_conversations`/`wa_messages` existen sin UI (Periskope está plan-gated).

# CRM Comercial — KeepSmiling México

Commercial Operating System para el equipo MX. KPI central: **casos pagados/mes**.
Principio: el CRM te dice qué hacer (Next Best Action), no te pide administrarlo.

## Stack

Next.js 16 · TypeScript · Tailwind 4 · shadcn/ui (Base UI) · Supabase (Postgres + Auth + RLS) · Recharts · dnd-kit.

## Setup (una vez)

1. **Crear proyectos en supabase.com** (gratis): uno `crm-mx-dev` y uno `crm-mx-prod`.
   En Settings → API copiar URL, anon key y service_role key.
2. **Configurar env**: `cp .env.local.example .env.local` y completar las 3 claves (empezar con dev).
3. **Aplicar migraciones** (en orden 0001→0006): en el SQL Editor del dashboard de Supabase,
   pegar y correr cada archivo de `supabase/migrations/`. (O `supabase db push` si está el CLI linkeado.)
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
supabase/migrations 0001 enums · 0002 tablas · 0003 triggers+audit · 0004 RLS · 0005 scores · 0006 automatizaciones
scripts/            create-users · import-noloco · seed-demo · parse_enrichment.py · import-enrichment
```

## Decisiones de diseño (resumen)

- 28 tablas del spec → ~20: clínicas como columnas del doctor, un solo `audit_log`
  (5 tablas de historial), custom fields como JSONB, workflows como reglas parametrizadas.
- RLS real sin teatro: todos leen todo (transparencia), escribe todo no-VIEWER,
  columnas sensibles y tablas de sistema protegidas por triggers/policies.
- WhatsApp-ready: `wa_conversations`/`wa_messages` existen sin UI (Periskope está plan-gated).

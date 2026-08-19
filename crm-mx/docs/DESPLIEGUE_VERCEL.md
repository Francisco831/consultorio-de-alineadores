# Desplegar el CRM en Vercel

> **HECHO — 18/8/2026.** El CRM corre en **crm-mx-puce.vercel.app** (proyecto `crm-mx`,
> equipo "CRM Mexico", repo Francisco831/consultorio-de-alineadores, producción sigue la
> rama `crm-mx-ai`, Root Directory `crm-mx`). El mismo día se contrató **Vercel Pro**
> (USD 20/mes): con el techo de 300s la capa AI quedó viva en la URL — primera corrida
> real verificada (3 agentes, 233s, USD 0,71, 5 recomendaciones en propuesta). Las 4
> variables cargadas: las 2 públicas de Supabase + `SUPABASE_SERVICE_ROLE_KEY` +
> `ANTHROPIC_API_KEY`. Los 3 usuarios activos.
>
> Lo que sigue de este documento queda como registro de las decisiones y del porqué.


Hoy el CRM corre con `npm run dev` en la máquina de Pancho. Desplegarlo es lo que lo
convierte en una herramienta de equipo: Juan y Rocío entran desde México sin depender de
que esa Mac esté prendida.

Este documento es la lista de lo que hay que hacer y, sobre todo, de lo que hay que decidir
antes.

---

## Antes de empezar: el bloqueante

> **Cerrado el 18/8/2026:** `0031` está aplicada en producción y el chequeo 4 dio OK con
> `--probar-altas` — un alta con mail ajeno se rechaza aunque el toggle se encienda. Lo
> que sigue de esta sección queda como registro de por qué era condición.

**`0031_auth_allowlist.sql` tiene que estar aplicada en producción.** No es burocracia:

- El chequeo 8 de `security-checks` está en **FALLA**: la policy de lectura es `using (true)`,
  así que **cualquier cuenta autenticada lee 18 de 26 tablas — 59.028 filas**, incluidos los
  7.034 doctores, los 1.046 pagos y los nombres de paciente.
- Lo único que hoy impide que alguien se cree una cuenta es el toggle `disable_signup` del
  panel de Supabase. Una casilla, sin respaldo en código, sin rastro en el repositorio si
  alguien la cambia.

Mientras el CRM vive en una Mac, para llegar a esos datos hay que tener esa Mac. Con una URL
pública, **ese toggle pasa a ser lo único entre internet y la base**. `0031` lo convierte en
código: un alta que no está invitada no llega a existir, aunque el toggle se encienda.

Verificar antes de seguir:

```
npm run test:seguridad
```

El chequeo 4 tiene que decir **OK** (o al menos que la tabla existe). Si dice
"la tabla auth_allowlist todavía no existe", parar acá.

---

## Decisión 1 — el plan de Vercel

Las tres rutas de IA declaran `maxDuration = 300` (`app/api/ai/{analyze,ask,brief}/route.ts`).
Un análisis de doctor con `effort: high` hace hasta 11 llamadas al modelo y tarda del orden de
minutos.

| Plan | Techo de ejecución | Qué pasa con la capa AI |
|---|---|---|
| Hobby | 60 s | El análisis se corta a la mitad. Peor: por cómo está escrito el runner, esa corrida **no queda registrada** en `agent_runs`, así que se pagó y no hay rastro |
| Pro | hasta 300 s | Entra sin cambios |

**En Hobby hay que bajar el costo por corrida antes de desplegar**, no después: poner
`AI_EFFORT=low` o `medium` (ver `lib/ai/db.ts`) y bajar `maxDuration` a 60 en las tres rutas.
El resto del CRM —que es casi todo— anda igual en cualquier plan: son páginas server-rendered
y consultas a Supabase.

## Decisión 2 — qué rama despliega

La rama de trabajo es `crm-mx-ai`, no `main`. Vercel despliega producción desde la rama por
defecto del proyecto. O se cambia la rama por defecto en Vercel, o se mergea a `main` primero.
Mientras tanto, cada push a `crm-mx-ai` genera una **preview** con su propia URL, que es
exactamente lo que conviene para la primera prueba.

## Decisión 3 — rotar las credenciales

Hoy **la misma contraseña de Postgres sirve para desarrollo y producción**, y las claves de
producción vivieron en el `.env.local` de una máquina de trabajo (`docs/V1_PRODUCCION.md`).
Antes de que esas claves además existan en un tercero, conviene rotar en Supabase:
`SUPABASE_SERVICE_ROLE_KEY` y la contraseña de la base de producción.

---

## Configuración del proyecto en Vercel

**Root Directory: `crm-mx`.** Es lo único que no se autodetecta: el repositorio tiene muchas
otras cosas al lado y en la raíz no hay `package.json`. Se configura en Settings → General →
Root Directory.

El resto es cero configuración: Vercel detecta Next.js, corre `npm ci` y `npm run build`.
**No hace falta `vercel.json`** — `maxDuration` ya está declarado en cada route file, que es
la forma vigente de hacerlo, y no hay nada más que ajustar. Un `vercel.json` vacío o con
valores repetidos es una fuente de divergencia futura, no una ayuda.

### Variables de entorno

Se cargan en Settings → Environment Variables. Son las mismas de `.env.local`, apuntando a
**producción**:

| Variable | ¿Va al navegador? | Nota |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Sí | Pública por diseño |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Sí | Pública por diseño; quien protege es RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | **NO** | Da acceso total saltando RLS. **Nunca** con prefijo `NEXT_PUBLIC_` |
| `ANTHROPIC_API_KEY` | **NO** | Sin ella, `/api/ai/*` responde 503 y el CRM anda igual |
| `AI_MODEL` | No | Opcional. Default `claude-opus-5` |
| `AI_EFFORT` | No | Opcional. Default `high`. Ver Decisión 1 |
| `AI_DAILY_BUDGET_USD` | No | Opcional. Default 25. Corta-corriente de gasto |

**No hace falta** `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF` ni `SUPABASE_DB_HOST`: esas
tres solo las usan los scripts de terminal (`db-migrate`, `security-checks`), que no corren en
Vercel. Cargarlas sería exponer la contraseña de la base sin ninguna necesidad.

Verificado sobre el build actual: la clave de servicio **no aparece** en `.next/static/`, o sea
que no viaja al navegador. Conviene repetir ese chequeo si alguna vez se mueve código entre
`lib/ai/db.ts` y un componente de cliente.

---

## Después del primer deploy: qué probar

En la URL de **preview**, antes de tocar producción:

1. **Login** con una cuenta real. Si el login no anda, casi siempre son las variables de
   Supabase mal cargadas o apuntando a la base equivocada.
2. **`/dashboard`** — que "Pagados / objetivo" y "Casos nuevos" muestren números que cierren.
   Son dos métricas distintas a propósito: el objetivo se mide contra el ledger de pagos.
3. **`/hoy`, `/pipeline`, `/doctores/[id]`, `/calidad`** — que carguen y que los tableros
   permitan mover una tarjeta.
4. **Un análisis de IA** en la ficha de un doctor. Acá es donde se ve si el plan alcanza: si
   corta por tiempo, volver a la Decisión 1.
5. **Cerrar sesión y entrar a una URL directa** (por ejemplo `/doctores`) — tiene que mandarte
   a `/login`. Ese es `proxy.ts` haciendo su trabajo.

---

## Lo que este despliegue NO resuelve

**El chequeo 8 sigue en FALLA.** La allowlist reduce la probabilidad de que exista una cuenta
que no debería; no reduce lo que una cuenta legítima puede leer. Con la policy `using (true)`,
cualquiera de los tres usuarios —o alguien que se apodere de una de esas sesiones— lee la base
entera.

Con tres personas que por su trabajo ya ven esos datos, es defensa en profundidad y no una
puerta abierta. Pero es el hallazgo abierto más grande del sistema y crece con cada usuario
nuevo. Cerrarlo es acotar la lectura por rol y pertenencia, y es un trabajo aparte: hay que
revisar qué consulta cada pantalla, porque hoy todas asumen que pueden leer todo.

**Tampoco hay límite de tasa** en `/api/ai/*` más allá del tope de gasto diario. En una URL
pública con sesión válida, alguien puede disparar análisis en serie hasta agotar el
presupuesto del día. El tope evita la factura sorpresa; no evita que se consuma temprano.

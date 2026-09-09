# WhatsApp directo (sin Periskope)

Cómo entra al CRM lo que pasa en la línea **+54 9 11 2374-0762** (la que atiende
a los doctores; en el CRM está asignada a Rocío en `profiles.periskope_org_phone`).

Decisión de Pancho, 8/9/2026: la fuente es **WhatsApp Web directo** en su Chrome
(perfil "Keep"), no Periskope, y la lectura es **semi-manual**: Claude la hace
cuando él la pide, con el comando `/revision-whatsapp` del repo
(`.claude/skills/revision-whatsapp/SKILL.md`). No hay cron ni bot corriendo solo.

## El circuito

```
WhatsApp Web (Chrome, perfil Keep)
   │  Claude lee los chats con movimiento desde la última corrida
   ▼
POST /api/sync/whatsapp  (Bearer CRON_SECRET)        app/api/sync/whatsapp/route.ts
   │
   ├─ wa_conversations / wa_messages   el chat y cada mensaje (idempotente por id de WhatsApp)
   ├─ unanswered                        lo decide el trigger de 0041 con el último mensaje
   ├─ activities (type whatsapp)        una por doctor y DÍA (hora MX), resumen del modelo
   ├─ ai_recommendations               los pedidos del doctor → tareas PROPUESTAS (HITL)
   └─ Slack #alertas-crm               el aviso del día (avisarCRM, lib/cron.ts)
```

- **Cruce con doctores** (`lib/whatsapp/directo.ts`, `matchearDoctor`): teléfono
  del contacto → teléfonos de los participantes del grupo → nombre del chat
  ("Xilonen Diaz Mendoza & KeepSmiling" contra "Diaz Mendoza Xilonen", sin
  acentos). Si dos fichas empatan, **no se adivina**: queda sin vínculo y el
  aviso lo lista como "2+ fichas posibles".
- **"Nuestro"** incluye a las otras líneas de KS: si en el grupo contestó Juan,
  el chat no queda pendiente. Esas líneas se leen de `WA_LINEAS_KS` (teléfonos
  separados por coma, en Vercel y en `.env.local`); no están en el código porque
  el repo es público. Sin la variable solo cuentan los `from_me` y los nombres
  con que WhatsApp muestra a las líneas agendadas.
- **Resumen** (`lib/whatsapp/resumen.ts`): una llamada al modelo por (chat, día),
  salida validada con zod. Al modelo no le llegan teléfonos ni nombre del chat;
  los pacientes se nombran como "una paciente". Modelo: `WA_AI_MODEL` o, si no
  está, el `AI_MODEL` de la capa AI. Costo estimado en cada corrida (`costo_usd`).
- **Tareas propuestas**: hasta 3 abiertas por doctor (`whatsapp_pedido_1..3`,
  agente `doctor_success`). Se aprueban o descartan en la ficha del doctor, con
  el mismo botón que el resto de las recomendaciones. Nunca se crea una tarea sola.
- **Watermark**: `GET /api/sync/whatsapp?linea=…` devuelve `leido_hasta` de la
  última corrida ok (sale de `sync_runs.log.resumen`). Las simulaciones
  (`dry_run: true`) se registran como `whatsapp-dry` y no mueven el watermark.

## Qué se ve en el CRM

- **/hoy** y **/panel**: el bloque "WhatsApp esperando respuesta" deja de ser la
  foto del 7/8 para los chats de esta línea (tienen `last_message_at`).
- **Ficha del doctor**: la actividad `whatsapp` del día con el resumen, y las
  propuestas de tarea en el panel de IA.
- **Slack #alertas-crm**: doctores con conversación, quiénes esperan respuesta,
  tareas propuestas y chats sin ficha.

## Cómo se lee WhatsApp Web (validado en la primera corrida, 8/9/2026)

No se raspa la pantalla: el `data-id` de los mensajes ya no trae el JID ni la
dirección. Se usa el módulo interno `window.require('WAWebCollections')`
(chats, contactos y mensajes estructurados, con el teléfono real detrás de cada
`@lid`). Lo que WhatsApp Web tiene cargado de un chat es solo lo que se abrió en
pantalla: por eso la rutina abre cada chat de la ventana con un click real y
recién después lee todo el Store. El JSON sale del navegador por una descarga
(los returns de la herramienta se truncan). Snippets exactos en el skill.

Dos efectos que conviene saber: abrir los chats **los marca como leídos** en
WhatsApp, y lo anterior al 6/6/2026 no está en el navegador (queda en el
teléfono). Primera corrida: 27 chats, 234 mensajes, 33 resúmenes, USD 0,18.

## Lo que NO hace

- No manda mensajes. No crea tareas sin aprobación. No toca Periskope.
- No lee el WhatsApp personal de Pancho ni el del consultorio.
- No corre solo: si nadie pide la revisión, el CRM no se entera.

## Verificar una corrida

```sql
-- últimas corridas
select source, status, started_at, rows_upserted, log->'resumen'->>'con_doctor' as con_doctor,
       log->'resumen'->>'leido_hasta' as leido_hasta
from sync_runs where source like 'whatsapp%' order by started_at desc limit 5;

-- actividades que dejó
select a.occurred_at, d.nombre, a.summary, a.outcome
from activities a join doctors d on d.id = a.doctor_id
where a.sync_key like 'wa:5491123740762:%' order by a.occurred_at desc limit 20;
```

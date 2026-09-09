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
- **Lista de doctores y ficha** (migración 0060): el **nivel de interacción con
  soporte** —Real / Puntual / Sin contacto— sale de estos mensajes (los de la
  línea, por doctor, en una ventana de días) más los contactos registrados
  (llamada, videollamada, reunión, visita, KeepDay), y se lee al lado del
  estado con una sugerencia según el cruce. Los umbrales se editan en
  `/ajustes`; cada corrida de este sync recalcula la cartera. Ojo: en la base
  no hay mensajes anteriores al 1/9/2026, y WhatsApp Web guarda desde el
  6/6/2026 — una corrida con ese watermark completa la ventana de 90 días.

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

## Backfill de historia (`solo_mensajes: true`)

Para completar meses viejos —la ventana de 90 días del nivel de interacción
(0060)— el POST acepta `solo_mensajes: true`: guarda chats y mensajes y
recalcula el nivel, pero **no** resume días, **no** crea actividades, **no**
propone tareas y **no** avisa a Slack (un pedido de junio propuesto como tarea
hoy no le sirve a nadie). Tampoco toca el estado del chat (último mensaje,
"esperando respuesta") si el último mensaje tiene más de 7 días: eso ya lo
cubre la corrida diaria, y un mensaje de julio sin contestar es historia, no
un pendiente de hoy. Conviene mandarlo con `leido_hasta` = el watermark que ya
tenía la línea y con los mensajes cortados ahí, así la corrida diaria siguiente
resume lo de hoy como siempre.

Primera corrida: 9/9/2026, ventana 6/6 → 9/9 03:34Z, 64 chats, 253 mensajes
(228 nuevos), 44 con doctor; el nivel de interacción cambió para 9 doctores.
Lo que se aprendió leyendo tres meses desde WhatsApp Web:

- La lista de mensajes está invertida (`flex-direction: column-reverse`):
  scrollTop 0 es el final; para cargar lo anterior hay que restar
  (`sc.scrollTop -= sc.clientHeight * 4`) sobre el único div con
  `overflow-y: auto` dentro de `#main`, con el chat abierto por click real.
- El límite se ve en el DOM: "Usa WhatsApp en tu teléfono para ver mensajes
  anteriores al 6/6/2026" = llegó al principio del historial vinculado. Puede
  estar en el DOM antes de que carguen los mensajes: esperar a que haya más de
  1 cargado antes de creerle.
- "Haz clic aquí para obtener mensajes anteriores de tu teléfono" = lo que
  falta está solo en el teléfono. **No clickearlo por código**: el sync que
  dispara bloquea el renderer y las llamadas de la extensión mueren a los 45 s.
- Cerrar un chat descarga sus mensajes de memoria: extraer cada chat mientras
  está abierto y acumular en `window`, no leer todo al final. Y guardar el
  acumulado en `localStorage` antes de recargar la pestaña.
- La carga del historial depende de que el teléfono de la línea responda: cuando
  no responde, el chat abierto se queda con 1 mensaje y el spinner. Esta vez
  quedaron así Sayuri Tanaka, Benjamín Navarro, Jennifer Solís, Ruth Ramos,
  Sofía Flores, Angélica Rodríguez y los grupos creados a fin de agosto (cuyos
  mensajes de septiembre ya estaban). Se puede repetir con el teléfono a mano.

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

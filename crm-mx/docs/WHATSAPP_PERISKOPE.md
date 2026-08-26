# WhatsApp (Periskope) en el CRM MX

Qué es verdad, qué no, y qué falta para que la lista "WhatsApp esperando
respuesta" deje de ser una foto vieja.

---

## Estado al 26/8/2026

| Dato | Número | Qué significa |
|---|---|---|
| Chats en `wa_conversations` | 1.490 | Los que trajo el export de la consola el 7/8 |
| Marcados "esperando respuesta" | 601 | Con el criterio viejo (habló el doctor último) |
| Vinculados a un doctor del CRM | 184 | Los otros 1.306 son números sueltos, grupos o pacientes |
| Chats con `last_message_at` | **0** | **Ningún evento del webhook llegó nunca** |

La única línea de código del repo que escribe `last_message_at` está en
`app/api/webhooks/periskope/route.ts`. Si la columna está vacía en las 1.490
filas, es porque el webhook nunca corrió.

**Y no es que el endpoint esté roto.** Está vivo y con su secreto puesto en
Vercel Production desde el 22/8. La prueba es el código de respuesta:

- `POST` sin token (o con token equivocado) → **401 No autorizado**
- Si faltara la env `PERISKOPE_WEBHOOK_SECRET` → **503 apagado**

Devuelve 401: la env está, la ruta está desplegada, el token se compara. Y se
probó de punta a punta con un evento sintético, que escribió bien la fila.

**Tampoco falta darlo de alta: el webhook YA está registrado en la consola de
Periskope** desde el 22/8 (eventos `message.created` y `chat.created`, todas las
líneas). Lo verificó Pancho ese día.

**La causa es de Periskope, y está identificada.** La organización
(`f5b29768`) figura como **Enterprise Activa** pero el sistema la trata como
plan free:

- la API REST devuelve 401 "APIs available only for active pro and enterprise plans"
- Automation Rules aparece como "Pro only"
- el contador **Total events: 0** pese a que hay tráfico real de mensajes

Un mensaje de prueba de Pancho llegó a la consola y el webhook nunca disparó.
No hay nada que rearmar de este lado: **cuando Periskope corrija el
entitlement, los eventos empiezan a fluir solos.**

> **ACCIÓN PENDIENTE (desde el 22/8): el mail a `support@periskope.app`.**
> Quedó redactado y nunca se mandó (el conector de Gmail es de solo lectura, así
> que lo tiene que mandar una persona). Es el único paso que destraba WhatsApp
> en tiempo real. Mientras no se mande, todo lo de abajo no cambia nada.

Consecuencia práctica: todo lo que hoy muestran /hoy y /panel bajo "WhatsApp
esperando respuesta" es la foto del **7/8**. Por eso el bloque lleva el aviso
arriba mientras no entre ningún mensaje.

---

## Cómo está registrado el webhook (y cómo rehacerlo si hiciera falta)

Esto YA está hecho. Queda escrito para el día que haya que rehacerlo o revisarlo.

**La URL exacta** (el `SECRETO` es el valor de `PERISKOPE_WEBHOOK_SECRET` en
Vercel → Project → Settings → Environment Variables → Production; se copia con el
ojito, no se reescribe a mano):

```
https://crm-mx-puce.vercel.app/api/webhooks/periskope?k=SECRETO
```

Pasos en la consola de Periskope (`console.periskope.app`), con un usuario
**admin** de la organización:

1. Entrar a **Settings → Developers / Webhooks** (según la versión aparece como
   "Webhooks" o dentro de "Integrations").
2. **Add webhook / New endpoint** y pegar la URL de arriba, **con el `?k=`
   incluido**. Método POST, formato JSON. Si pide un secreto de firma propio de
   Periskope, se puede dejar el que ofrezca: el CRM no lo usa, valida por el
   token de la URL.
3. Suscribir los eventos de mensajes, **entrantes y salientes**:
   - mensaje recibido (`message.received` / "incoming message")
   - mensaje enviado (`message.sent` / "outgoing message")

   Los dos, no solo el entrante: sin los salientes, un chat que el equipo ya
   contestó desde Periskope se queda marcado como pendiente para siempre.
   Los eventos de acks, reacciones o estado de línea se pueden dejar sin marcar;
   si llegan igual, el endpoint los acusa con 200 y los ignora.
4. Guardar y, si la consola ofrece **"Send test event"**, mandarlo.
5. Escribirse un mensaje de prueba a una de las líneas MX y contestarlo.

**Cómo verificar que llegó el primero** — pegar esto en el editor SQL de
Supabase (proyecto `yuxfgbbqhqquuoaudjdd` → SQL Editor → New query → Run):

```sql
-- ¿El webhook está entrando? con_evento tiene que dejar de ser 0.
select count(*)                                          as chats,
       count(*) filter (where last_message_at is not null) as con_evento,
       max(last_message_at)                              as ultimo_evento
from wa_conversations;
```

Y para ver el mensaje concreto que entró (nombre, línea, texto y si la base lo
consideró pendiente):

```sql
select chat_name,
       phone,
       lineas,
       last_message_from_me                as lo_escribimos_nosotros,
       left(last_message_body, 60)         as ultimo_mensaje,
       last_message_at,
       unanswered                          as espera_respuesta
from wa_conversations
where last_message_at is not null
order by last_message_at desc
limit 10;
```

Si `con_evento` sigue en 0 diez minutos después de mandar el mensaje de prueba,
seguir con la sección de abajo.

---

## Qué pasa si Periskope nombra distinto los campos

El endpoint exige dos campos en el `data` del evento: **`chat_id`** y
**`org_phone`**. Si alguno no viene —porque esta versión de Periskope los manda
como `chatId`, `phone`, `from`, o los anida dentro de `message`— el webhook
responde **200 `{ok:true, ignored:...}`** y no escribe nada.

Eso es a propósito (un webhook que devuelve error hace que el proveedor lo
desactive por "endpoint caído"), pero tiene un costo: **desde afuera es
indistinguible de "no está configurado"**. En los dos casos la tabla queda igual.

Para distinguirlos hay que mirar los logs:

1. Vercel → proyecto `crm-mx` → pestaña **Logs** (o Deployments → el deploy de
   Production → Runtime Logs).
2. Filtrar por `webhook periskope`.
3. Qué se ve:
   - **Nada, ni una línea** → Periskope no está llamando. Al 26/8 este es el
     caso, y la causa es el entitlement de la cuenta (ver arriba), no la
     configuración. Antes de tocar nada, chequear en la consola que el contador
     "Total events" siga en 0: si sigue en 0, es Periskope.
   - `ignorado — sin chat_id/org_phone. Campos recibidos: ...` → Periskope SÍ
     está llamando, pero con otros nombres de campo. La línea lista las claves
     que llegaron: con eso se ajusta la interfaz `MsgData` de
     `app/api/webhooks/periskope/route.ts` (una línea por campo) y se redeploya.
   - `chat=...@c.us linea=... from_me=false body=37ch` → está funcionando.
   - `No autorizado` (401 en el log de acceso) → el `?k=` de la consola no
     coincide con la env de Vercel.

---

## La línea por persona: por qué el CRM no puede forzarla

Verificado el 26/8 leyendo el bundle de `console.periskope.app`: la consola elige
con qué línea de la organización estás mirando combinando **el dropdown de
arriba** con **localStorage** (`activePhoneMap`). No hay parámetro de URL, ni
hash, ni path que la fije. **Un link no puede forzar la línea.** Si Juan abre un
chat de la línea de Rocío, lo ve en la línea que su navegador tenga guardada de
la última vez: la conversación aparece vacía o incompleta.

Es una limitación de Periskope, no del CRM. Los dos caminos reales:

1. **Acotar la línea desde Periskope (el bueno).** Poner a Juan y a Rocío como
   miembros **no-admin** de la organización, cada uno con sus `org_phones`
   limitados a su línea. Un no-admin no tiene qué elegir mal: la consola le abre
   siempre la suya. Los admin ven todas las líneas — por eso el admin es
   justamente quien se puede equivocar.
2. **Avisar, que es lo que hace el CRM.** Cada renglón de "WhatsApp esperando
   respuesta" muestra en qué línea vive el chat (`línea …5144`, o `en 2 líneas`)
   y marca *"no pasa por tu línea"* cuando no es la de quien mira. El dato sale
   de `profiles.periskope_org_phone` (migración 0041) contra `wa_conversations.lineas[]`.

Cargar o corregir la línea de una persona, desde el editor SQL de Supabase:

```sql
-- Solo dígitos, sin @c.us. Hay un CHECK que rechaza cualquier otra cosa.
update profiles set periskope_org_phone = '5215510685144' where nombre ilike 'juan%';
update profiles set periskope_org_phone = '5491123740762' where nombre ilike 'roc%';
select nombre, rol, periskope_org_phone from profiles order by nombre;
```

### Las líneas de la organización

| Línea | Nombre en Periskope | Quién |
|---|---|---|
| `5215510685144` | — | **Juan** (SALES) |
| `5491123740762` | — | **Rocío** (CLINICAL) — número argentino, atiende MX |
| `5215549149356` | Ortodoncia Keep | sin dueño asignado |
| `5215547940498` | — | sin dueño asignado |
| `5216642962789` | Keep Smiling | sin dueño asignado |

Un mismo chat puede vivir en varias líneas (el doctor le escribió a más de un
número). De 1.487 chats: 1.167 en una sola línea, 237 en dos, 75 en tres y 8 en
cuatro. Por eso el badge dice `en 3 líneas` en vez de inventar una sola.

---

## Quién decide ahora "esperando respuesta"

Desde la migración **0041** (26/8) **no lo decide el webhook**: lo decide la base.

- El webhook guarda el hecho crudo: `last_message_body` (recortado a 2.000
  caracteres), `last_message_from_me`, `last_message_at`, `lineas[]`.
- El trigger `wa_conv_unanswered` llama a `wa_requiere_respuesta(texto, from_me)`
  y escribe `unanswered`. Antes la regla era literal —"habló el doctor último"—
  y un *"de nada"* después de nuestro *"gracias"* quedaba como pendiente. Ahora
  se descuentan las cortesías; si queda contenido, o si hay una pregunta, es
  pendiente. Ante la duda: pendiente.
- El botón **"Ya respondí"** del CRM llama a la RPC `wa_marcar_respondido` (única
  puerta de escritura para un usuario logueado; el resto de la tabla la escribe
  el webhook con service role). Si después entra un mensaje nuevo del doctor, la
  marca se limpia sola y el chat vuelve a la lista.

Un detalle del webhook que conviene saber: **el match de doctor por teléfono solo
corre cuando el chat es nuevo**. Reintentarlo en cada mensaje de los 1.306 chats
sin doctor era una consulta a `doctors` por mensaje que ya sabemos que falla —el
teléfono del doctor no cambia porque nos escriba de nuevo—. El barrido masivo,
que sí puede encontrar vínculos nuevos, es `scripts/import-whatsapp.ts`.

---

## Archivos

| Qué | Dónde |
|---|---|
| Endpoint del webhook | `app/api/webhooks/periskope/route.ts` |
| Link a la consola y helpers de línea | `lib/phone.ts` |
| Botón "Ya respondí" (server action) | `lib/actions/whatsapp.ts` |
| Bloque "esperando respuesta" | `components/whatsapp/wa-esperando.tsx` |
| Regla, trigger y RPC | `supabase/migrations/0041_whatsapp_respondido.sql` |
| Import masivo del export | `scripts/import-whatsapp.ts` |

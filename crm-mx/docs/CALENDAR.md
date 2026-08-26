# Google Calendar en el CRM (la agenda del día con el brief del doctor)

Antes de cada llamada, el CRM muestra la hora, con quién es y **tres oraciones
sobre ese doctor**: quién es, qué pasó y con qué abrir. Este documento es la
puesta en marcha, de punta a punta.

Piezas:

| Archivo | Qué hace |
|---|---|
| `gas-calendar.gs` | Apps Script en la cuenta de Google de la persona. Publica sus eventos de los próximos 14 días como JSON. |
| `supabase/migrations/0046_calendar.sql` | Tabla `calendar_events` (espejo de la agenda, una fila por evento y persona). |
| `lib/calendar-sync.ts` | Baja el JSON, upsertea y resuelve a qué doctor corresponde cada evento. |
| `app/api/sync/calendar/route.ts` | El cron (`vercel.json`, 12:45 UTC = 06:45 de México, lunes a viernes). |
| `lib/brief-doctor.ts` | Las 3 oraciones. Sin IA: reglas, determinista y gratis. |
| `components/calendar/agenda-hoy.tsx` | Cómo se ve en pantalla. |

---

## Por qué Apps Script y no OAuth

El CRM no tiene dónde guardar un *refresh token* de Google: todas sus
credenciales son envs planas y no existe ninguna tabla de tokens. OAuth
obligaría a construir esa pieza entera (pantalla de consentimiento, callback,
renovación, revocación) para leer una agenda. Un `.ics` público obligaría a
hacer **pública** la agenda de una persona.

Con Apps Script, Rocío autoriza **una vez en su propia cuenta** y el script corre
como ella: el CRM solo ve lo que ese archivo decide sacar (título, horario,
invitados) y ella puede cortar el acceso borrando la implementación. Es el mismo
patrón que ya funciona con `gas-pagos-planilla.LISTO.gs`.

---

## 1. Desplegar el Apps Script (en la cuenta de Rocío, 5 minutos)

Esto lo hace **ella**, con su sesión de Google abierta. Alcanza con acompañarla.

1. Generar el secreto (en cualquier terminal): `openssl rand -hex 24`. Guardarlo,
   se usa dos veces.
2. Entrar a [script.google.com](https://script.google.com) → **Nuevo proyecto** →
   borrar lo que haya y pegar `gas-calendar.gs` entero.
3. Reemplazar `CAMBIAR-POR-UN-SECRETO-PROPIO` por el secreto del paso 1.
4. **Implementar → Nueva implementación** → tipo **Aplicación web**:
   - Ejecutar como: **Yo** (la cuenta de Rocío)
   - Quién tiene acceso: **Cualquier usuario**
   - **Implementar**. La primera vez pide autorizar el acceso a Calendar:
     aceptar (aparece un aviso de "app no verificada" → *Configuración avanzada*
     → *Ir a (nombre del proyecto)*).
5. Copiar la URL que termina en **`/exec`**.

Probar antes de seguir — pegar en el navegador:

```
https://script.google.com/macros/s/…/exec?secret=EL-SECRETO
```

Tiene que devolver `{"generado":"…","eventos":[…]}`. Si devuelve `no`, el
secreto no coincide; si pide iniciar sesión, la implementación quedó privada
(rehacer el paso 4 con "Cualquier usuario").

> Cada vez que se edite el `.gs` hay que hacer **Nueva implementación** (o
> *Administrar implementaciones* → editar → *Nueva versión*). Guardar el código
> **no** actualiza la URL publicada.

---

## 2. Cargar las envs en Vercel

Son tres, y `CALENDAR_PROFILE` es el `nombre` de la persona **tal como está en la
tabla `profiles`** (hoy: `Pancho`, `Juan`, `Rocío`).

```bash
cd crm-mx
printf '%s' 'https://script.google.com/macros/s/…/exec' | npx vercel env add CALENDAR_URL production
printf '%s' 'EL-SECRETO' | npx vercel env add CALENDAR_SECRET production
printf '%s' 'Rocío'      | npx vercel env add CALENDAR_PROFILE production
```

Para sumar a otra persona: repetir la terna con sufijo `_2` (y después `_3`,
`_4`), cada una con **su** despliegue del Apps Script en **su** cuenta:

```bash
printf '%s' 'https://script.google.com/macros/s/…/exec' | npx vercel env add CALENDAR_URL_2 production
printf '%s' 'OTRO-SECRETO' | npx vercel env add CALENDAR_SECRET_2 production
printf '%s' 'Juan'         | npx vercel env add CALENDAR_PROFILE_2 production
```

No hay que tocar código para agregar a alguien. Las envs nuevas entran en el
próximo deploy (`npx vercel --prod`).

Sin ninguna terna cargada, `/api/sync/calendar` responde **503** y no rompe nada.

---

## 3. Aplicar la migración

```bash
cd crm-mx
npx tsx scripts/db-migrate.ts supabase/migrations/0046_calendar.sql --ensayo   # ensayo, no escribe
npx tsx scripts/db-migrate.ts supabase/migrations/0046_calendar.sql --apply
```

Para volver atrás: `supabase/rollbacks/0046_calendar_rollback.sql`. Borrar la
tabla no pierde nada propio — es un espejo del calendario y la próxima corrida
la vuelve a llenar.

---

## 4. Verificar

Disparar el sync a mano (el `CRON_SECRET` es el de Vercel):

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" https://crm-mx-puce.vercel.app/api/sync/calendar | head -c 600
```

Devuelve `{"ok":true,"resumen":[{"profile":"Rocío","leidos":N,"upserteados":N,"con_doctor":N,"sin_doctor":N}],…}`.

Y en el editor SQL de Supabase, para ver qué entró y con qué doctor quedó
vinculado cada evento:

```sql
select p.nombre                as agenda,
       ce.inicio at time zone 'America/Mexico_City' as inicio_mx,
       ce.titulo,
       d.nombre                as doctor,
       ce.match_source
from calendar_events ce
join profiles p on p.id = ce.profile_id
left join doctors d on d.id = ce.doctor_id
where ce.inicio >= now() - interval '1 day'
order by ce.inicio
limit 50;
```

Cuántos eventos quedaron sin doctor (es el número que dice si el match sirve):

```sql
select match_source, count(*)
from calendar_events
where inicio >= now()
group by match_source;
```

---

## Cómo se vincula el evento con el doctor

Dos reglas, en este orden, y **ninguna adivina**:

1. **Mail del invitado** contra `doctors.email` (exacto, normalizado). Es el
   único match que no puede estar equivocado. Queda `match_source = 'email'`.
2. **Nombre en el título**: se normaliza el título (minúsculas, sin acentos) y
   se cuenta cuántas palabras del nombre del doctor aparecen enteras. Gana el que
   más acierte, **y solo si gana solo**. Queda `match_source = 'titulo'`.

No se busca "el apellido" porque no se puede saber cuál es: medido contra la
base, los doctores están cargados de las dos formas —*"Flores Heredia Mayra
Sofia"* (apellido primero, como los trajo Noloco) y *"Mayra Ramos Martinez"*
(nombre primero, tipeado a mano)—, más un montón en MAYÚSCULAS.

Qué pasa en la práctica (probado contra los 7.000 doctores reales):

| Título del evento | Resultado |
|---|---|
| `Zoom Dra. Schnaas Jennifer` | Schnaas Jennifer |
| `Seguimiento Meza Martinez` | Meza Martinez Winny Lorelei |
| `Call Flores Heredia Mayra` | Flores Heredia Mayra Sofia (acierta 3; la otra "Heredia Mayra" acierta 2) |
| `Llamada Dra. Higuera` | **null** — hay 4 Higuera en la base |
| `Videollamada con Dr. Flores` | **null** — hay 120 Flores |
| `Reunión de equipo` / `Almuerzo` | **null** |

Cuando empatan, **`doctor_id` queda en `null`**: el evento igual se muestra en la
agenda, sin brief. Un brief del doctor equivocado es peor que no tener brief. Si
un doctor se repite mucho en la agenda y el título corto no alcanza, la solución
es **invitarlo al evento** con su mail: ese match es exacto.

Palabras que nunca cuentan como nombre (`RUIDO` en `lib/calendar-sync.ts`):
"equipo", "reunión", "consulta", "casos"… Hay fichas cargadas como *"Dra Natalia
Ciocale y equipo"*, y sin esa lista el evento "Reunión de equipo" le pegaba el
brief de esa doctora a una reunión interna.

El evento crudo se guarda siempre en `calendar_events.raw`: si algún día el
match mejora, se puede recalcular sin volver a pegarle a Google.

**Lo que hoy no hace:** lo que se cancela en Google queda en la tabla hasta que
alguien lo borre. El sync solo agrega y actualiza.

---

## El brief no pasa por la IA (a propósito)

`briefDoctor()` arma las 3 oraciones con reglas sobre lo que ya está en la ficha.
Es determinista, sale en microsegundos y no cuesta un peso. Un texto que se lee
30 segundos antes de atender una llamada no puede depender de una API que a veces
tarda 4 segundos, ni puede alucinar un dato sobre un doctor real con la persona
ya en la línea.

Cada oración se arma **solo con los datos presentes**. Si falta un dato, la
oración se acorta; nunca se rellena con un supuesto. Cuando la ficha está vacía,
el brief lo dice con todas las letras: *"Poca información cargada: arrancá
preguntando cómo viene el mes"*. Es preferible que Rocío sepa que va a ciegas a
que crea que sabe algo.

| Oración | Qué dice | De dónde sale |
|---|---|---|
| 1. Quién es | Categoría, ciudad, volumen, especialidad, Instagram | `categoria`, `city`/`state`/`zona`, `case_count`, `new_case_count`, `specialty`, `instagram`; si no mandó casos todavía: `lifecycle_stage`, `estimated_cases_month`, `uses_aligners` |
| 2. Qué pasó | Último contacto, ritmo, qué manda, a qué evento fue | `last_contact_at`, `avg_interval_days`, tipos de tratamiento de sus casos, `events` a los que asistió |
| 3. Con qué abrir | Una sola cosa, por prioridad: atraso contra su propio ritmo → `why_interesting` → evento reciente → `competitor_brands` → "viene al día, preguntale cómo viene el mes" → decir que no hay datos | lo anterior |

La última fila importa: *"Poca información cargada"* sale **solo** cuando la
ficha está realmente vacía. Decirle eso de un doctor con 46 casos y contacto de
la semana pasada sería justamente la clase de frase falsa que este brief evita.

Las reglas están probadas en `lib/brief-doctor.test.ts` (`npm test`).

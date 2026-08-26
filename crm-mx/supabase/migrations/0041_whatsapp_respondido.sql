-- 0041 — WhatsApp: qué es realmente "esperando respuesta", y en qué línea vive
-- cada chat.
--
-- LO QUE SE ROMPIÓ (diagnóstico del 26/8, con Juan y Rocío mirando la pantalla):
--   1. `unanswered` es una foto congelada del export de la consola del 7/8. Las
--      1.490 filas tienen `last_message_at` en NULL — la única línea del repo que
--      escribe esa columna es el webhook, así que el webhook NUNCA procesó un
--      evento. El endpoint está vivo y con su secreto puesto desde el 22/8
--      (responde 401, no 503): lo que falta es registrar la URL en la consola de
--      Periskope. Ver docs/WHATSAPP_PERISKOPE.md.
--   2. El criterio era literal: `unanswered = not from_me`. Un "de nada" del
--      doctor después de nuestro "gracias" quedaba marcado como pendiente.
--
-- LO QUE HACE ESTA MIGRACIÓN:
--   a) Guarda el texto y la dirección del último mensaje, para poder decidir.
--   b) Una función `wa_requiere_respuesta(texto, from_me)` que descarta cortesías
--      de cierre. Es la MISMA regla para el webhook y para cualquier backfill.
--   c) `respondido_at` / `respondido_por`: el botón "ya está respondido" del CRM,
--      para bajar la marca a mano cuando el equipo contestó por fuera.
--   d) `profiles.periskope_org_phone`: qué línea de WhatsApp atiende cada uno.
--
-- OJO, lo que esta migración NO puede arreglar: la consola de Periskope elige la
-- línea con estado del navegador (dropdown + localStorage), no por URL. El CRM
-- puede DECIR en qué línea está un chat, no puede FORZARLA. Para forzarla hay que
-- poner a Juan y a Rocío como miembros no-admin en Periskope con su línea asignada.
--
-- Rollback: supabase/rollbacks/0041_whatsapp_respondido_rollback.sql

alter table wa_conversations
  add column if not exists last_message_body text,
  add column if not exists last_message_from_me boolean,
  add column if not exists respondido_at timestamptz,
  add column if not exists respondido_por uuid references profiles(id);

comment on column wa_conversations.last_message_body is
  'Texto del último mensaje del chat, tal como llegó por el webhook. Se usa para decidir si pide respuesta (ver wa_requiere_respuesta) y para mostrar el preview.';
comment on column wa_conversations.respondido_at is
  'Cuándo alguien marcó el chat como respondido desde el CRM. Se limpia sola cuando entra un mensaje nuevo del doctor.';

alter table profiles
  add column if not exists periskope_org_phone text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_periskope_org_phone_formato') then
    alter table profiles add constraint profiles_periskope_org_phone_formato
      check (periskope_org_phone is null or periskope_org_phone ~ '^[0-9]{11,15}$');
  end if;
end $$;

comment on column profiles.periskope_org_phone is
  'Línea de WhatsApp de la organización desde la que atiende esta persona en Periskope. Mismo formato que wa_conversations.lineas[] y que org_phone del webhook: solo dígitos, sin @c.us. Ej: 5215510685144 = la de Juan.';

-- ---------------------------------------------------------------------------
-- ¿Este mensaje pide respuesta?
--
-- Regla, en orden:
--   · si el último mensaje es NUESTRO           → no
--   · si es del doctor y NO sabemos el texto    → sí (criterio viejo, conservador)
--   · si es una cortesía de cierre y corta      → no  ("de nada", "gracias", "ok", "👍")
--   · si además de la cortesía hay una pregunta → sí  ("gracias! y cuándo llega?")
--   · cualquier otra cosa                       → sí
--
-- Es deliberadamente conservadora: ante la duda marca pendiente. Un falso
-- pendiente cuesta un vistazo; un pendiente perdido cuesta un doctor.
-- ---------------------------------------------------------------------------
-- Cómo decide: en vez de intentar reconocer la frase entera de cortesía (que
-- se rompe con cualquier variante), le RESTA al mensaje las cortesías y las
-- muletillas. Si no queda nada, era solo cortesía. Lo que sobra es contenido.
create or replace function wa_requiere_respuesta(texto text, from_me boolean)
returns boolean
language plpgsql immutable as $$
declare
  t text;
  palabras int;
begin
  if coalesce(from_me, false) then
    return false;                     -- habló el equipo último
  end if;
  if texto is null then
    return true;                      -- sin texto no se puede decidir: pendiente
  end if;

  -- normalizar: minúsculas, sin acentos
  t := lower(btrim(texto));
  t := translate(t, 'áéíóúàèìòùäëïöüâêîôûñ', 'aeiouaeiouaeiouaeioun');

  -- una pregunta explícita SIEMPRE pide respuesta, aunque venga con un gracias
  if t like '%?%' or t like '%¿%' then
    return true;
  end if;

  -- sacar signos y emojis; colapsar espacios
  t := btrim(regexp_replace(regexp_replace(t, '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'));

  if t = '' then
    return false;                     -- solo emojis o stickers: un 👍 no pide respuesta
  end if;

  -- un mensaje largo es un mensaje, no una despedida
  palabras := coalesce(array_length(regexp_split_to_array(t, ' '), 1), 0);
  if palabras > 12 then
    return true;
  end if;

  -- 1) frases de cortesía (las de varias palabras primero)
  t := regexp_replace(t, '\m(' ||
      'muchas gracias|mil gracias|no hay de que|de nada|por nada|con gusto|' ||
      'un placer|para servirle|para servirte|a la orden|estamos para servirle|' ||
      'cuando guste|cuando gustes|cualquier cosa|quedo atento|quedo atenta|' ||
      'buenos dias|buen dia|buenas tardes|buenas noches|hasta luego|hasta pronto|' ||
      'nos vemos|que tenga|que tengas|linda tarde|lindo dia|feliz dia|feliz noche|' ||
      'muy amable|muy bien|todo bien|de acuerdo|asi es|claro que si|si señor|' ||
      'me queda claro|entendido|enterado|entiendo|perfecto|excelente|correcto|exacto' ||
    ')\M', ' ', 'g');

  -- 2) palabras sueltas de cortesía y muletillas
  t := regexp_replace(t, '\m(' ||
      'gracias|gracia|graciass|listo|genial|dale|sale|va|vale|claro|ok+|oka|okay|okey|' ||
      'hola|buenas|saludos|igualmente|felicidades|felicitaciones|bendiciones|' ||
      'abrazo|abrazos|cuidate|cuidese|adios|chao|bye|amen|bendecido|bendecida|' ||
      'si+|sip|no|nop|nada|bien|super|padre|padrisimo|' ||
      '(ja|je|ji|ha|he|hi){2,}|' ||
      -- muletillas y conectores: no aportan contenido por sí solos
      'doctor|doctora|dr|dra|equipo|chicos|chicas|amigo|amiga|amigos|' ||
      'el|la|lo|los|las|un|una|unos|unas|y|e|o|de|del|a|al|por|para|con|sin|' ||
      'su|sus|tu|tus|mi|mis|me|te|se|le|les|nos|que|es|son|esta|estan|muy|' ||
      'todo|toda|todos|todas|usted|ustedes|ti|vos|yo|mucho|mucha|muchas|muchos|mil|' ||
      'atencion|apoyo|ayuda|informacion|info|dato|datos|respuesta|amable|estimado|estimada' ||
    ')\M', ' ', 'g');

  t := btrim(regexp_replace(t, '\s+', ' ', 'g'));

  -- si no quedó nada con contenido, era solo cortesía
  return t <> '';
end $$;

revoke all on function wa_requiere_respuesta(text, boolean) from public, anon;
grant execute on function wa_requiere_respuesta(text, boolean) to authenticated, service_role;

comment on function wa_requiere_respuesta(text, boolean) is
  'Regla única de "este chat espera respuesta". La usa el webhook de Periskope y cualquier backfill. Conservadora: ante la duda, pendiente.';

-- ---------------------------------------------------------------------------
-- El webhook NO decide: reporta el mensaje y la base aplica la regla. Una sola
-- implementación, imposible que se desincronicen.
--
-- Solo recalcula cuando llega un mensaje DE VERDAD (last_message_at cambió).
-- Así el "ya está respondido" cargado a mano sobrevive, y los imports viejos
-- del export de la consola (que no traen last_message_at) quedan intactos.
-- ---------------------------------------------------------------------------
create or replace function wa_conv_unanswered() returns trigger
language plpgsql as $$
begin
  if new.last_message_at is not null
     and (tg_op = 'INSERT' or new.last_message_at is distinct from old.last_message_at)
  then
    new.unanswered := wa_requiere_respuesta(new.last_message_body, new.last_message_from_me);
    -- mensaje nuevo del doctor: lo que se marcó respondido antes ya no vale
    if new.unanswered then
      new.respondido_at := null;
      new.respondido_por := null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists wa_conv_unanswered_trg on wa_conversations;
create trigger wa_conv_unanswered_trg
  before insert or update on wa_conversations
  for each row execute function wa_conv_unanswered();

revoke all on function wa_conv_unanswered() from public, anon;

-- ---------------------------------------------------------------------------
-- Marcar respondido a mano no puede ser un update libre: el resto de la tabla
-- la escribe solo el webhook (service role). Esta función es la única puerta
-- que tiene un usuario logueado.
-- ---------------------------------------------------------------------------
create or replace function wa_marcar_respondido(chat uuid, respondido boolean default true)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  encontrado boolean;
begin
  if auth.uid() is null then
    raise exception 'Sesión requerida';
  end if;
  if not can_write() then
    raise exception 'Tu rol no puede marcar chats como respondidos';
  end if;

  update wa_conversations
     set unanswered     = not respondido,
         respondido_at  = case when respondido then now() end,
         respondido_por = case when respondido then auth.uid() end
   where id = chat
  returning true into encontrado;

  return coalesce(encontrado, false);
end $$;

revoke all on function wa_marcar_respondido(uuid, boolean) from public, anon;
grant execute on function wa_marcar_respondido(uuid, boolean) to authenticated, service_role;

-- índice para el bloque "esperando respuesta" de /hoy y /panel
create index if not exists wa_conv_unanswered_bucket_idx
  on wa_conversations (activity_bucket, doctor_id)
  where unanswered;

-- ---------------------------------------------------------------------------
-- Backfill: reevaluar lo que ya está marcado. Como del export del 7/8 no tenemos
-- el texto (last_message_body queda en null), la regla devuelve "pendiente" y
-- nada cambia. Queda igual escrito para que la migración sea la fuente de verdad
-- el día que el webhook empiece a traer cuerpos.
-- ---------------------------------------------------------------------------
update wa_conversations
   set unanswered = wa_requiere_respuesta(last_message_body, last_message_from_me)
 where last_message_body is not null
   and unanswered is distinct from wa_requiere_respuesta(last_message_body, last_message_from_me);

do $$
declare
  sin_texto int;
begin
  select count(*) into sin_texto from wa_conversations where last_message_at is null;
  if sin_texto > 0 then
    raise notice '0041 OJO: % chats sin ningún mensaje procesado por el webhook. Mientras la URL no esté registrada en la consola de Periskope, "esperando respuesta" sigue siendo la foto del 7/8.', sin_texto;
  end if;
  raise notice '0041 OK: cuerpo del último mensaje, regla de cortesías, botón de respondido y línea por persona.';
end $$;

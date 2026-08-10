-- 0009: metadata de chats Periskope (export consola 7/8 — sin cuerpos de mensajes,
-- la API sigue plan-gated). El loader es scripts/import-whatsapp.ts.
-- los grupos (@g.us) no tienen teléfono de contacto
alter table wa_conversations alter column phone drop not null;

alter table wa_conversations
  add column if not exists chat_name text,
  add column if not exists lineas text[] default '{}',
  add column if not exists asignado text,
  add column if not exists activity_bucket text
    check (activity_bucket in ('7d','30d','mas_30d'));

create index if not exists wa_conv_doctor_unanswered_idx
  on wa_conversations (doctor_id)
  where unanswered and doctor_id is not null;

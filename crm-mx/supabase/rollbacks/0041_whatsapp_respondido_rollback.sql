-- Rollback de 0041_whatsapp_respondido.sql
drop function if exists wa_marcar_respondido(uuid, boolean);
drop function if exists wa_requiere_respuesta(text, boolean);
drop index if exists wa_conv_unanswered_bucket_idx;
alter table wa_conversations
  drop column if exists last_message_body,
  drop column if exists last_message_from_me,
  drop column if exists respondido_at,
  drop column if exists respondido_por;
alter table profiles drop constraint if exists profiles_periskope_org_phone_formato;
alter table profiles drop column if exists periskope_org_phone;
drop trigger if exists wa_conv_unanswered_trg on wa_conversations;
drop function if exists wa_conv_unanswered();

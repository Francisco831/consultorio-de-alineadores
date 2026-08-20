-- 0036 — Instagram como canal de contacto de la ficha (censo de seguidores 20/8/2026).
--
-- POR QUÉ UNA COLUMNA Y NO UN TAG MÁS. El 20/8 se censaron los 1.402 seguidores de
-- @keepsmiling_mex y 228 cruzaron con fichas del CRM. Esos doctores quedaron con el
-- tag "sigue-instagram", que responde "¿me sigue?" pero no "¿a quién le escribo?".
-- Para varios de ellos Instagram es el ÚNICO canal que tenemos: en el análisis de
-- WhatsApp del 7/8 quedaron 10 doctores sin teléfono ni chat identificado, y los
-- prospectos que nacen del censo no traen más que el handle.
--
-- La ficha ya tiene un bloque de WhatsApp que dice "conseguir el teléfono vale oro"
-- cuando no hay canal. Esta columna es para que en esos casos deje de ser cierto.
--
-- El handle se guarda SIN arroba y en minúsculas, que es como viene de la API de
-- Instagram y como se arma la URL (instagram.com/<handle>). El unique parcial evita
-- que dos fichas se queden con la misma cuenta: si aparece, es que hay duplicados
-- para fusionar, y es mejor que explote la carga a que el dato quede ambiguo.

alter table doctors
  add column if not exists instagram text;

alter table doctors
  drop constraint if exists doctors_instagram_formato;
alter table doctors
  add constraint doctors_instagram_formato
  check (instagram is null or instagram ~ '^[a-z0-9._]{1,30}$');

create unique index if not exists doctors_instagram_key
  on doctors (instagram) where instagram is not null;

comment on column doctors.instagram is
  'Handle de Instagram sin arroba, en minúsculas. Censo de seguidores 20/8/2026 '
  '(scripts/tag-seguidores-ig.ts) y carga manual. La URL es instagram.com/<handle>.';

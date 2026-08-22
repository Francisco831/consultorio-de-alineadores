-- 0037 — Estado de la alerta de rechazos de propuesta (portal keepsmiling-v2, AR).
--
-- La alerta corría en la Mac de Pancho (launchd, ~/ks-alertas) y se migró a un
-- cron de Vercel (/api/sync/alerta, cada 10 min) el 21/8/26 — primer paso de
-- "que nada corra en mi Mac". La tabla guarda cuántos rechazos ya se avisaron
-- por caso: el cron avisa solo cuando el conteo real supera al guardado, así
-- las corridas frecuentes no re-avisan. Nota: los casos son del portal AR
-- (keepsmiling-v2), no de xanoCasos — no referencia a cases del CRM a propósito.
--
-- Sin policies: escribe y lee únicamente el service role (el cron).
create table alerta_rechazos_estado (
  caso text primary key,
  rechazos int not null,
  updated_at timestamptz not null default now()
);
alter table alerta_rechazos_estado enable row level security;

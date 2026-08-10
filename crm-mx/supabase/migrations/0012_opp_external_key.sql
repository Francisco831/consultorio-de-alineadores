-- 0012: clave externa para upserts idempotentes de oportunidades importadas
-- (viabilidades de la planilla de Angie/Ursula; mismo patrón que payments.external_key)
alter table opportunities add column if not exists external_key text;
-- unique SIN predicado parcial: PostgREST/upsert necesita el constraint completo
-- para ON CONFLICT (los NULL no chocan entre sí: NULLS DISTINCT es el default)
drop index if exists opportunities_external_key_idx;
create unique index if not exists opportunities_external_key_uq
  on opportunities (external_key);

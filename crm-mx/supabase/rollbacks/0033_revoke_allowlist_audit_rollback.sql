-- Rollback de 0033: restituye el estado accidental anterior (ejecutable por
-- PUBLIC). Solo tiene sentido para volver a un diff limpio contra una base que
-- no tenga 0033.
grant execute on function auth_allowlist_audit() to public;

-- Rollback de 0028_migration_ledger.sql.
--
-- OJO: borrar el ledger no deshace ninguna migración. Lo único que se pierde es el
-- registro de qué se aplicó, que es justamente lo que 0028 vino a resolver. Después
-- de correr esto, el runner vuelve a no saber qué está aplicado y `--apply` sin
-- argumentos intenta re-aplicar las 28 migraciones desde cero.
--
-- Antes de correrlo, guardá el contenido:
--   select * from ops.schema_migrations order by filename;

drop table if exists ops.schema_migrations;

-- El schema se borra solo si quedó vacío: si alguien agregó otra cosa en `ops`,
-- `restrict` hace fallar el drop en vez de llevársela puesta.
drop schema if exists ops restrict;

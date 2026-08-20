-- 0000: ledger de migraciones.
-- Base nueva: el runner (scripts/db-migrate.ts) aplica este archivo primero si el
-- ledger no existe, y después registra cada migración EN LA MISMA transacción que
-- la aplica. Idéntico en espíritu al 0028 del CRM.
-- Idempotente: todo es `if not exists`.

create schema if not exists ops;

revoke all on schema ops from public;
revoke usage on schema ops from anon, authenticated;
grant usage on schema ops to service_role;

create table if not exists ops.schema_migrations (
  filename    text primary key,
  checksum    text        not null,
  applied_at  timestamptz not null default now(),
  applied_by  text        not null default session_user,
  duration_ms integer
);

comment on table ops.schema_migrations is
  'Qué migración se aplicó a esta base, cuándo y con qué contenido. La escribe '
  'scripts/db-migrate.ts en la MISMA transacción que la migración: si la migración '
  'falla, la fila no queda.';

revoke all on table ops.schema_migrations from public;
revoke all on table ops.schema_migrations from anon, authenticated;
grant select, insert, update, delete on table ops.schema_migrations to service_role;

alter table ops.schema_migrations enable row level security;

-- Sin policy, una lectura como service_role devuelve CERO FILAS en silencio y un
-- ledger vacío lleva al runner a re-aplicar migraciones. Policy explícita siempre.
drop policy if exists schema_migrations_service on ops.schema_migrations;
create policy schema_migrations_service on ops.schema_migrations
  to service_role using (true) with check (true);

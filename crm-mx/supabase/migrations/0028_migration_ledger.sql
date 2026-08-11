-- 0028: ledger de migraciones.
--
-- Hasta acá no había forma de saber qué migración estaba aplicada en qué base.
-- El registro era `supabase/HOTFIX_LOG.md`, a mano, y el propio archivo aclara que
-- "una fila sin salida verificada no cuenta como aplicada". Eso alcanzó para un
-- hotfix; no alcanza para operar.
--
-- Paso R-2 de PLAN_REMEDIACION_CRM.md.
--
-- POR QUÉ EN UN SCHEMA APARTE Y NO EN `public`
-- PostgREST expone `public` por HTTP. Una tabla de infraestructura en `public` es
-- una superficie más para cuidar, y no hay ningún motivo para que la aplicación la
-- vea. El schema `ops` no está en la lista de schemas expuestos de Supabase
-- (`public, graphql_public`), así que no es alcanzable por la API REST.
--
-- Rollback: supabase/rollbacks/0028_migration_ledger_rollback.sql
-- Idempotente: todo es `if not exists`.

create schema if not exists ops;

-- Nadie que venga de la API tiene por qué entrar acá.
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
comment on column ops.schema_migrations.checksum is
  'SHA-256 del contenido con finales de línea normalizados a \n. Si el archivo '
  'cambia después de aplicarse, el runner lo detecta y frena.';
comment on column ops.schema_migrations.applied_by is
  'session_user de la conexión que la aplicó.';

revoke all on table ops.schema_migrations from public;
revoke all on table ops.schema_migrations from anon, authenticated;
grant select, insert, update, delete on table ops.schema_migrations to service_role;

-- Defensa en profundidad: si algún día `ops` se expusiera por error, RLS deja
-- afuera a cualquiera que no sea service_role. El dueño (postgres, que es quien
-- corre el runner) no queda afectado: no se usa `force row level security`.
alter table ops.schema_migrations enable row level security;

-- La policy explícita NO es decorativa. Sin ella, una lectura hecha como
-- service_role no da "permission denied": devuelve CERO FILAS, en silencio. Un
-- ledger vacío es indistinguible de "no hay nada aplicado", y eso lleva al runner
-- a re-aplicar 0001 sobre una base que ya lo tiene. Un error ruidoso es preferible
-- a un ledger que miente, pero una policy correcta es mejor que las dos cosas.
drop policy if exists schema_migrations_service on ops.schema_migrations;
create policy schema_migrations_service on ops.schema_migrations
  to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Autoverificación
-- ---------------------------------------------------------------------------
do $$
begin
  if has_schema_privilege('anon', 'ops', 'USAGE')
     or has_schema_privilege('authenticated', 'ops', 'USAGE') then
    raise exception 'El schema ops quedó accesible para anon/authenticated';
  end if;
  raise notice '0028 OK: ops.schema_migrations creada y cerrada a la API';
end $$;

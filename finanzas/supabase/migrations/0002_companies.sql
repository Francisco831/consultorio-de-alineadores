-- 0002: las dos empresas y el aislamiento como PRIMERA pieza del schema.
-- Toda tabla de negocio lleva company_id NOT NULL desde su creación; acá nacen
-- las membresías y los helpers que usan todas las policies.

create table companies (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug in ('mx', 'ar')),
  name       text not null,
  country    char(2) not null,
  timezone   text not null,
  -- Monedas operativas. NUNCA se convierten ni suman entre sí: todo total de la
  -- app es un bucket por moneda.
  currencies char(3)[] not null,
  -- razón social, CUIT/RFC, pto_vta, etc. Atributos, no identidad.
  legal      jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table memberships (
  user_id    uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references companies (id),
  role       membership_role not null,
  created_at timestamptz not null default now(),
  primary key (user_id, company_id)
);

-- ---------- helpers RLS ----------
-- Schema aparte para que PostgREST no los exponga como RPC.
create schema if not exists private;
revoke all on schema private from public;
revoke usage on schema private from anon, authenticated;
-- authenticated SÍ necesita USAGE: movements_guard() (security invoker) llama
-- private.is_system() desde plpgsql, que resuelve el nombre EN RUNTIME con el
-- rol del que ejecuta el DML (las policies no lo necesitan: CREATE POLICY guarda
-- el árbol parseado con OIDs). Sin esto, cualquier UPDATE de movements —incluido
-- void_movement() y el ON CONFLICT DO UPDATE de los re-imports— muere con 42501.
grant usage on schema private to authenticated, service_role;

-- security definer: memberships tiene RLS y el usuario solo ve las suyas; estas
-- funciones las leen por debajo. STABLE para que el planner las evalúe una vez
-- por statement (initplan), no por fila.
create or replace function private.member_companies()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select company_id from public.memberships where user_id = auth.uid()
$$;

create or replace function private.has_role(cid uuid, roles text[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid()
      and company_id = cid
      and role::text = any (roles)
  )
$$;

-- "sistema" = service role / cron / seeds (sin sesión de usuario)
create or replace function private.is_system()
returns boolean
language sql stable set search_path = ''
as $$
  select auth.uid() is null
$$;

-- Las policies las llaman por dentro; el cliente no las invoca nunca.
grant execute on function private.member_companies() to authenticated;
grant execute on function private.has_role(uuid, text[]) to authenticated;
grant execute on function private.is_system() to authenticated;

-- ---------- updated_at genérico ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

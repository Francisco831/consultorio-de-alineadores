-- 0003: cuentas financieras, categorías y contrapartes.
-- Patrón de aislamiento físico: cada tabla expone unique (id, company_id) para
-- que las hijas la referencien con FK compuesta — mezclar empresas viola FK
-- aunque RLS y la app fallen a la vez.

create table accounts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies (id),
  name              text not null,
  type              text not null check (type in ('bank', 'mercadopago', 'cash', 'external')),
  currency          char(3) not null,
  bank_name         text,
  -- false para cuentas que se registran pero no suman a la disponibilidad
  -- (ej: "Coni – cuenta propia": cobra aparte, no es caja del consultorio).
  include_in_totals boolean not null default true,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, name),
  unique (id, company_id),   -- ancla para FKs compuestas
  unique (id, currency)      -- ancla para "la moneda del movimiento = la de la cuenta"
);

create trigger accounts_updated_at
  before update on accounts
  for each row execute function set_updated_at();

create table categories (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies (id),
  parent_id     uuid,
  name          text not null,
  flow          text not null check (flow in ('income', 'expense')),
  -- fijo/variable para el modelo de costos AR (Etapa 3); null = sin clasificar
  cost_behavior text check (cost_behavior in ('fixed', 'variable')),
  -- 'produccion_mx' etiqueta las categorías que entran al costo por alineador
  cost_center   text,
  -- semillas no borrables ("Sin categoría", "Liquidaciones profesionales")
  is_system     boolean not null default false,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique nulls not distinct (company_id, parent_id, name),
  unique (id, company_id),
  foreign key (parent_id, company_id) references categories (id, company_id)
);

create trigger categories_updated_at
  before update on categories
  for each row execute function set_updated_at();

create table counterparties (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id),
  kind         text not null check (kind in (
    'patient', 'doctor_customer', 'supplier', 'professional',
    'employee', 'tax_agency', 'other'
  )),
  display_name text not null,
  tax_id       text,     -- CUIT/CUIL/DNI (AR) · RFC (MX)
  contact      jsonb not null default '{}',
  notes        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, company_id)
);

create trigger counterparties_updated_at
  before update on counterparties
  for each row execute function set_updated_at();

-- Búsqueda global y prefiltro fuzzy del matcher.
create index counterparties_name_trgm
  on counterparties using gin (display_name gin_trgm_ops);
create index counterparties_company_idx
  on counterparties (company_id, kind) where is_active;

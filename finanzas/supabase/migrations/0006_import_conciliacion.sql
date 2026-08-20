-- 0006: pipeline de importación y conciliación bancaria.
-- Las líneas de extracto SIEMPRE se guardan crudas (raw jsonb) aunque el parseo
-- falle. El estado de conciliación vive en la LÍNEA, no en el movimiento: un
-- movimiento manual sin extracto no está "sin conciliar" — es la línea del banco
-- la que está pendiente. El extracto CONFIRMA movimientos, no los duplica.

create table import_batches (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id),
  account_id   uuid not null,
  source       text not null check (source in (
    'bbva', 'macro', 'mp_mx', 'mp_ar', 'caja', 'csv', 'xlsx', 'seed'
  )),
  filename     text,
  -- re-subir el mismo archivo se detecta al toque
  file_sha256  text,
  period_from  date,
  period_to    date,
  status       text not null default 'processing'
    check (status in ('processing', 'done', 'failed')),
  stats        jsonb not null default '{}',
  created_by   uuid,
  created_at   timestamptz not null default now(),
  foreign key (account_id, company_id) references accounts (id, company_id),
  unique (company_id, account_id, file_sha256),
  unique (id, company_id)
);

create table statement_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id),
  batch_id        uuid not null,
  account_id      uuid not null,
  line_no         int not null,
  posted_on       date not null,
  description_raw text not null default '',
  counterparty_raw text,
  -- FIRMADO como viene del banco: crédito positivo, débito negativo
  amount          numeric(14,2) not null,
  balance_after   numeric(14,2),
  currency        char(3) not null,
  -- hash(cuenta, fecha, monto, descripción, ordinal intra-día): dos consultas de
  -- $30.000 el mismo día son líneas legítimas distintas → el ordinal desambigua
  external_key    text not null,
  match_status    statement_line_status not null default 'pending',
  matched_movement_id uuid,
  match_score     numeric(4,3),
  match_method    text,
  raw             jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (batch_id, company_id)   references import_batches (id, company_id),
  foreign key (account_id, company_id) references accounts (id, company_id),
  foreign key (matched_movement_id, company_id) references movements (id, company_id),
  unique (company_id, account_id, external_key),
  unique (id, company_id)
);

create index statement_lines_status_idx
  on statement_lines (company_id, account_id, match_status);
create index statement_lines_date_idx
  on statement_lines (company_id, posted_on);

create trigger statement_lines_updated_at
  before update on statement_lines
  for each row execute function set_updated_at();

-- Vínculo confirmado línea ↔ movimiento(s). Una línea puede cerrar contra
-- varios movimientos (agrupados); un movimiento contra varias líneas, no (MVP).
create table reconciliations (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies (id),
  statement_line_id uuid not null,
  movement_id       uuid not null,
  amount            numeric(14,2) not null,
  matched_by        text not null check (matched_by in ('auto', 'rule', 'user')),
  confidence        numeric(4,3),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  foreign key (statement_line_id, company_id) references statement_lines (id, company_id),
  foreign key (movement_id, company_id)       references movements (id, company_id),
  -- una línea puede cerrar contra VARIOS movimientos (cobro MP agrupado =
  -- 2-3 cuotas de la planilla); el par no se repite
  unique (statement_line_id, movement_id)
);

create index reconciliations_movement_idx on reconciliations (movement_id);

-- Sugerencias del matcher (varias por línea, elige el humano).
create table match_suggestions (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies (id),
  statement_line_id uuid not null,
  movement_id       uuid not null,
  score             numeric(4,3) not null,
  method            text not null check (method in (
    'external_key', 'nombre_monto_fecha', 'agrupado', 'monto_unico', 'sobrante_mutuo'
  )),
  detail            jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  foreign key (statement_line_id, company_id) references statement_lines (id, company_id),
  foreign key (movement_id, company_id)       references movements (id, company_id),
  unique (statement_line_id, movement_id)
);

-- Normalización de medios de pago: 31 variantes reales → 4 canónicos.
-- raw_norm = lower + sin acentos + trim (la normalización la hace la app).
create table payment_method_aliases (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  raw_norm   text not null,
  account_id uuid not null,
  foreign key (account_id, company_id) references accounts (id, company_id),
  unique (company_id, raw_norm)
);

-- Mapeos de columnas del importador genérico, reutilizables por cuenta.
create table import_templates (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  account_id uuid,
  name       text not null,
  column_map jsonb not null,
  options    jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (account_id, company_id) references accounts (id, company_id),
  unique (company_id, name)
);

-- Transferencias internas aprendidas (MP→banco no es ingreso ni gasto):
-- la primera vez se confirma a mano, después el patrón auto-sugiere.
create table transfer_rules (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id),
  from_account uuid not null,
  to_account   uuid not null,
  pattern      jsonb not null default '{}',
  auto_confirm boolean not null default false,
  created_at   timestamptz not null default now(),
  foreign key (from_account, company_id) references accounts (id, company_id),
  foreign key (to_account, company_id)   references accounts (id, company_id)
);

-- Registro de corridas de sync/imports (forma heredada del CRM).
create table sync_runs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies (id),
  source        text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  rows_read     int,
  rows_upserted int,
  watermark     timestamptz,
  status        text not null default 'running'
    check (status in ('running', 'ok', 'error')),
  log           jsonb
);

-- ---------- RPC: anular movimiento ----------
-- void con dependencias exige desarmar primero: si está conciliado, primero se
-- desconcilia (auditado); una transferencia se anula entera (las dos patas).
create or replace function void_movement(p_movement_id uuid)
returns void
language plpgsql
as $$
declare
  v_mov movements%rowtype;
begin
  select * into v_mov from movements where id = p_movement_id;
  if not found then
    raise exception 'movimiento inexistente';
  end if;
  if v_mov.status = 'void' then
    return;
  end if;
  if exists (select 1 from reconciliations where movement_id = p_movement_id) then
    raise exception 'movimiento conciliado: primero hay que desconciliarlo';
  end if;
  if v_mov.transfer_group_id is not null then
    if exists (
      select 1 from reconciliations r
      join movements m on m.id = r.movement_id
      where m.transfer_group_id = v_mov.transfer_group_id
    ) then
      raise exception 'transferencia conciliada: primero hay que desconciliarla';
    end if;
    update movements set status = 'void'
     where transfer_group_id = v_mov.transfer_group_id and status <> 'void';
  else
    update movements set status = 'void' where id = p_movement_id;
  end if;
end $$;

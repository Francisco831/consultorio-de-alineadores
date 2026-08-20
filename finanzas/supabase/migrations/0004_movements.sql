-- 0004: movements — el ledger único. La plata solo entra y sale por acá.
-- Los módulos (CxC, CxP, compras, sueldos, liquidaciones) GENERAN o APLICAN
-- movements; jamás guardan montos "pagados" propios (principio #39 del spec).

create table movements (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies (id),
  account_id        uuid not null,
  currency          char(3) not null,
  kind              movement_kind not null,
  status            movement_status not null default 'confirmed',
  -- fecha de negocio en la TZ de la empresa; los timestamps de sistema van aparte
  occurred_on       date not null,
  amount            numeric(14,2) not null check (amount > 0),
  signed_amount     numeric(14,2) generated always as (
    case when kind in ('income', 'transfer_in') then amount else -amount end
  ) stored,
  category_id       uuid,
  counterparty_id   uuid,
  description       text,
  -- ambas patas de una transferencia interna lo comparten; solo via create_transfer
  transfer_group_id uuid,
  source            text not null default 'manual' check (source in (
    'manual', 'import', 'seed', 'crm_sync', 'payable', 'receivable',
    'settlement', 'payroll'
  )),
  -- idempotencia de imports/sync: basado en CONTENIDO, nunca en índice de fila
  external_key      text,
  -- crudos del origen: {tab, atribucion_clara, motivo, fc, ...}
  meta              jsonb not null default '{}',
  created_by        uuid references auth.users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- aislamiento físico + coherencia de moneda. Nombres EXPLÍCITOS: hay dos FKs
  -- movements→accounts y PostgREST necesita el hint (accounts!movements_account_company_fk)
  -- para desambiguar el embed — sin nombre estable, el embed es ambiguo (PGRST201).
  constraint movements_account_company_fk
    foreign key (account_id, company_id)    references accounts (id, company_id),
  constraint movements_account_currency_fk
    foreign key (account_id, currency)      references accounts (id, currency),
  foreign key (category_id, company_id)     references categories (id, company_id),
  foreign key (counterparty_id, company_id) references counterparties (id, company_id),

  -- transferencia ⇔ grupo; el resto no lleva grupo
  check ((kind in ('transfer_in', 'transfer_out')) = (transfer_group_id is not null)),

  unique (company_id, external_key),
  unique (id, company_id)
);

create index movements_account_idx
  on movements (account_id, occurred_on desc) where status <> 'void';
create index movements_report_idx
  on movements (company_id, occurred_on desc, kind) where status <> 'void';
create index movements_category_idx
  on movements (company_id, category_id, occurred_on);
create index movements_transfer_idx
  on movements (transfer_group_id) where transfer_group_id is not null;

create trigger movements_updated_at
  before update on movements
  for each row execute function set_updated_at();

-- ---------- integridad de transferencias ----------
-- Constraint trigger DIFERIDO: al commit, cada transfer_group_id debe cerrar con
-- exactamente una pata out y una in, de la misma empresa, no-void (o ambas void).
create or replace function check_transfer_group()
returns trigger
language plpgsql
as $$
declare
  v_group uuid;
  v_out int;
  v_in int;
  v_void int;
  v_total int;
  v_companies int;
begin
  v_group := coalesce(new.transfer_group_id, old.transfer_group_id);
  if v_group is null then
    return null;
  end if;

  select count(*) filter (where kind = 'transfer_out' and status <> 'void'),
         count(*) filter (where kind = 'transfer_in'  and status <> 'void'),
         count(*) filter (where status = 'void'),
         count(*),
         count(distinct company_id)
    into v_out, v_in, v_void, v_total, v_companies
    from movements
   where transfer_group_id = v_group;

  if v_total = 0 then
    return null; -- el grupo entero se borró en esta transacción (no debería pasar)
  end if;
  if v_companies > 1 then
    raise exception 'transferencia % cruza empresas', v_group;
  end if;
  if v_void = v_total then
    return null; -- transferencia anulada entera: ok
  end if;
  if v_out <> 1 or v_in <> 1 then
    raise exception
      'transferencia % incompleta: % salida(s) y % entrada(s) activas — usar create_transfer()',
      v_group, v_out, v_in;
  end if;
  return null;
end $$;

create constraint trigger movements_transfer_check
  after insert or update or delete on movements
  deferrable initially deferred
  for each row execute function check_transfer_group();

-- ---------- RPC: transferencia interna ----------
-- Única vía para crear transferencias. Dos patas en una transacción; permite
-- montos distintos por pata (venta de USD: sale USD, entra ARS — cada una con su
-- monto explícito; PROHIBIDO inventar un tipo de cambio).
create or replace function create_transfer(
  p_company_id  uuid,
  p_from_account uuid,
  p_to_account   uuid,
  p_amount_out   numeric,
  p_amount_in    numeric,
  p_date         date,
  p_description  text default null,
  p_status       movement_status default 'confirmed'
) returns uuid
language plpgsql
-- security invoker: RLS de movements decide si este usuario puede escribir acá
as $$
declare
  v_group uuid := gen_random_uuid();
  v_from_currency char(3);
  v_to_currency   char(3);
begin
  if p_from_account = p_to_account then
    raise exception 'la cuenta de origen y destino son la misma';
  end if;
  if p_amount_out <= 0 or p_amount_in <= 0 then
    raise exception 'los montos deben ser positivos';
  end if;
  if p_status = 'void' then
    raise exception 'una transferencia no puede nacer anulada';
  end if;

  select currency into v_from_currency from accounts
   where id = p_from_account and company_id = p_company_id;
  select currency into v_to_currency from accounts
   where id = p_to_account and company_id = p_company_id;
  if v_from_currency is null or v_to_currency is null then
    raise exception 'cuenta inexistente o de otra empresa';
  end if;
  if v_from_currency = v_to_currency and p_amount_out <> p_amount_in then
    raise exception 'misma moneda: el monto de salida y entrada deben coincidir';
  end if;

  insert into movements (company_id, account_id, currency, kind, status, occurred_on,
                         amount, description, transfer_group_id, created_by)
  values (p_company_id, p_from_account, v_from_currency, 'transfer_out', p_status,
          p_date, p_amount_out, p_description, v_group, auth.uid());

  insert into movements (company_id, account_id, currency, kind, status, occurred_on,
                         amount, description, transfer_group_id, created_by)
  values (p_company_id, p_to_account, v_to_currency, 'transfer_in', p_status,
          p_date, p_amount_in, p_description, v_group, auth.uid());

  return v_group;
end $$;

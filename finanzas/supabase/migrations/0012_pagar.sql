-- 0012: cuentas por pagar, pagos recurrentes e impuestos.
--
-- TODO lo pagable converge en `payables`: una CxP manual, una obligación fiscal,
-- una liquidación de sueldos, una liquidación de doctora o una compra a crédito
-- son la MISMA fila con distinto `source`. Un solo lugar donde mirar qué se debe,
-- un solo RPC que paga y genera el egreso — el principio #39 aplicado.

create table recurring_rules (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id),
  name            text not null,
  counterparty_id uuid,
  category_id     uuid,
  currency        char(3) not null,
  amount_estimated numeric(14,2),
  frequency       text not null check (frequency in ('weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'yearly')),
  due_day         int check (due_day between 1 and 31),
  next_due_on     date not null,
  active          boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (counterparty_id, company_id) references counterparties (id, company_id),
  foreign key (category_id, company_id)     references categories (id, company_id),
  unique (company_id, name),
  unique (id, company_id)
);

create trigger recurring_rules_updated_at
  before update on recurring_rules for each row execute function set_updated_at();

create table taxes (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id),
  name         text not null,
  jurisdiction text not null,
  frequency    text,
  notes        text,
  active       boolean not null default true,
  unique (company_id, name, jurisdiction),
  unique (id, company_id)
);

create table payables (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id),
  counterparty_id uuid,
  category_id     uuid,
  source          text not null default 'manual'
    check (source in ('manual', 'recurring', 'tax', 'payroll', 'purchase', 'settlement')),
  -- id de la obligación/corrida/compra que la generó: una obligación, UNA payable
  source_id       uuid,
  concept         text not null,
  currency        char(3) not null,
  amount          numeric(14,2) not null check (amount > 0),
  due_on          date not null,
  status          text not null default 'open'
    check (status in ('open', 'partially_paid', 'paid', 'void')),
  notes           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (counterparty_id, company_id) references counterparties (id, company_id),
  foreign key (category_id, company_id)     references categories (id, company_id),
  unique (company_id, source, source_id),
  unique (id, company_id)
);

create trigger payables_updated_at
  before update on payables for each row execute function set_updated_at();
create index payables_open_idx on payables (company_id, due_on) where status <> 'paid' and status <> 'void';

create table payable_payments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id),
  payable_id  uuid not null,
  movement_id uuid not null,
  amount      numeric(14,2) not null check (amount > 0),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  foreign key (payable_id, company_id)  references payables (id, company_id),
  foreign key (movement_id, company_id) references movements (id, company_id),
  unique (payable_id, movement_id)
);

create index payable_payments_mov_idx on payable_payments (movement_id);

create table tax_obligations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies (id),
  tax_id           uuid not null,
  period           text not null,           -- '2026-08'
  due_on           date not null,
  amount_estimated numeric(14,2),
  amount_final     numeric(14,2),
  status           text not null default 'estimated'
    check (status in ('estimated', 'final', 'paid', 'void')),
  payable_id       uuid,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tax_id, company_id)     references taxes (id, company_id),
  foreign key (payable_id, company_id) references payables (id, company_id),
  unique (company_id, tax_id, period),
  unique (id, company_id)
);

create trigger tax_obligations_updated_at
  before update on tax_obligations for each row execute function set_updated_at();

-- Estado de la deuda derivado de lo pagado. Nadie escribe status a mano.
create or replace function refresh_payable_status(p_payable uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_amount numeric(14,2);
  v_pagado numeric(14,2);
  v_status text;
begin
  select amount, status into v_amount, v_status from payables where id = p_payable;
  if v_status = 'void' then return; end if;
  select coalesce(sum(amount), 0) into v_pagado
    from payable_payments where payable_id = p_payable;
  update payables
     set status = case
       when v_pagado >= v_amount - 0.01 then 'paid'
       when v_pagado > 0 then 'partially_paid'
       else 'open' end
   where id = p_payable;
  -- la obligación fiscal sigue a su payable
  update tax_obligations t
     set status = case when v_pagado >= v_amount - 0.01 then 'paid' else t.status end
   where t.payable_id = p_payable and t.status <> 'void';
end $$;

create or replace function payable_payments_touch()
returns trigger language plpgsql as $$
begin
  perform refresh_payable_status(coalesce(new.payable_id, old.payable_id));
  return null;
end $$;

create trigger payable_payments_trg
  after insert or update or delete on payable_payments
  for each row execute function payable_payments_touch();

-- EL RPC de pago: marcar pagado GENERA el egreso. No hay otra forma de pagar,
-- así que es imposible que un pago exista sin impactar una cuenta.
create or replace function pay_payable(
  p_payable_id uuid,
  p_account_id uuid,
  p_amount     numeric,
  p_date       date,
  p_description text default null
) returns uuid
language plpgsql
as $$
declare
  v_p payables%rowtype;
  v_currency char(3);
  v_movement uuid;
  v_pagado numeric(14,2);
begin
  select * into v_p from payables where id = p_payable_id;
  if not found then raise exception 'la deuda no existe'; end if;
  if v_p.status = 'void' then raise exception 'la deuda está anulada'; end if;
  if p_amount <= 0 then raise exception 'el monto debe ser positivo'; end if;

  select coalesce(sum(amount), 0) into v_pagado from payable_payments where payable_id = p_payable_id;
  if v_pagado + p_amount > v_p.amount + 0.01 then
    raise exception 'el pago excede el saldo: debe % y ya pagaste %', v_p.amount, v_pagado;
  end if;

  select currency into v_currency from accounts
   where id = p_account_id and company_id = v_p.company_id;
  if v_currency is null then raise exception 'cuenta inexistente o de otra empresa'; end if;
  if v_currency <> v_p.currency then
    raise exception 'la cuenta es % y la deuda está en %', v_currency, v_p.currency;
  end if;

  insert into movements (company_id, account_id, currency, kind, status, occurred_on,
                         amount, category_id, counterparty_id, description, source, created_by)
  values (v_p.company_id, p_account_id, v_currency, 'expense', 'confirmed', p_date,
          p_amount, v_p.category_id, v_p.counterparty_id,
          coalesce(p_description, v_p.concept), 'payable', auth.uid())
  returning id into v_movement;

  insert into payable_payments (company_id, payable_id, movement_id, amount, created_by)
  values (v_p.company_id, p_payable_id, v_movement, p_amount, auth.uid());

  return v_movement;
end $$;

-- Los buckets del spec (Hoy / esta semana / 15 / 30 / vencidos), derivados.
create view v_payables_buckets
  with (security_invoker = on) as
select p.company_id,
       p.id,
       p.concept,
       p.source,
       p.counterparty_id,
       cp.display_name as counterparty_name,
       c.name as category_name,
       p.currency,
       p.amount,
       coalesce(sum(pp.amount), 0)::numeric(14,2) as paid,
       (p.amount - coalesce(sum(pp.amount), 0))::numeric(14,2) as balance,
       p.due_on,
       p.status,
       case
         when p.due_on < current_date then 'vencido'
         when p.due_on = current_date then 'hoy'
         when p.due_on <= current_date + 7 then 'semana'
         when p.due_on <= current_date + 15 then 'd15'
         when p.due_on <= current_date + 30 then 'd30'
         else 'despues'
       end as bucket,
       (p.due_on - current_date) as days_to_due
from payables p
left join counterparties cp on cp.id = p.counterparty_id
left join categories c on c.id = p.category_id
left join payable_payments pp on pp.payable_id = p.id
where p.status not in ('paid', 'void')
group by p.id, cp.display_name, c.name;

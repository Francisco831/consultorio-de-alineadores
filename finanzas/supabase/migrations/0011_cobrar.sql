-- 0011: cuentas por cobrar — pacientes, planes de tratamiento, cuotas.
--
-- POR QUÉ ESTE MÓDULO NACE VACÍO. El histórico 2026 arranca el 1/1, y el 89% de
-- los cobros no dice a qué plan pertenece ("Enero", "Contenciones"). Del 9% que
-- sí ("cuota 5 de 6"), no se puede saber si las cuotas anteriores se pagaron en
-- 2025 —fuera del dataset— o están impagas: inferirlo fabricaría deuda que no
-- existe. Así que la estructura se crea, pero las cuentas por cobrar se cargan
-- con datos ciertos. Lo detectado en el histórico se ofrece como SUGERENCIA para
-- que un humano confirme (ver scripts/sugerir-planes.ts), nunca como saldo.

create table patients (
  counterparty_id uuid primary key,
  company_id      uuid not null,
  professional_id uuid,
  dni             text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (counterparty_id, company_id) references counterparties (id, company_id),
  foreign key (professional_id, company_id) references counterparties (id, company_id),
  unique (counterparty_id, company_id)
);

create trigger patients_updated_at
  before update on patients for each row execute function set_updated_at();

create table treatment_plans (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies (id),
  patient_id         uuid not null,
  professional_id    uuid,
  kind               text not null check (kind in ('alineadores', 'mensualidad', 'contencion', 'otro')),
  -- clave de la lista de precios KS: {audience, scope, arcades}
  ks_price_key       jsonb,
  currency           char(3) not null,
  total_amount       numeric(14,2),
  installments_total int check (installments_total > 0),
  -- (lista − descuento) / cuotas, CONGELADO al crear: si mañana cambia la lista,
  -- los planes viejos no se mueven
  ks_unit_cost       numeric(14,2),
  -- las etapas adicionales están incluidas en el programa 1 a 4: no cargan costo
  is_additional_stage boolean not null default false,
  status             text not null default 'active' check (status in ('active', 'finished', 'cancelled')),
  started_on         date,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (patient_id, company_id)      references counterparties (id, company_id),
  foreign key (professional_id, company_id) references counterparties (id, company_id),
  unique (id, company_id)
);

create trigger treatment_plans_updated_at
  before update on treatment_plans for each row execute function set_updated_at();
create index treatment_plans_patient_idx on treatment_plans (company_id, patient_id);

-- LA tabla del aging. Sirve para las cuotas del consultorio y para los doctores
-- deudores de México: la misma query de vencimientos para las dos empresas.
create table receivables (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id),
  counterparty_id uuid not null,
  plan_id         uuid,
  installment_no  int,
  concept         text not null,
  currency        char(3) not null,
  amount          numeric(14,2) not null check (amount > 0),
  due_on          date,
  -- OJO: "vencido" NO es un estado guardado — es due_on < hoy. Un estado que
  -- cambia solo con el paso del tiempo miente hasta que alguien corra un cron.
  status          text not null default 'open'
    check (status in ('open', 'partially_paid', 'paid', 'void')),
  notes           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (counterparty_id, company_id) references counterparties (id, company_id),
  foreign key (plan_id, company_id)         references treatment_plans (id, company_id),
  unique (company_id, plan_id, installment_no),
  unique (id, company_id)
);

create trigger receivables_updated_at
  before update on receivables for each row execute function set_updated_at();
create index receivables_open_idx on receivables (company_id, due_on) where status <> 'paid' and status <> 'void';

-- Aplicación de cobros a deudas: N movimientos ↔ N cuotas (pagos parciales,
-- y un solo cobro que salda dos cuotas).
create table receivable_applications (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies (id),
  receivable_id  uuid not null,
  movement_id    uuid not null,
  amount         numeric(14,2) not null check (amount > 0),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  foreign key (receivable_id, company_id) references receivables (id, company_id),
  foreign key (movement_id, company_id)   references movements (id, company_id),
  unique (receivable_id, movement_id)
);

create index receivable_applications_mov_idx on receivable_applications (movement_id);

-- Recalcula el estado de la cuota desde lo aplicado. Nadie escribe status a mano.
create or replace function refresh_receivable_status(p_receivable uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_amount numeric(14,2);
  v_aplicado numeric(14,2);
  v_status text;
begin
  select amount, status into v_amount, v_status from receivables where id = p_receivable;
  if v_status = 'void' then return; end if;
  select coalesce(sum(amount), 0) into v_aplicado
    from receivable_applications where receivable_id = p_receivable;
  update receivables
     set status = case
       when v_aplicado >= v_amount - 0.01 then 'paid'
       when v_aplicado > 0 then 'partially_paid'
       else 'open' end
   where id = p_receivable;
end $$;

create or replace function receivable_applications_touch()
returns trigger language plpgsql as $$
begin
  perform refresh_receivable_status(coalesce(new.receivable_id, old.receivable_id));
  return null;
end $$;

create trigger receivable_applications_trg
  after insert or update or delete on receivable_applications
  for each row execute function receivable_applications_touch();

-- RPC: registrar un cobro y aplicarlo a una cuota, en UNA transacción.
create or replace function collect_receivable(
  p_receivable_id uuid,
  p_account_id    uuid,
  p_amount        numeric,
  p_date          date,
  p_description   text default null
) returns uuid
language plpgsql
as $$
declare
  v_r receivables%rowtype;
  v_currency char(3);
  v_movement uuid;
begin
  select * into v_r from receivables where id = p_receivable_id;
  if not found then raise exception 'la deuda no existe'; end if;
  if v_r.status = 'void' then raise exception 'la deuda está anulada'; end if;
  if p_amount <= 0 then raise exception 'el monto debe ser positivo'; end if;

  select currency into v_currency from accounts
   where id = p_account_id and company_id = v_r.company_id;
  if v_currency is null then raise exception 'cuenta inexistente o de otra empresa'; end if;
  if v_currency <> v_r.currency then
    raise exception 'la cuenta es % y la deuda está en %', v_currency, v_r.currency;
  end if;

  insert into movements (company_id, account_id, currency, kind, status, occurred_on,
                         amount, counterparty_id, description, source, created_by)
  values (v_r.company_id, p_account_id, v_currency, 'income', 'confirmed', p_date,
          p_amount, v_r.counterparty_id,
          coalesce(p_description, v_r.concept), 'receivable', auth.uid())
  returning id into v_movement;

  insert into receivable_applications (company_id, receivable_id, movement_id, amount, created_by)
  values (v_r.company_id, p_receivable_id, v_movement, p_amount, auth.uid());

  return v_movement;
end $$;

-- Aging: los tramos del spec, derivados de due_on. Sin cron, sin estados que mientan.
create view v_receivables_aging
  with (security_invoker = on) as
select r.company_id,
       r.id,
       r.counterparty_id,
       cp.display_name as counterparty_name,
       r.plan_id,
       r.installment_no,
       r.concept,
       r.currency,
       r.amount,
       coalesce(sum(ra.amount), 0)::numeric(14,2) as paid,
       (r.amount - coalesce(sum(ra.amount), 0))::numeric(14,2) as balance,
       r.due_on,
       r.status,
       case
         when r.due_on is null then 'sin_fecha'
         when r.due_on >= current_date then 'a_vencer'
         when current_date - r.due_on <= 7 then 'd1_7'
         when current_date - r.due_on <= 15 then 'd8_15'
         when current_date - r.due_on <= 30 then 'd16_30'
         when current_date - r.due_on <= 60 then 'd31_60'
         else 'd60_mas'
       end as bucket,
       greatest(current_date - r.due_on, 0) as days_overdue
from receivables r
join counterparties cp on cp.id = r.counterparty_id
left join receivable_applications ra on ra.receivable_id = r.id
where r.status not in ('paid', 'void')
group by r.id, cp.display_name;

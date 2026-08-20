-- 0013: sueldos y liquidaciones profesionales — DOS COSAS DISTINTAS.
--
-- Las empleadas están en relación de dependencia: se liquidan por bruto,
-- aportes y contribuciones, y lo que le cuesta a la empresa (costo laboral) no
-- es lo que cobra la persona (neto). Las doctoras NO son empleadas: cobran un
-- porcentaje de lo que facturaron, neto de los costos del tratamiento. Meterlas
-- en la misma tabla obligaría a que una de las dos mienta.

-- ---------- nómina ----------
create table employees (
  counterparty_id uuid primary key,
  company_id      uuid not null,
  national_id     text,                     -- CUIL (AR) · RFC/NSS (MX)
  hired_on        date,
  position        text,
  base_salary     numeric(14,2),
  currency        char(3),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (counterparty_id, company_id) references counterparties (id, company_id),
  unique (counterparty_id, company_id)
);

create trigger employees_updated_at
  before update on employees for each row execute function set_updated_at();

create table payroll_runs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id),
  period      text not null,                -- '2026-03'
  status      text not null default 'draft'
    check (status in ('draft', 'confirmed', 'paid', 'void')),
  payable_id  uuid,                         -- se crea al confirmar
  notes       text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, period),
  unique (id, company_id)
);

create trigger payroll_runs_updated_at
  before update on payroll_runs for each row execute function set_updated_at();

create table payroll_items (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references companies (id),
  run_id                 uuid not null,
  employee_id            uuid not null,
  currency               char(3) not null,
  gross                  numeric(14,2) not null default 0,   -- remunerativo
  deductions             numeric(14,2) not null default 0,   -- aportes del empleado
  net                    numeric(14,2) not null default 0,   -- lo que cobra
  employer_contributions numeric(14,2) not null default 0,   -- contribuciones patronales
  -- LO QUE LE CUESTA A LA EMPRESA ≠ lo que cobra la empleada
  total_cost             numeric(14,2) generated always as
                           (net + deductions + employer_contributions) stored,
  detail                 jsonb not null default '{}',        -- el recibo, concepto por concepto
  foreign key (run_id, company_id)      references payroll_runs (id, company_id),
  foreign key (employee_id, company_id) references counterparties (id, company_id),
  unique (run_id, employee_id)
);

-- ---------- liquidaciones profesionales (las doctoras) ----------
create table professionals (
  counterparty_id     uuid primary key,
  company_id          uuid not null,
  settlement_pct      numeric(5,2) not null default 40.00,
  -- Coni cobra a cuenta propia: se registra, no entra en liquidación ni totales
  settles_separately  boolean not null default false,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (counterparty_id, company_id) references counterparties (id, company_id),
  unique (counterparty_id, company_id)
);

create trigger professionals_updated_at
  before update on professionals for each row execute function set_updated_at();

-- Lista de precios KeepSmiling, versionada por fecha: el costo del tratamiento
-- es (lista − descuento) y se prorratea por cuota.
create table ks_price_list (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id),
  audience     text not null check (audience in ('adultos', 'teens', 'kids')),
  scope        text not null check (scope in ('full', 'medium', 'fast')),
  arcades      int not null check (arcades in (1, 2)),
  list_price   numeric(14,2) not null,
  currency     char(3) not null default 'ARS',
  discount_pct numeric(5,2) not null default 40.00,
  valid_from   date not null,
  unique (company_id, audience, scope, arcades, valid_from)
);

create table professional_settlements (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id),
  professional_id uuid not null,
  period          text not null,            -- '2026-07'
  status          text not null default 'draft'
    check (status in ('draft', 'confirmed', 'paid', 'void')),
  -- el % se CONGELA al confirmar: si mañana cambia, las liquidaciones viejas no se mueven
  pct             numeric(5,2) not null,
  -- por moneda: {ARS: {collected, ks_cost, expenses, base, due}, USD: {...}}
  totals          jsonb not null default '{}',
  payable_id      uuid,
  notes           text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (professional_id, company_id) references counterparties (id, company_id),
  foreign key (payable_id, company_id)      references payables (id, company_id),
  unique (company_id, professional_id, period),
  unique (id, company_id)
);

create trigger professional_settlements_updated_at
  before update on professional_settlements for each row execute function set_updated_at();

-- Qué cobros entraron en la liquidación y con qué costo se imputaron.
-- Un cobro se liquida UNA sola vez: lo garantiza el unique, no la memoria de un script.
create table settlement_items (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies (id),
  settlement_id uuid not null,
  movement_id   uuid not null,
  base_amount   numeric(14,2) not null,                   -- lo cobrado
  ks_cost       numeric(14,2) not null default 0,         -- prorrateo de la lista KS
  currency      char(3) not null,
  label         text,                                     -- "cuota 3 de 6 · Full 2 maxilares"
  foreign key (settlement_id, company_id) references professional_settlements (id, company_id),
  foreign key (movement_id, company_id)   references movements (id, company_id),
  unique (settlement_id, movement_id),
  unique (company_id, movement_id)   -- ← el cobro no puede liquidarse dos veces
);

create index settlement_items_settlement_idx on settlement_items (settlement_id);

-- Confirmar una liquidación: congela el %, arma el total y GENERA la cuenta a
-- pagar. El retiro real se registra después con pay_payable() como cualquier otro
-- pago, así que la plata sale del ledger una sola vez.
create or replace function confirm_settlement(
  p_settlement_id uuid,
  p_due_on        date default null
) returns uuid
language plpgsql
as $$
declare
  v_s professional_settlements%rowtype;
  v_due numeric(14,2);
  v_currency char(3);
  v_cat uuid;
  v_payable uuid;
begin
  select * into v_s from professional_settlements where id = p_settlement_id;
  if not found then raise exception 'la liquidación no existe'; end if;
  if v_s.status <> 'draft' then raise exception 'la liquidación ya está %', v_s.status; end if;

  -- moneda principal de la empresa para la cuenta a pagar
  select currencies[1] into v_currency from companies where id = v_s.company_id;
  v_due := coalesce((v_s.totals -> v_currency ->> 'due')::numeric, 0);
  if v_due <= 0 then raise exception 'la liquidación no tiene saldo a pagar en %', v_currency; end if;

  select id into v_cat from categories
   where company_id = v_s.company_id and name = 'Liquidaciones profesionales' limit 1;

  insert into payables (company_id, counterparty_id, category_id, source, source_id,
                        concept, currency, amount, due_on, created_by)
  values (v_s.company_id, v_s.professional_id, v_cat, 'settlement', v_s.id,
          'Liquidación ' || v_s.period, v_currency, v_due,
          coalesce(p_due_on, current_date), auth.uid())
  returning id into v_payable;

  update professional_settlements
     set status = 'confirmed', payable_id = v_payable
   where id = p_settlement_id;

  return v_payable;
end $$;

-- 0016: compras con detalle de productos, historial de precios, presupuesto y costos.
--
-- LA IDEA CENTRAL DE ESTE ARCHIVO: registrar QUÉ se compró, no solo cuánto se
-- gastó. "Proveedor Dental X — $800.000" no sirve para negociar; "20 cajas de
-- guantes a $12.000" sí. El historial de precios sale gratis de cargar bien la
-- compra: son vistas sobre las líneas, no una tabla que haya que mantener.

create table products (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id),
  name         text not null,
  brand        text,
  category     text,                    -- insumo clínico, placa, resina, packaging…
  default_unit text,                    -- caja, unidad, kg, litro
  -- inventario (Etapa 4): la estructura queda, el módulo se prende después
  stock_min    numeric(12,3),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, name),
  unique (id, company_id)
);

create trigger products_updated_at
  before update on products for each row execute function set_updated_at();
create index products_name_trgm on products using gin (name gin_trgm_ops);

create table purchases (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id),
  supplier_id  uuid not null,
  purchased_on date not null,
  currency     char(3) not null,
  total        numeric(14,2) not null check (total > 0),
  invoice_no   text,
  -- 'paid' genera el egreso en el acto; 'credit' genera una cuenta por pagar
  settlement   text not null check (settlement in ('paid', 'credit')),
  movement_id  uuid,
  payable_id   uuid,
  notes        text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (supplier_id, company_id) references counterparties (id, company_id),
  foreign key (movement_id, company_id) references movements (id, company_id),
  foreign key (payable_id, company_id)  references payables (id, company_id),
  -- una compra o se pagó (y tiene movimiento) o quedó a crédito (y tiene deuda)
  check ((settlement = 'paid'   and movement_id is not null and payable_id is null)
      or (settlement = 'credit' and payable_id  is not null and movement_id is null)
      or (movement_id is null and payable_id is null)),   -- durante la creación
  unique (id, company_id)
);

create trigger purchases_updated_at
  before update on purchases for each row execute function set_updated_at();
create index purchases_supplier_idx on purchases (company_id, supplier_id, purchased_on desc);

create table purchase_items (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id),
  purchase_id uuid not null,
  product_id  uuid not null,
  brand       text,
  quantity    numeric(12,3) not null check (quantity > 0),
  unit        text not null,
  -- 4 decimales: hay insumos que se miden por gramo o por unidad suelta
  unit_price  numeric(14,4) not null check (unit_price >= 0),
  line_total  numeric(14,2) not null,
  foreign key (purchase_id, company_id) references purchases (id, company_id),
  foreign key (product_id, company_id)  references products (id, company_id)
);

create index purchase_items_product_idx on purchase_items (company_id, product_id);

-- ---------- historial de precios: VISTAS, no tablas ----------
-- Materializarlo obligaría a recalcular con cada compra y a que alguien se
-- acuerde de hacerlo. Con este volumen (decenas de compras por mes) la vista
-- responde al instante y nunca miente.
create view v_product_prices
  with (security_invoker = on) as
select pi.company_id,
       pi.product_id,
       p.name as product_name,
       p.category,
       pu.currency,
       count(*)::int                       as compras,
       sum(pi.quantity)                    as cantidad_total,
       sum(pi.line_total)::numeric(14,2)   as gasto_total,
       min(pi.unit_price)                  as precio_min,
       max(pi.unit_price)                  as precio_max,
       avg(pi.unit_price)::numeric(14,4)   as precio_promedio,
       (array_agg(pi.unit_price order by pu.purchased_on desc))[1] as precio_ultimo,
       max(pu.purchased_on)                as ultima_compra,
       min(pu.purchased_on)                as primera_compra,
       -- variación entre la primera y la última compra
       case
         when (array_agg(pi.unit_price order by pu.purchased_on))[1] > 0 then
           round(((array_agg(pi.unit_price order by pu.purchased_on desc))[1]
                / (array_agg(pi.unit_price order by pu.purchased_on))[1] - 1) * 100, 1)
       end as variacion_pct
from purchase_items pi
join purchases pu on pu.id = pi.purchase_id
join products p on p.id = pi.product_id
group by pi.company_id, pi.product_id, p.name, p.category, pu.currency;

-- El mismo producto a distintos proveedores: la vista que sirve para negociar.
create view v_product_supplier_prices
  with (security_invoker = on) as
select pi.company_id,
       pi.product_id,
       p.name as product_name,
       pu.supplier_id,
       cp.display_name as supplier_name,
       pu.currency,
       count(*)::int as compras,
       (array_agg(pi.unit_price order by pu.purchased_on desc))[1] as precio_ultimo,
       avg(pi.unit_price)::numeric(14,4) as precio_promedio,
       max(pu.purchased_on) as ultima_compra,
       sum(pi.line_total)::numeric(14,2) as gasto_total
from purchase_items pi
join purchases pu on pu.id = pi.purchase_id
join products p on p.id = pi.product_id
join counterparties cp on cp.id = pu.supplier_id
group by pi.company_id, pi.product_id, p.name, pu.supplier_id, cp.display_name, pu.currency;

-- ---------- ranking de proveedores: ¿dónde se va la plata? ----------
create view v_supplier_spend
  with (security_invoker = on) as
select m.company_id,
       m.counterparty_id as supplier_id,
       cp.display_name as supplier_name,
       m.currency,
       date_trunc('month', m.occurred_on)::date as month,
       sum(m.amount)::numeric(14,2) as total,
       count(*)::int as movimientos
from movements m
join counterparties cp on cp.id = m.counterparty_id
where m.kind = 'expense' and m.status <> 'void'
group by m.company_id, m.counterparty_id, cp.display_name, m.currency,
         date_trunc('month', m.occurred_on);

-- ---------- presupuesto ----------
create table budgets (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id),
  period      text not null,               -- '2026-08'
  category_id uuid not null,
  currency    char(3) not null,
  amount      numeric(14,2) not null check (amount >= 0),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (category_id, company_id) references categories (id, company_id),
  unique (company_id, period, category_id, currency)
);

create trigger budgets_updated_at
  before update on budgets for each row execute function set_updated_at();

create view v_budget_vs_real
  with (security_invoker = on) as
select b.company_id, b.period, b.category_id, c.name as category_name, c.flow,
       b.currency, b.amount as presupuesto,
       coalesce(r.real, 0)::numeric(14,2) as real,
       (coalesce(r.real, 0) - b.amount)::numeric(14,2) as diferencia,
       case when b.amount > 0
            then round((coalesce(r.real, 0) / b.amount) * 100, 1) end as ejecutado_pct
from budgets b
join categories c on c.id = b.category_id
left join lateral (
  select sum(m.amount) as real
  from movements m
  where m.company_id = b.company_id
    and m.category_id = b.category_id
    and m.currency = b.currency
    and m.status <> 'void'
    and to_char(m.occurred_on, 'YYYY-MM') = b.period
) r on true;

-- ---------- costos de producción (México) ----------
-- La cantidad producida no existe en ningún sistema todavía: se carga a mano una
-- vez por mes. El conteo de casos del CRM queda al lado como control, no como
-- fuente (un caso no dice cuántos alineadores tiene).
create table production_months (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies (id),
  period            text not null,                 -- '2026-08'
  aligners_produced int not null check (aligners_produced >= 0),
  cases_shipped     int,
  crm_cases_ref     int,                           -- control, se completa solo
  notes             text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, period)
);

create trigger production_months_updated_at
  before update on production_months for each row execute function set_updated_at();

-- Receta del costo TEÓRICO: lo que debería costar un alineador.
create table cost_recipes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  name       text not null,                        -- 'alineador' | 'caso'
  valid_from date not null,
  notes      text,
  unique (company_id, name, valid_from),
  unique (id, company_id)
);

create table cost_recipe_items (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  recipe_id  uuid not null,
  concept    text not null,                        -- placa, resina, mano de obra…
  quantity   numeric(12,4) not null default 1,
  unit       text,
  unit_cost  numeric(14,4) not null,
  scrap_pct  numeric(5,2) not null default 0,      -- desperdicio esperado
  currency   char(3) not null,
  foreign key (recipe_id, company_id) references cost_recipes (id, company_id)
);

-- Costo REAL del mes: gasto de producción / alineadores producidos.
-- Solo entran las categorías marcadas cost_center='produccion_mx': el flete de
-- venta o el alquiler de la oficina comercial NO son costo de producción.
create view v_production_cost
  with (security_invoker = on) as
select pm.company_id,
       pm.period,
       pm.aligners_produced,
       m.currency,
       sum(m.amount)::numeric(14,2) as gasto_produccion,
       case when pm.aligners_produced > 0
            then round(sum(m.amount) / pm.aligners_produced, 2) end as costo_por_alineador
from production_months pm
join movements m
  on m.company_id = pm.company_id
 and to_char(m.occurred_on, 'YYYY-MM') = pm.period
 and m.kind = 'expense' and m.status <> 'void'
join categories c on c.id = m.category_id and c.cost_center = 'produccion_mx'
group by pm.company_id, pm.period, pm.aligners_produced, m.currency;

-- Foto congelada al cerrar el mes: recategorizar un gasto en octubre no puede
-- cambiar el costo por alineador que se informó en agosto.
create table cost_snapshots (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies (id),
  period            text not null,
  currency          char(3) not null,
  real_unit_cost    numeric(14,4),
  theoretical_unit_cost numeric(14,4),
  output_units      int,
  total_cost        numeric(14,2),
  breakdown         jsonb not null default '{}',
  locked_at         timestamptz not null default now(),
  locked_by         uuid,
  unique (company_id, period, currency)
);

-- ---------- costos del consultorio (Argentina) ----------
-- Fijos vs variables sale de categories.cost_behavior, que ya existe desde la 0003.
create view v_operating_costs
  with (security_invoker = on) as
select m.company_id,
       date_trunc('month', m.occurred_on)::date as month,
       m.currency,
       coalesce(c.cost_behavior, 'sin_clasificar') as behavior,
       c.name as category_name,
       sum(m.amount)::numeric(14,2) as total
from movements m
left join categories c on c.id = m.category_id
where m.kind = 'expense' and m.status <> 'void'
group by m.company_id, date_trunc('month', m.occurred_on), m.currency,
         coalesce(c.cost_behavior, 'sin_clasificar'), c.name;

-- ---------- cash flow proyectado ----------
-- Saldo de hoy + lo que entra + lo que sale, por tramos. Todo derivado: no hay
-- una tabla de proyección que pueda quedar vieja.
create view v_cashflow_forecast
  with (security_invoker = on) as
with saldos as (
  select company_id, currency, sum(balance)::numeric(14,2) as saldo
  from v_account_balances
  where include_in_totals and is_active
  group by company_id, currency
),
tramos as (
  select * from (values (7), (15), (30), (60), (90)) as t(dias)
)
select s.company_id,
       s.currency,
       t.dias,
       s.saldo,
       coalesce((
         select sum(r.amount - coalesce(ra.pagado, 0))
         from receivables r
         left join lateral (
           select sum(amount) as pagado from receivable_applications where receivable_id = r.id
         ) ra on true
         where r.company_id = s.company_id and r.currency = s.currency
           and r.status not in ('paid', 'void')
           and r.due_on is not null and r.due_on <= current_date + t.dias
       ), 0)::numeric(14,2) as a_cobrar,
       coalesce((
         select sum(p.amount - coalesce(pp.pagado, 0))
         from payables p
         left join lateral (
           select sum(amount) as pagado from payable_payments where payable_id = p.id
         ) pp on true
         where p.company_id = s.company_id and p.currency = s.currency
           and p.status not in ('paid', 'void')
           and p.due_on <= current_date + t.dias
       ), 0)::numeric(14,2) as a_pagar
from saldos s
cross join tramos t;

-- ---------- RLS + grants de la Etapa 3 ----------
do $$
declare t text;
begin
  foreach t in array array[
    'products', 'purchases', 'purchase_items', 'budgets',
    'production_months', 'cost_recipes', 'cost_recipe_items', 'cost_snapshots'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$
      create policy %I on %I for select to authenticated
        using (company_id in (select private.member_companies()))
    $p$, t || '_select', t);
    execute format($p$
      create policy %I on %I for insert to authenticated
        with check (private.has_role(company_id, array['owner','admin','operator']))
    $p$, t || '_insert', t);
    execute format($p$
      create policy %I on %I for update to authenticated
        using (private.has_role(company_id, array['owner','admin','operator']))
        with check (private.has_role(company_id, array['owner','admin','operator']))
    $p$, t || '_update', t);
    execute format('grant select, insert, update on %I to authenticated', t);
    execute format('grant select, insert, update, delete on %I to service_role', t);
  end loop;
end $$;

-- las líneas de una compra en borrador y los ítems de receta sí se borran
create policy purchase_items_delete on purchase_items for delete to authenticated
  using (private.has_role(company_id, array['owner','admin','operator']));
create policy cost_recipe_items_delete on cost_recipe_items for delete to authenticated
  using (private.has_role(company_id, array['owner','admin','operator']));
create policy budgets_delete on budgets for delete to authenticated
  using (private.has_role(company_id, array['owner','admin','operator']));
grant delete on purchase_items, cost_recipe_items, budgets to authenticated;

grant select on v_product_prices, v_product_supplier_prices, v_supplier_spend,
                v_budget_vs_real, v_production_cost, v_operating_costs,
                v_cashflow_forecast
  to authenticated, service_role;

create trigger purchases_audit
  after insert or update on purchases
  for each row execute function audit_row_changes();

revoke all on all tables in schema public from anon;

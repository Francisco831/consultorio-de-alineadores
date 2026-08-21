-- Coni cobra en su propia cuenta: contabilidad COMPLETAMENTE separada del
-- consultorio (pedido de Pancho, 21/8/26). accounts.separate_books saca la
-- cuenta de los agregados del negocio (resumen mensual y categorías); la UI
-- la muestra en un cuadro aparte. include_in_totals ya la excluía de la
-- disponibilidad; esto la excluye de ingresos/egresos.
-- OJO: "Sin medio (a revisar)" NO va acá — esos son movimientos del negocio
-- esperando cuenta, y sacarlos subcontaría los ingresos reales.

alter table accounts add column separate_books boolean not null default false;

update accounts set separate_books = true where name ilike '%coni%';

create or replace view v_monthly_summary
  with (security_invoker = on) as
select m.company_id,
       date_trunc('month', m.occurred_on)::date as month,
       m.currency,
       sum(m.amount) filter (where m.kind = 'income')::numeric(14,2)  as income,
       sum(m.amount) filter (where m.kind = 'expense')::numeric(14,2) as expense,
       (coalesce(sum(m.amount) filter (where m.kind = 'income'), 0)
        - coalesce(sum(m.amount) filter (where m.kind = 'expense'), 0))::numeric(14,2) as result
from movements m
join accounts a on a.id = m.account_id
where m.status <> 'void'
  and m.kind in ('income', 'expense')
  and not a.separate_books
group by m.company_id, date_trunc('month', m.occurred_on), m.currency;

create or replace view v_monthly_by_category
  with (security_invoker = on) as
select m.company_id,
       date_trunc('month', m.occurred_on)::date as month,
       m.currency,
       m.kind,
       m.category_id,
       c.name as category_name,
       sum(m.amount)::numeric(14,2) as total,
       count(*) as movements_count
from movements m
join accounts a on a.id = m.account_id
left join categories c on c.id = m.category_id
where m.status <> 'void'
  and m.kind in ('income', 'expense')
  and not a.separate_books
group by m.company_id, date_trunc('month', m.occurred_on), m.currency, m.kind,
         m.category_id, c.name;

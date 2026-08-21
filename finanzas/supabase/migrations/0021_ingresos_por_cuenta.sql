-- Ingresos por cuenta y mes, agregados EN la base: el dashboard traía ~5.000
-- movimientos para sumarlos en el server — ahora viajan ~50 filas.
create view v_monthly_income_by_account
  with (security_invoker = on) as
select m.company_id,
       m.account_id,
       a.name as account_name,
       a.ks_custody,
       a.separate_books,
       date_trunc('month', m.occurred_on)::date as month,
       m.currency,
       sum(m.amount)::numeric(14,2) as income
from movements m
join accounts a on a.id = m.account_id
where m.status <> 'void'
  and m.kind = 'income'
group by m.company_id, m.account_id, a.name, a.ks_custody, a.separate_books,
         date_trunc('month', m.occurred_on), m.currency;

grant select on v_monthly_income_by_account to authenticated, service_role;

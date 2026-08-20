-- 0009: vistas de la Etapa 1. security_invoker=on para que la RLS del usuario
-- que consulta aplique adentro de la vista (sin eso, una vista corre con los
-- permisos del dueño y perfora el aislamiento).

-- Disponibilidad: saldo por cuenta = suma de signed_amount confirmados.
-- Los pending (ej: cobros sembrados sin medio identificado) NO suman al saldo
-- de ninguna cuenta real: quedan visibles como deuda de clasificación.
create view v_account_balances
  with (security_invoker = on) as
select a.company_id,
       a.id as account_id,
       a.name,
       a.type,
       a.currency,
       a.include_in_totals,
       a.is_active,
       coalesce(sum(m.signed_amount) filter (where m.status = 'confirmed'), 0)::numeric(14,2) as balance,
       count(m.id) filter (where m.status = 'pending') as pending_count,
       max(m.occurred_on) filter (where m.status = 'confirmed') as last_movement_on
from accounts a
left join movements m on m.account_id = a.id
group by a.company_id, a.id, a.name, a.type, a.currency, a.include_in_totals, a.is_active;

-- Serie mensual por tipo y categoría (ingresos/gastos; transferencias afuera
-- por kind). Incluye pending y confirmed: la plata cobrada sin medio asignado
-- sigue siendo un ingreso del mes.
create view v_monthly_by_category
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
left join categories c on c.id = m.category_id
where m.status <> 'void'
  and m.kind in ('income', 'expense')
group by m.company_id, date_trunc('month', m.occurred_on), m.currency, m.kind,
         m.category_id, c.name;

-- Resumen mensual (ingresos, egresos, resultado) por moneda.
create view v_monthly_summary
  with (security_invoker = on) as
select m.company_id,
       date_trunc('month', m.occurred_on)::date as month,
       m.currency,
       sum(m.amount) filter (where m.kind = 'income')::numeric(14,2)  as income,
       sum(m.amount) filter (where m.kind = 'expense')::numeric(14,2) as expense,
       (coalesce(sum(m.amount) filter (where m.kind = 'income'), 0)
        - coalesce(sum(m.amount) filter (where m.kind = 'expense'), 0))::numeric(14,2) as result
from movements m
where m.status <> 'void'
  and m.kind in ('income', 'expense')
group by m.company_id, date_trunc('month', m.occurred_on), m.currency;

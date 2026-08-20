-- 0017: el cash flow tiene que contar los gastos fijos que ya sabemos que vienen.
--
-- La versión anterior solo miraba deudas ya emitidas, así que con la bandeja
-- vacía proyectaba la misma caja a 7 y a 90 días — o sea, no proyectaba nada.
-- El alquiler y las expensas vencen todos los meses aunque nadie haya cargado
-- todavía la cuenta a pagar: ignorarlos es prometer una caja que no existe.
--
-- Se cuentan las ocurrencias de cada regla dentro del tramo (generate_series),
-- así 90 días incluyen tres alquileres, no uno.

drop view if exists v_cashflow_forecast;

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
),
base as (
  select s.company_id, s.currency, t.dias, s.saldo
  from saldos s cross join tramos t
)
select b.company_id,
       b.currency,
       b.dias,
       b.saldo,
       coalesce((
         select sum(r.amount - coalesce(ra.pagado, 0))
         from receivables r
         left join lateral (
           select sum(amount) as pagado from receivable_applications where receivable_id = r.id
         ) ra on true
         where r.company_id = b.company_id and r.currency = b.currency
           and r.status not in ('paid', 'void')
           and r.due_on is not null and r.due_on <= current_date + b.dias
       ), 0)::numeric(14,2) as a_cobrar,
       coalesce((
         select sum(p.amount - coalesce(pp.pagado, 0))
         from payables p
         left join lateral (
           select sum(amount) as pagado from payable_payments where payable_id = p.id
         ) pp on true
         where p.company_id = b.company_id and p.currency = b.currency
           and p.status not in ('paid', 'void')
           and p.due_on <= current_date + b.dias
       ), 0)::numeric(14,2) as a_pagar,
       -- gastos fijos que todavía no son una cuenta a pagar pero van a serlo
       coalesce((
         select sum(rr.amount_estimated * (
           select count(*)
           from generate_series(
             rr.next_due_on::timestamp,
             (current_date + b.dias)::timestamp,
             case rr.frequency
               when 'weekly'    then interval '7 days'
               when 'biweekly'  then interval '14 days'
               when 'monthly'   then interval '1 month'
               when 'bimonthly' then interval '2 months'
               when 'quarterly' then interval '3 months'
               when 'yearly'    then interval '1 year'
               else interval '1 month'
             end
           )
         ))
         from recurring_rules rr
         where rr.company_id = b.company_id and rr.currency = b.currency
           and rr.active and rr.amount_estimated is not null
           -- no contar dos veces lo que ya se emitió como cuenta a pagar
           and not exists (
             select 1 from payables p
             where p.company_id = rr.company_id and p.source = 'recurring'
               and p.status not in ('paid', 'void')
               and p.due_on <= current_date + b.dias
               and p.concept = rr.name
           )
       ), 0)::numeric(14,2) as fijos_estimados
from base b;

grant select on v_cashflow_forecast to authenticated, service_role;

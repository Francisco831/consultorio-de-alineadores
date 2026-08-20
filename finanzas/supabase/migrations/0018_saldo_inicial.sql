-- El extracto de BBVA MX declara el saldo al 1/1/2026 (74.282,16): el modelo no
-- tenía dónde ponerlo. Un movimiento "de apertura" mentiría (no es un hecho del
-- período y ensuciaría ingresos o gastos); el saldo inicial es un atributo de la
-- cuenta. El balance pasa a ser apertura + suma de movimientos confirmados.

alter table accounts
  add column if not exists opening_balance numeric(14,2) not null default 0;

comment on column accounts.opening_balance is
  'Saldo al inicio de la historia (1/1/2026), tomado del extracto del banco. 0 si la historia arranca de cero.';

create or replace view v_account_balances
  with (security_invoker = on) as
select a.company_id,
       a.id as account_id,
       a.name,
       a.type,
       a.currency,
       a.include_in_totals,
       a.is_active,
       (a.opening_balance
        + coalesce(sum(m.signed_amount) filter (where m.status = 'confirmed'), 0)
       )::numeric(14,2) as balance,
       count(m.id) filter (where m.status = 'pending') as pending_count,
       max(m.occurred_on) filter (where m.status = 'confirmed') as last_movement_on
from accounts a
left join movements m on m.account_id = a.id
group by a.company_id, a.id, a.name, a.type, a.currency, a.include_in_totals, a.is_active;

grant select on v_account_balances to authenticated, service_role;

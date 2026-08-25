-- 0027: reabrir una liquidación confirmada, desde la página.
--
-- Confirmar hace dos cosas —congela la liquidación y crea la deuda en Por
-- pagar— así que reabrir tiene que deshacer las dos. Hasta hoy eso sólo se
-- podía por terminal (scripts/reabrir-liquidacion.ts) y con service_role,
-- porque la app NO puede borrar un payable: la 0014 no le da policy de DELETE,
-- a propósito ("las deudas se anulan con status, nunca se borran").
--
-- La salida no es perforar esa regla sino respetarla: la deuda se ANULA, y
-- confirm_settlement aprende a reutilizar una deuda anulada en vez de insertar
-- otra. Sin eso, el unique (company_id, source, source_id) —una liquidación,
-- UNA deuda— haría que la liquidación reabierta no se pueda volver a confirmar
-- nunca.
--
-- Es security definer porque toca payables, que el rol de la app no puede
-- escribir; por eso valida el permiso a mano, con la misma regla que las
-- policies.

create or replace function reopen_settlement(p_settlement_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_s professional_settlements%rowtype;
  v_pagos int;
begin
  select * into v_s from professional_settlements where id = p_settlement_id;
  if not found then raise exception 'la liquidación no existe'; end if;

  if not private.has_role(v_s.company_id, array['owner','admin','operator']) then
    raise exception 'sin permiso para reabrir liquidaciones de esta empresa';
  end if;

  if v_s.status = 'draft' then return; end if;

  -- Una liquidación PAGADA no se reabre acá. Esa plata ya salió: deshacerla es
  -- una decisión con contrapartida contable, y una pantalla puede pedir menos
  -- criterio que una terminal, nunca más.
  if v_s.status <> 'confirmed' then
    raise exception 'la liquidación está %: sólo se reabren las confirmadas', v_s.status;
  end if;

  if v_s.payable_id is not null then
    select count(*) into v_pagos from payable_payments where payable_id = v_s.payable_id;
    if v_pagos > 0 then
      raise exception 'esa deuda ya tiene % pago(s) aplicado(s): desaplicalos primero desde Por pagar', v_pagos;
    end if;
    update payables set status = 'void' where id = v_s.payable_id;
  end if;

  update professional_settlements
     set status = 'draft', payable_id = null
   where id = p_settlement_id;
end $$;

revoke all on function reopen_settlement(uuid) from public;
grant execute on function reopen_settlement(uuid) to authenticated, service_role;

-- confirm_settlement: reutiliza la deuda anulada de una reapertura.
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

  select currencies[1] into v_currency from companies where id = v_s.company_id;
  v_due := coalesce((v_s.totals -> v_currency ->> 'due')::numeric, 0);
  if v_due <= 0 then raise exception 'la liquidación no tiene saldo a pagar en %', v_currency; end if;

  select id into v_cat from categories
   where company_id = v_s.company_id and name = 'Liquidaciones profesionales' limit 1;

  -- Si esta liquidación ya tuvo una deuda y quedó anulada por una reapertura,
  -- se revive con el importe nuevo: el unique (company_id, source, source_id)
  -- no deja tener dos.
  select id into v_payable from payables
   where company_id = v_s.company_id and source = 'settlement' and source_id = v_s.id;

  if v_payable is not null then
    update payables
       set status = 'open', amount = v_due, currency = v_currency,
           due_on = coalesce(p_due_on, current_date),
           concept = 'Liquidación ' || v_s.period
     where id = v_payable;
  else
    insert into payables (company_id, counterparty_id, category_id, source, source_id,
                          concept, currency, amount, due_on, created_by)
    values (v_s.company_id, v_s.professional_id, v_cat, 'settlement', v_s.id,
            'Liquidación ' || v_s.period, v_currency, v_due,
            coalesce(p_due_on, current_date), auth.uid())
    returning id into v_payable;
  end if;

  update professional_settlements
     set status = 'confirmed', payable_id = v_payable
   where id = p_settlement_id;

  return v_payable;
end $$;

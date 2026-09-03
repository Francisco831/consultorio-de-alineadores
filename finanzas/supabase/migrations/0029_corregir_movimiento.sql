-- 0029: corregir un movimiento desde la pantalla, y que anular un pago devuelva
-- la deuda a "Por pagar".
--
-- El 26/8/2026 la liquidación de Matelli se pagó desde Banco Macro cuando la
-- plata había salido de Mercado Pago. La única corrección que ofrecía la app era
-- "Anular" — y anular dejaba la deuda marcada como PAGADA, porque void_movement
-- no tocaba payable_payments. Resultado: el egreso desaparecía del ledger, la
-- liquidación NO volvía a la bandeja y no había forma de registrarla bien sin
-- terminal. Un error de un click sólo se podía arreglar con un script.
--
-- Dos arreglos, uno por causa:
--   1. void_movement desaplica los pagos/cobros del movimiento anulado: la deuda
--      (o el cobro) vuelve a su bandeja. Auditado en audit_log.
--   2. correct_movement(): cambiar cuenta, fecha, monto, categoría o concepto sin
--      anular nada. Sólo para los movimientos que NACEN en la app; los importados
--      y los sincronizados se siguen corrigiendo en la fuente — esa regla no se
--      toca, es la que evita que el próximo re-import pise la corrección.

-- ---------- 1. anular también desaplica ----------
-- security definer para poder escribir audit_log (la app no tiene INSERT ahí) y
-- porque desarmar una deuda pagada tiene que quedar registrado sí o sí. El
-- permiso se valida a mano, con la misma regla que las policies, y sólo cuando
-- hay sesión: los scripts corren con service_role y sin JWT (lección de la 0028).
create or replace function void_movement(p_movement_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_mov movements%rowtype;
  v_ids uuid[];
begin
  select * into v_mov from movements where id = p_movement_id;
  if not found then
    raise exception 'movimiento inexistente';
  end if;

  if auth.uid() is not null
     and not private.has_role(v_mov.company_id, array['owner', 'admin', 'operator']) then
    raise exception 'sin permiso para anular movimientos de esta empresa';
  end if;

  if v_mov.status = 'void' then
    return;
  end if;
  if exists (select 1 from reconciliations where movement_id = p_movement_id) then
    raise exception 'movimiento conciliado: primero hay que desconciliarlo';
  end if;

  if v_mov.transfer_group_id is not null then
    if exists (
      select 1 from reconciliations r
      join movements m on m.id = r.movement_id
      where m.transfer_group_id = v_mov.transfer_group_id
    ) then
      raise exception 'transferencia conciliada: primero hay que desconciliarla';
    end if;
    select array_agg(id) into v_ids from movements
     where transfer_group_id = v_mov.transfer_group_id and status <> 'void';
  else
    v_ids := array[p_movement_id];
  end if;

  -- La plata que ya no salió no puede seguir cancelando una deuda.
  insert into audit_log (company_id, entity_type, entity_id, field,
                         old_value, new_value, actor_id, source)
  select pp.company_id, 'payable_payments', pp.id, '_desaplicado',
         pp.amount::text, null, auth.uid(),
         case when auth.uid() is null then 'system' else 'app' end
    from payable_payments pp where pp.movement_id = any (v_ids);
  delete from payable_payments where movement_id = any (v_ids);

  insert into audit_log (company_id, entity_type, entity_id, field,
                         old_value, new_value, actor_id, source)
  select ra.company_id, 'receivable_applications', ra.id, '_desaplicado',
         ra.amount::text, null, auth.uid(),
         case when auth.uid() is null then 'system' else 'app' end
    from receivable_applications ra where ra.movement_id = any (v_ids);
  delete from receivable_applications where movement_id = any (v_ids);

  update movements set status = 'void' where id = any (v_ids);
end $$;

revoke all on function void_movement(uuid) from public;
grant execute on function void_movement(uuid) to authenticated, service_role;

-- ---------- 2. el guard aprende a dejar pasar UNA corrección ----------
-- El guard de la 0005 es el que impide que la app toque los campos monetarios de
-- un movimiento que no es manual. Sigue igual para todo el mundo: la única
-- excepción es la marca de transacción que pone correct_movement(), que ya
-- validó origen, conciliación y saldos. Ni siquiera esa marca deja cambiar la
-- identidad del movimiento (moneda, tipo, origen, clave de import).
create or replace function movements_guard()
returns trigger
language plpgsql
as $$
begin
  if private.is_system() then
    return new;
  end if;

  if coalesce(current_setting('finanzas.correccion', true), '') = 'on' then
    if new.currency     is distinct from old.currency
      or new.kind         is distinct from old.kind
      or new.source       is distinct from old.source
      or new.external_key is distinct from old.external_key then
      raise exception 'una corrección no cambia la moneda, el tipo ni el origen del movimiento';
    end if;
    return new;
  end if;

  if old.source <> 'manual' then
    if new.amount      is distinct from old.amount
      or new.currency    is distinct from old.currency
      or new.account_id  is distinct from old.account_id
      or new.kind        is distinct from old.kind
      or new.occurred_on is distinct from old.occurred_on
      or new.external_key is distinct from old.external_key
      or new.source      is distinct from old.source then
      raise exception
        'movimiento de origen "%" — los campos monetarios se corrigen en la fuente, no acá',
        old.source;
    end if;
  end if;
  -- Nadie renombra el origen de un movimiento manual a otra cosa
  if old.source = 'manual' and new.source <> 'manual' then
    raise exception 'source es inmutable';
  end if;
  return new;
end $$;

-- ---------- 3. corregir ----------
-- Lo que la pantalla venía a pedir: me equivoqué de cuenta / de fecha / de monto,
-- y el movimiento existió igual. Anular y rehacer sirve, pero deja dos renglones
-- por un error de tipeo y, cuando el movimiento paga una deuda, obliga a rehacer
-- también el pago. Esto corrige en el lugar y arrastra el pago aplicado.
create or replace function correct_movement(
  p_movement_id uuid,
  p_account_id  uuid,
  p_occurred_on date,
  p_amount      numeric,
  p_category_id uuid default null,
  p_description text default null
) returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_mov      movements%rowtype;
  v_currency char(3);
  v_pp       payable_payments%rowtype;
  v_ra       receivable_applications%rowtype;
  v_n        int;
  v_total    numeric(14,2);
  v_deuda    numeric(14,2);
begin
  select * into v_mov from movements where id = p_movement_id;
  if not found then raise exception 'movimiento inexistente'; end if;

  if auth.uid() is not null
     and not private.has_role(v_mov.company_id, array['owner', 'admin', 'operator']) then
    raise exception 'sin permiso para corregir movimientos de esta empresa';
  end if;

  if v_mov.status = 'void' then
    raise exception 'el movimiento está anulado: no se corrige, se vuelve a cargar';
  end if;
  if v_mov.source in ('import', 'seed', 'crm_sync') then
    raise exception
      'movimiento de origen "%": se corrige en la fuente, o el próximo sync pisa la corrección',
      v_mov.source;
  end if;
  if v_mov.transfer_group_id is not null then
    raise exception 'una transferencia se corrige anulándola y rehaciéndola: sus dos patas se mueven juntas';
  end if;
  if exists (select 1 from reconciliations where movement_id = p_movement_id) then
    raise exception 'movimiento conciliado: primero hay que desconciliarlo';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'el monto debe ser positivo';
  end if;

  -- la moneda la manda la cuenta: cambiarla no es corregir, es otro movimiento
  select currency into v_currency from accounts
   where id = p_account_id and company_id = v_mov.company_id;
  if v_currency is null then raise exception 'cuenta inexistente o de otra empresa'; end if;
  if v_currency <> v_mov.currency then
    raise exception 'la cuenta es % y el movimiento está en %', v_currency, v_mov.currency;
  end if;

  if p_amount <> v_mov.amount then
    -- el total de una compra y lo que se liquidó de un cobro salen de acá:
    -- corregir el monto por atrás los dejaría mintiendo
    if exists (select 1 from purchases where movement_id = p_movement_id) then
      raise exception 'el monto de una compra se corrige desde la compra';
    end if;
    if exists (
      select 1 from settlement_items si
      join professional_settlements s on s.id = si.settlement_id
      where si.movement_id = p_movement_id and s.status <> 'draft'
    ) then
      raise exception 'ese cobro ya entró en una liquidación: reabrila antes de corregir el monto';
    end if;
  end if;

  -- pago aplicado a una deuda: se mueve con el movimiento
  select count(*) into v_n from payable_payments where movement_id = p_movement_id;
  if v_n > 1 then raise exception 'este movimiento paga % deudas: corregilo desde Por pagar', v_n; end if;
  if v_n = 1 then
    select * into v_pp from payable_payments where movement_id = p_movement_id;
    if v_pp.amount <> p_amount then
      select amount into v_deuda from payables where id = v_pp.payable_id;
      select coalesce(sum(amount), 0) into v_total from payable_payments
       where payable_id = v_pp.payable_id and movement_id <> p_movement_id;
      if v_total + p_amount > v_deuda + 0.01 then
        raise exception 'el pago corregido excede el saldo: la deuda es % y ya hay % pagado', v_deuda, v_total;
      end if;
    end if;
  end if;

  select count(*) into v_n from receivable_applications where movement_id = p_movement_id;
  if v_n > 1 then raise exception 'este cobro aplica a % planes: corregilo desde Por cobrar', v_n; end if;
  if v_n = 1 then
    select * into v_ra from receivable_applications where movement_id = p_movement_id;
    if v_ra.amount <> p_amount then
      select amount into v_deuda from receivables where id = v_ra.receivable_id;
      select coalesce(sum(amount), 0) into v_total from receivable_applications
       where receivable_id = v_ra.receivable_id and movement_id <> p_movement_id;
      if v_total + p_amount > v_deuda + 0.01 then
        raise exception 'el cobro corregido excede el saldo: son % y ya hay % aplicado', v_deuda, v_total;
      end if;
    end if;
  end if;

  perform set_config('finanzas.correccion', 'on', true);

  update movements
     set account_id  = p_account_id,
         occurred_on = p_occurred_on,
         amount      = p_amount,
         category_id = p_category_id,
         description = p_description
   where id = p_movement_id;

  if v_pp.id is not null then
    update payable_payments set amount = p_amount where id = v_pp.id;
  end if;
  if v_ra.id is not null then
    update receivable_applications set amount = p_amount where id = v_ra.id;
  end if;

  perform set_config('finanzas.correccion', 'off', true);
end $$;

revoke all on function correct_movement(uuid, uuid, date, numeric, uuid, text) from public;
grant execute on function correct_movement(uuid, uuid, date, numeric, uuid, text)
  to authenticated, service_role;

-- ---------- 4. reparación: los pagos que quedaron colgados de un anulado ----------
-- Todo pago cuyo movimiento está anulado nació del bug de arriba: la deuda figura
-- pagada con plata que no salió. Se desaplica una sola vez, con la misma huella
-- en audit_log que deja el void nuevo. Idempotente: si no hay ninguno, no hace nada.
do $$
declare
  v_n int;
begin
  insert into audit_log (company_id, entity_type, entity_id, field,
                         old_value, new_value, actor_id, source)
  select pp.company_id, 'payable_payments', pp.id, '_desaplicado',
         pp.amount::text, null, null, 'system'
    from payable_payments pp
    join movements m on m.id = pp.movement_id
   where m.status = 'void';
  delete from payable_payments pp
   using movements m
   where m.id = pp.movement_id and m.status = 'void';
  get diagnostics v_n = row_count;
  raise notice 'pagos desaplicados (movimiento anulado): %', v_n;

  insert into audit_log (company_id, entity_type, entity_id, field,
                         old_value, new_value, actor_id, source)
  select ra.company_id, 'receivable_applications', ra.id, '_desaplicado',
         ra.amount::text, null, null, 'system'
    from receivable_applications ra
    join movements m on m.id = ra.movement_id
   where m.status = 'void';
  delete from receivable_applications ra
   using movements m
   where m.id = ra.movement_id and m.status = 'void';
  get diagnostics v_n = row_count;
  raise notice 'cobros desaplicados (movimiento anulado): %', v_n;
end $$;

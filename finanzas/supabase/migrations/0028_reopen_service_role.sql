-- 0028: reopen_settlement también desde los scripts.
--
-- La 0027 validaba el permiso con private.has_role(), que se apoya en
-- auth.uid(). Los scripts de terminal corren con service_role y sin JWT, así
-- que auth.uid() es null y la función los rechazaba con "sin permiso" — o sea,
-- el camino viejo (scripts/reabrir-liquidacion.ts) quedaba roto justo al abrir
-- el nuevo.
--
-- La validación se aplica sólo cuando HAY sesión. Sin JWT sólo puede llamarla
-- service_role, que ya tiene BYPASSRLS y cuyo alcance lo define el guard de
-- destino de los scripts, no la base. anon no está en el grant.

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

  if auth.uid() is not null
     and not private.has_role(v_s.company_id, array['owner','admin','operator']) then
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

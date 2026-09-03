-- 0031: dos agujeros del guard de la 0030, encontrados en la revisión del 2/9/26.
--
-- La 0030 decide si un cobro está en un mes cerrado mirando settlement_items.
-- Los dos problemas salen de ahí.
--
--  1. HAY LIQUIDACIONES CERRADAS SIN DETALLE. Al 2/9/26 son siete (Mónica
--     González de enero a junio y Matelli de enero): 307 cobros por ~$21,8M
--     cuyo movement_id no figura en ningún ítem. Es el agujero que la 0025 ya
--     había escrito ("las cerradas sin detalle no tienen línea, y justo ahí
--     están los cobros más grandes"). Para esos cobros el guard no encuentra
--     nada y deja poner un número a mano sobre un mes ya PAGADO.
--
--  2. UN OVERRIDE HUÉRFANO DE UN MES PAGADO NO SE PODÍA DESHACER NUNCA. Si la
--     caja edita la fila después de que la liquidación se pagó, el movimiento
--     se anula (external_key de contenido) y el override queda colgado. El
--     diagnóstico lo denuncia en cada corrida —"volvé a ponerlo en la fila
--     nueva"— pero deshacerlo es un UPDATE, y el guard lo frenaba por estar el
--     ítem en una liquidación 'paid'. reopen_settlement() (0027) se niega a
--     reabrir una pagada, así que el aviso quedaba clavado para siempre.
--     Un override sobre un movimiento anulado no le está aplicando un peso a
--     nadie: anularlo no puede cambiar ninguna liquidación.

create or replace function settlement_line_overrides_guard()
returns trigger
language plpgsql
as $$
declare
  v_donde   text;
  v_periodo text;
  v_prof    uuid;
  v_status  text;
begin
  if tg_op = 'UPDATE' and new.movement_id is distinct from old.movement_id then
    raise exception 'un override es de su cobro: para corregir otro, deshacé éste y creá el que va';
  end if;

  -- Deshacer un override cuyo cobro ya no existe siempre se puede: ese número
  -- no está entrando a ninguna liquidación, ni abierta ni cerrada.
  if tg_op = 'UPDATE' and new.status = 'void' and old.status = 'active'
     and exists (select 1 from movements m where m.id = new.movement_id and m.status = 'void') then
    return new;
  end if;

  select s.period || ' ' || coalesce(c.display_name, 'esa doctora')
    into v_donde
    from settlement_items si
    join professional_settlements s on s.id = si.settlement_id
    left join counterparties c on c.id = s.professional_id
   where si.movement_id = new.movement_id
     and s.status in ('confirmed', 'paid')
   limit 1;

  -- Sin ítem no quiere decir "no está liquidado": puede ser una de las cerradas
  -- sin detalle. Se pregunta por el mes del cobro y la doctora que le toca.
  --
  -- El mes sale de occurred_on. El motor tiene además siete devengados que
  -- liquidan en otro mes (seed-data/periodo_liquidacion_overrides.json, un
  -- archivo del repo que la base no ve), así que para esos siete este chequeo
  -- puede mirar el mes equivocado. Se acepta a propósito: el error posible es
  -- frenar de más una edición —y el mensaje dice dónde mirar— y no dejar tocar
  -- un mes pagado.
  if v_donde is null and not exists (
    select 1 from settlement_items si where si.movement_id = new.movement_id
  ) then
    select to_char(m.occurred_on, 'YYYY-MM'),
           coalesce(
             (select i.professional_id from settlement_imputations i
               where i.movement_id = m.id and i.destino = 'profesional'),
             (select cp.id from counterparties cp
               where cp.company_id = m.company_id
                 and cp.display_name = (m.meta ->> 'doctora'))
           )
      into v_periodo, v_prof
      from movements m where m.id = new.movement_id;

    -- Un cobro que ya se decidió que no se liquida a nadie no tiene mes cerrado.
    if exists (
      select 1 from settlement_imputations i
       where i.movement_id = new.movement_id and i.destino = 'casa'
    ) then
      v_prof := null;
    end if;

    if v_prof is not null then
      select s.status, s.period || ' ' || coalesce(c.display_name, 'esa doctora')
        into v_status, v_donde
        from professional_settlements s
        left join counterparties c on c.id = s.professional_id
       where s.company_id = new.company_id
         and s.period = v_periodo
         and s.professional_id = v_prof
         and s.status in ('confirmed', 'paid')
       limit 1;
    end if;
  end if;

  if v_donde is not null then
    raise exception
      'ese cobro ya está liquidado en % y esa liquidación está cerrada: reabrila antes de tocar la línea',
      v_donde;
  end if;

  return new;
end $$;

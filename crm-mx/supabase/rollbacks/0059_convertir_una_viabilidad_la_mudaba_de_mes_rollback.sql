-- Rollback de 0059. Vuelve vincular_viabilidades() a la versión de 0057 (sin fijar
-- la fecha de pedido antes de mover la etapa). Las fechas de pedido que 0059
-- completó en las viabilidades del import se DEJAN: son las del import, no un
-- cálculo, y sin ellas la página vuelve a inferir el mes desde stage_entered_at.
create or replace function vincular_viabilidades() returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_previo text;
  v_count int := 0;
  r record;
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede vincular viabilidades';
  end if;
  v_previo := coalesce(current_setting('app.system', true), '');
  perform set_config('app.system', 'on', true);
  perform set_config('app.source', 'automation', true);

  for r in
    select o.id as opp_id, c.id as case_id, c.fecha_ingreso
    from opportunities o
    cross join lateral (
      select c.id, c.fecha_ingreso
      from cases c
      where c.doctor_id = o.doctor_id
        and c.is_new_case
        and c.is_demo = o.is_demo
        and c.paciente is not null
        and c.fecha_ingreso >= coalesce(o.viability_requested_at, o.stage_entered_at, o.created_at)
                               - interval '7 days'
        and (
          select count(*) from (
            select unnest(viab_tokens(o.patient_name))
            intersect
            select unnest(viab_tokens(c.paciente))
          ) comunes
        ) >= least(2, cardinality(viab_tokens(o.patient_name)))
      order by c.fecha_ingreso
      limit 1
    ) c
    where o.stage not in ('ganada', 'perdida')
      and o.case_id is null
      and (o.viability_requested_at is not null or o.stage = 'viabilidad')
      and cardinality(viab_tokens(o.patient_name)) > 0
  loop
    update opportunities
       set stage = 'ganada', case_id = r.case_id
     where id = r.opp_id;
    update opportunities
       set closed_at = r.fecha_ingreso,
           viability_completed_at = coalesce(viability_completed_at, r.fecha_ingreso)
     where id = r.opp_id;
    update alerts
       set status = 'resuelta', resolved_at = now()
     where opportunity_id = r.opp_id and status = 'abierta';
    v_count := v_count + 1;
  end loop;

  perform set_config('app.system', v_previo, true);
  return v_count;
end $fn$;

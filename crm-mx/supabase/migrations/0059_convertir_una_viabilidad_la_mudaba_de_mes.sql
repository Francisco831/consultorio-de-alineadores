-- 0059 — Convertir una viabilidad la mudaba de mes.
--
-- 0057 corrió en producción el 8/9 a la noche y vinculó la viabilidad de Diana
-- Sandoval (pedida el 30/7) con su caso BX764. Bien. Pero el panel mensual la
-- mostró en SEPTIEMBRE: al pasar a 'ganada', el trigger de transición (0011)
-- pone stage_entered_at = now(), y para las 35 viabilidades del import del 8/8
-- —que no tienen viability_requested_at— esa columna ERA la fecha de ingreso
-- (lib/viabilidades.ts: fechaIngreso = viability_requested_at ?? stage_entered_at).
-- Convertir la movía de mes, le cambiaba el N° del mes, julio bajaba de 5 a 4 y
-- septiembre sumaba una convertida que no era suya.
--
-- Dos arreglos:
--   1. La fecha de pedido deja de inferirse. viability_requested_at se completa
--      para las del import con la fecha que viaja en su external_key
--      ('viab:<fecha>:<paciente>', scripts/import-viabilidades.ts), a medianoche
--      UTC como la guarda el formulario. Es la marca que la página ya trataba
--      como "la de verdad"; el criterio legacy por etapa y lost_reason queda de
--      respaldo. Sandoval vuelve al 30/7.
--   2. vincular_viabilidades() fija viability_requested_at ANTES de cambiar la
--      etapa (con el stage_entered_at viejo, que en un UPDATE es el valor previo
--      al trigger), así una viabilidad que llegue sin fecha de pedido no se muda
--      de mes al convertir.
--
-- Rollback: supabase/rollbacks/0059_convertir_una_viabilidad_la_mudaba_de_mes_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. La fecha de pedido de las viabilidades del import
-- ---------------------------------------------------------------------------
update opportunities
   set viability_requested_at =
         (substring(external_key from '^viab:(\d{4}-\d{2}-\d{2}):') || 'T00:00:00Z')::timestamptz
 where viability_requested_at is null
   and external_key ~ '^viab:\d{4}-\d{2}-\d{2}:';

-- ---------------------------------------------------------------------------
-- 2. El cruce, fijando la fecha antes de mover la etapa
-- ---------------------------------------------------------------------------
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

  -- la llave se pide y se devuelve (0053): si esto corriera adentro de otra
  -- transacción, dejarla prendida abriría todos los guards
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
      -- qué es una viabilidad: la marca del formulario o la etapa (lib/viabilidades.ts)
      and (o.viability_requested_at is not null or o.stage = 'viabilidad')
      and cardinality(viab_tokens(o.patient_name)) > 0
  loop
    -- la fecha de ingreso se fija ACÁ, en la misma sentencia que mueve la etapa:
    -- el lado derecho lee la fila vieja, y el trigger de transición pisa
    -- stage_entered_at con now() recién después (0059)
    update opportunities
       set stage = 'ganada',
           case_id = r.case_id,
           viability_requested_at = coalesce(viability_requested_at, stage_entered_at)
     where id = r.opp_id;
    -- el trigger de transición acaba de poner closed_at = now(): la fecha real
    -- de conversión es la de ingreso del caso
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

comment on function vincular_viabilidades() is
  'Viabilidades abiertas cuyo paciente ya entró como caso de primera etapa del mismo doctor: pasan a ganada con case_id (fijando antes su fecha de pedido, 0059), closed_at = ingreso del caso, y sus alertas se resuelven. La corre el sync de Noloco y pg_cron cada hora. Devuelve cuántas vinculó.';

-- ---------------------------------------------------------------------------
-- 3. Verificación
-- ---------------------------------------------------------------------------
do $$
declare v_sin_fecha int; v_mal int; v_total int; v_fix int;
begin
  select count(*) into v_sin_fecha from opportunities
   where viability_requested_at is null and external_key ~ '^viab:\d{4}-\d{2}-\d{2}:';
  if v_sin_fecha > 0 then
    raise exception '0059: quedaron % viabilidades del import sin fecha de pedido', v_sin_fecha;
  end if;

  -- la fecha guardada es la del external_key, leída en UTC como la lee la página
  select count(*), count(*) filter (
           where to_char(viability_requested_at at time zone 'UTC', 'YYYY-MM-DD')
                 <> substring(external_key from '^viab:(\d{4}-\d{2}-\d{2}):'))
    into v_total, v_mal
    from opportunities where external_key ~ '^viab:\d{4}-\d{2}-\d{2}:';
  if v_mal > 0 then
    raise exception '0059: % viabilidades del import con una fecha de pedido distinta a la del import', v_mal;
  end if;

  select count(*) into v_fix from pg_proc
   where proname = 'vincular_viabilidades'
     and prosrc like '%coalesce(viability_requested_at, stage_entered_at)%';
  if v_fix <> 1 then
    raise exception '0059: vincular_viabilidades() no quedó con la fecha fijada antes de mover la etapa';
  end if;

  raise notice '0059 OK: % viabilidades del import con su fecha de pedido; convertir ya no las muda de mes.', v_total;
end $$;

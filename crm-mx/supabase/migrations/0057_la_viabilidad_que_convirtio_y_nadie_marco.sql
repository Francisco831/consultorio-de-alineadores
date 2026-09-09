-- 0057 — La viabilidad que se convirtió en caso, y el CRM no se entera.
--
-- Pedido de Pancho (8/9/26): el panel mensual de /viabilidades tiene que decir
-- cuántas viabilidades de cada mes terminaron en paciente nuevo, y ese dato
-- "tiene que actualizarse automáticamente cuando el registro pasa de viabilidad
-- a ingreso como paciente nuevo — no debe ser un campo de carga manual".
--
-- LO QUE HABÍA. El vínculo viabilidad → caso (opportunities.case_id) lo escribió
-- UNA sola vez el import del 8/8 (scripts/import-viabilidades.ts, con un matcher
-- por nombre de paciente). El sync de Noloco (lib/noloco-sync.ts, cada 2 h) trae
-- los casos pero nunca los cruza con las viabilidades: una viabilidad cargada en
-- el CRM queda "esperando" para siempre aunque el caso ya esté en producción.
-- Medido en producción el 8/9: la viabilidad de Diana Sandoval (pedida el 30/7,
-- respondida) sigue abierta, y su caso BX764 entró como primera etapa el 28/8.
--
-- LO QUE HACE. vincular_viabilidades(): para cada viabilidad abierta (sin caso,
-- ni ganada ni perdida, con nombre de paciente) busca el primer caso de PRIMERA
-- ETAPA (is_new_case) del mismo doctor, ingresado desde una semana antes del
-- pedido en adelante, cuyo nombre de paciente comparta al menos dos palabras
-- (o la única, si el nombre tiene una sola). Es el mismo criterio del import:
-- no se inventa otro para que las 23 que ya están vinculadas y las que vincule
-- esto se hayan reconocido igual. La semana de tolerancia hacia atrás es porque
-- las viabilidades se cargan en tanda con la fecha de ese día, y el caso puede
-- haber entrado entre el pedido real y la carga.
--
-- Solo primeras etapas: una viabilidad es un paciente nuevo. Las etapas
-- posteriores del mismo paciente (I_2, I_3) son del tratamiento que ya convirtió.
--
-- Al vincular: stage='ganada' + case_id (el trigger de 0011 pone probability,
-- forecast y closed_at=now()); después closed_at se corrige a la fecha de
-- ingreso del caso, que es cuándo convirtió de verdad; viability_completed_at
-- se completa si estaba vacío (el ciclo terminó: el caso entró), con lo que la
-- fila sale de la cola de /seguimiento; y las alertas abiertas sobre esa
-- oportunidad se resuelven, que es la lección de 0054: lo que abre una regla
-- lo tiene que cerrar alguien.
--
-- Corre en dos lugares: adentro del sync de Noloco (lib/noloco-sync.ts), que es
-- donde llegan los casos, y por pg_cron cada hora como red. Un UPDATE sobre
-- decenas de filas, no compite con nada.
--
-- Rollback: supabase/rollbacks/0057_la_viabilidad_que_convirtio_y_nadie_marco_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Las palabras de un nombre, como las compara el import
-- ---------------------------------------------------------------------------
-- scripts/import-viabilidades.ts: minúsculas, sin acentos, partido por todo lo
-- que no sea letra o número, y solo palabras de 3+ letras ("de", "la" no cuentan).
create or replace function viab_tokens(p text) returns text[]
language sql immutable strict set search_path = public as $$
  select coalesce(array_agg(distinct t), '{}'::text[])
  from unnest(regexp_split_to_array(
         translate(lower(p), 'áéíóúüñàèìòùâêîôûäëïöç', 'aeiouunaeiouaeiouaeioc'),
         '[^a-z0-9]+')) as t
  where length(t) > 2
$$;

comment on function viab_tokens(text) is
  'Palabras comparables de un nombre de paciente (minúsculas, sin acentos, 3+ letras). Mismo criterio que scripts/import-viabilidades.ts.';

-- ---------------------------------------------------------------------------
-- 2. El cruce
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
    update opportunities
       set stage = 'ganada', case_id = r.case_id
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
  'Viabilidades abiertas cuyo paciente ya entró como caso de primera etapa del mismo doctor: pasan a ganada con case_id, closed_at = ingreso del caso, y sus alertas se resuelven. La corre el sync de Noloco y pg_cron cada hora. Devuelve cuántas vinculó.';

revoke all on function viab_tokens(text) from public, anon;
grant execute on function viab_tokens(text) to authenticated, service_role;
revoke all on function vincular_viabilidades() from public, anon;
grant execute on function vincular_viabilidades() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. La red: cada hora, cinco minutos después del sync de las horas pares
-- ---------------------------------------------------------------------------
-- El sync de Vercel corre a las :00 de las horas pares y tarda 1-2 minutos;
-- el evaluador de alertas, a las :10. A las :05 el caso ya está y la alerta
-- de "viabilidad sin respuesta" todavía no se creó sobre una que ya convirtió.
do $$
begin
  perform cron.schedule('crm-viabilidades-vinculo', '5 * * * *',
                        'select vincular_viabilidades()');
exception when others then
  raise notice 'pg_cron no disponible (%). Programar vincular_viabilidades() manualmente.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Primera corrida y verificación
-- ---------------------------------------------------------------------------
do $$
declare v_vinc int; v_abiertas int; v_ganadas_sin_caso int;
begin
  -- las palabras se comparan como en el import: "Sandoval, Diana" y
  -- "Sandoval Diana" son la misma persona; las partículas y los acentos no cuentan
  if viab_tokens('Sandoval, Diana') <> array['diana','sandoval'] then
    raise exception '0057: viab_tokens no parte el nombre como el import (%)', viab_tokens('Sandoval, Diana');
  end if;
  if viab_tokens('José María Núñez de la O') <> array['jose','maria','nunez'] then
    raise exception '0057: viab_tokens no saca acentos o partículas (%)', viab_tokens('José María Núñez de la O');
  end if;

  v_vinc := vincular_viabilidades();

  select count(*) into v_abiertas from opportunities
   where stage not in ('ganada','perdida')
     and (viability_requested_at is not null or stage = 'viabilidad');
  select count(*) into v_ganadas_sin_caso from opportunities
   where stage = 'ganada' and case_id is null
     and (viability_requested_at is not null or lost_reason = 'Viabilidad no convertida');
  if v_ganadas_sin_caso > 0 then
    raise exception '0057: quedaron % viabilidades ganadas sin case_id', v_ganadas_sin_caso;
  end if;
  raise notice '0057 OK: % viabilidades vinculadas a su caso en la primera corrida; quedan % abiertas.',
    v_vinc, v_abiertas;
end $$;

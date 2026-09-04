-- 0054 — Las alertas de tareas que ya no existen.
--
-- LO QUE APARECIÓ. El CRM tiene 744 alertas abiertas. 660 son 'tarea_vencida'
-- y 656 de esas no tienen ninguna tarea vencida detrás: el 88% de todo lo que
-- el sistema está gritando es sobre trabajo que ya no existe. En /hoy eso se
-- ve así: la pantalla muestra 8 alertas de 744, y las 8 son del mismo tipo.
-- No hay lugar para nada más.
--
-- POR QUÉ SE DESINCRONIZÓ. La alerta es por DOCTOR y la tarea es por TAREA.
-- La regla (0047:220-238) crea una alerta por cada doctor que tenga al menos
-- una tarea vencida, y el índice de dedupe (0002:218-219) impide abrir una
-- segunda mientras esa siga abierta. Hasta ahí bien. Lo que no existe es el
-- camino de vuelta: ninguna rama cierra la alerta cuando la tarea se completa
-- o se cancela. Mientras las tareas se cerraban de a una no se notaba; el 26/8
-- se cancelaron 1.295 tareas muertas de un saque y quedaron 656 alertas
-- hablando de ellas.
--
-- 'descartada' y no 'resuelta': nadie resolvió nada. Dejaron de aplicar.
--
-- EL CRITERIO DE CIERRE ES EL MISMO DE LA CREACIÓN, palabra por palabra:
-- `t.status = 'pendiente' and t.due_date < current_date - days`, con el mismo
-- `days` de automation_rules.params. Esto no es prolijidad: si el que cierra
-- usara una fecha distinta del que crea —ai_mx_today() en vez de current_date,
-- por ejemplo— habría horas del día en las que uno cierra lo que el otro
-- acaba de crear, y tendríamos el mismo ping-pong que ya nos comimos con
-- dormido↔reactivado.
--
-- POR QUÉ NO VA ADENTRO DE evaluate_automations(). Porque son 354 líneas de
-- cadena elsif y esto no necesita entrar ahí: es un UPDATE que no depende de
-- ninguna otra rama. Va como función propia con su cron cinco minutos después
-- del evaluador, así el orden es siempre el mismo (primero crea, después
-- cierra) y se puede apagar sola sin tocar el resto.
--
-- Rollback: supabase/rollbacks/0054_alertas_de_tareas_que_ya_no_existen_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. La función
-- ---------------------------------------------------------------------------
create or replace function cerrar_alertas_huerfanas() returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_previo text;
  v_days int;
  v_count int;
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede cerrar alertas';
  end if;

  -- la llave se pide y se devuelve, como pide 0053: si esta función se llamara
  -- desde adentro de otra transacción, dejarla prendida abriría todos los guards
  v_previo := coalesce(current_setting('app.system', true), '');
  perform set_config('app.system', 'on', true);
  perform set_config('app.source', 'automation', true);

  select coalesce((params->>'days')::int, 3) into v_days
    from automation_rules where key = 'tarea_vencida';
  v_days := coalesce(v_days, 3);

  update alerts a
     set status = 'descartada', resolved_at = now()
   where a.rule_key = 'tarea_vencida'
     and a.status = 'abierta'
     and not exists (
       select 1 from tasks t
        where t.doctor_id = a.doctor_id
          and t.status = 'pendiente'
          and t.due_date < current_date - v_days
     );
  get diagnostics v_count = row_count;

  perform set_config('app.system', v_previo, true);
  return v_count;
end $fn$;

comment on function cerrar_alertas_huerfanas() is
  'Cierra las alertas de tarea vencida que ya no tienen ninguna tarea vencida detrás. Mismo criterio, mismo `days` y misma fecha que la regla que las crea, para que no se pisen.';

revoke all on function cerrar_alertas_huerfanas() from public, anon;
grant execute on function cerrar_alertas_huerfanas() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. La limpieza de una vez
-- ---------------------------------------------------------------------------
do $$
declare v_cerradas int;
begin
  v_cerradas := cerrar_alertas_huerfanas();
  raise notice '0054: % alertas huérfanas cerradas.', v_cerradas;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Que no vuelva a pasar
-- ---------------------------------------------------------------------------
-- minuto 15: cinco después del evaluador horario (0006:318, minuto 10). Primero
-- se crea lo que corresponde y recién después se cierra lo que sobró.
do $$
begin
  perform cron.schedule('crm-alertas-huerfanas', '15 * * * *',
                        'select cerrar_alertas_huerfanas()');
exception when others then
  raise notice 'pg_cron no disponible (%). Programar cerrar_alertas_huerfanas() manualmente.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Verificación
-- ---------------------------------------------------------------------------
do $$
declare v_abiertas int; v_huerfanas int; v_total int;
begin
  select count(*) into v_total from alerts where status = 'abierta';
  select count(*) into v_abiertas from alerts
   where rule_key = 'tarea_vencida' and status = 'abierta';
  select count(*) into v_huerfanas from alerts a
   where a.rule_key = 'tarea_vencida' and a.status = 'abierta'
     and not exists (select 1 from tasks t where t.doctor_id = a.doctor_id
                       and t.status = 'pendiente' and t.due_date < current_date - 3);
  raise notice '0054 OK: % alertas abiertas en total, % de tarea vencida, % sin respaldo (tiene que dar 0).',
    v_total, v_abiertas, v_huerfanas;
end $$;

-- 0030: los guards de alerts y ai_recommendations pasan a proteger POR DEFECTO.
--
-- EL PROBLEMA: los dos guards enumeraban lo PROHIBIDO. Funciona el día que se
-- escriben y se rompe solo, en silencio, cada vez que alguien agrega una columna.
-- Pasó dos veces:
--
--  * alerts — 0004 protegía `id` e `is_demo`; al reescribir el guard en 0022 para
--    sumar las columnas de impacto, esos dos quedaron afuera. Con la policy de
--    UPDATE abierta a todo no-VIEWER, cualquiera podía marcar una alerta como
--    is_demo=true por la API: desaparece de ai_service_issues y ai_data_quality
--    (las dos filtran `not is_demo`), o sea que los números de servicio que cita
--    el Director AI eran maquillables — y el próximo purge_demo() la borra.
--
--  * ai_recommendations — el guard de 0017 enumeraba hasta created_at. Después
--    0022 agregó reasoning_confidence, data_confidence y supporting_agents, y
--    0026 agregó bottleneck, owner_role, current_stage, expected_outcome,
--    follow_up_condition y routing_confidence. Ninguna migración actualizó el
--    guard: las nueve quedaron editables desde el cliente. Son justamente las
--    columnas sobre las que agrega el Director y las que van a alimentar la
--    blacklist, así que poder reescribirlas a mano vacía el análisis.
--
-- LA CORRECCIÓN: se invierte la lista. Se enumera lo EDITABLE y se compara el
-- resto de la fila como jsonb, que es el patrón que 0024 ya usa para cases y que
-- funcionó bien: toda columna que se agregue en el futuro nace protegida y hay
-- que habilitarla a propósito.
--
-- No cambia qué puede hacer la app: los campos de decisión siguen siendo los
-- mismos. Cambia qué pasa con lo que NO se declaró.
--
-- Idempotente: create or replace.

-- ---------------------------------------------------------------------------
-- 1. alerts — decisión humana e impacto; nada más
-- ---------------------------------------------------------------------------

create or replace function alerts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  editable text[] := array[
    -- decisión
    'status', 'resolved_by', 'resolved_at',
    -- calificación humana del impacto (0022)
    'service_confidence', 'trust_risk_score', 'impact_factors',
    'updated_at'
  ];
begin
  if is_system() then return new; end if;
  if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
    raise exception 'Solo se pueden actualizar estado e impacto de la alerta';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 2. ai_recommendations — solo el resultado de la decisión humana
-- ---------------------------------------------------------------------------

create or replace function ai_recommendations_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  editable text[] := array[
    -- decisión (0017)
    'status', 'decided_by', 'decided_at', 'dismiss_reason',
    'action_completed', 'executed_ref', 'outcome', 'resolved_at',
    -- cómo corrigió el humano a la IA (0026)
    'dismiss_code', 'human_edited', 'final_action'
  ];
begin
  if is_system() then return new; end if;
  if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
    raise exception
      'Las recomendaciones AI solo se deciden desde la app (aceptar/descartar/outcome)';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Autoverificación
-- ---------------------------------------------------------------------------
-- Se comprueba que las columnas que motivaron esta migración estén FUERA de la
-- lista de editables. Si alguien re-aplica 0022 o 0017 después de esto, los
-- guards vuelven a la versión enumerativa y esto lo delata en la próxima corrida.
do $$
declare
  def_alerts text := pg_get_functiondef('alerts_guard()'::regprocedure);
  def_recs   text := pg_get_functiondef('ai_recommendations_guard()'::regprocedure);
  col text;
begin
  if position('to_jsonb(new) - editable' in def_alerts) = 0
     or position('to_jsonb(new) - editable' in def_recs) = 0 then
    raise exception '0030 no quedó aplicada: los guards no usan el diff por jsonb';
  end if;
  -- is_demo en alerts y las 9 columnas de agente NO pueden ser editables
  if position('is_demo' in def_alerts) > 0 then
    raise exception '0030: is_demo no puede figurar como editable en alerts_guard';
  end if;
  foreach col in array array[
    'reasoning_confidence', 'data_confidence', 'supporting_agents', 'bottleneck',
    'owner_role', 'current_stage', 'expected_outcome', 'follow_up_condition',
    'routing_confidence'
  ] loop
    if position(col in def_recs) > 0 then
      raise exception '0030: % no puede figurar como editable en ai_recommendations_guard', col;
    end if;
  end loop;
end $$;

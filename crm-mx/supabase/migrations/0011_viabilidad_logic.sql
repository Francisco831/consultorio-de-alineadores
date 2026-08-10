-- 0011: lógica de la etapa Viabilidad (usa el valor creado en 0010)
create or replace function opportunities_transition() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    new.stage_entered_at = now();
    if new.stage = 'ganada' then
      new.closed_at = now();
      new.forecast_category = 'closed';
      new.probability = 100;
    elsif new.stage = 'perdida' then
      new.closed_at = now();
      new.forecast_category = 'omitted';
      new.probability = 0;
    end if;
  end if;
  -- probabilidad default por etapa si no viene seteada
  if new.probability is null then
    new.probability = case new.stage
      when 'viabilidad'         then 15
      when 'paciente_potencial' then 10
      when 'documentacion'      then 25
      when 'caso_ingresado'     then 40
      when 'planificacion'      then 50
      when 'presentada'         then 60
      when 'decision'           then 70
      when 'compromiso'         then 90
      when 'ganada'             then 100
      when 'perdida'            then 0
    end;
  end if;
  return new;
end $$;

-- una viabilidad sin respuesta en 10 días cuenta como estancada
update automation_rules
set params = jsonb_set(
  coalesce(params, '{}'::jsonb),
  '{expected_days,viabilidad}',
  '10'::jsonb
)
where key = 'oportunidad_estancada';

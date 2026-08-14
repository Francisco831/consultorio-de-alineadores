-- Rollback de 0029_hitl_ai_confirmado.sql.
--
-- OJO ANTES DE CORRERLO: esto REABRE el bug ALT-02. Vuelve a exigir origen
-- 'humano' en los dos guards, así que aceptar una recomendación de clasificación
-- desde la interfaz vuelve a fallar SIEMPRE, y —por el compare-and-set de
-- lib/actions/ai.ts— la recomendación queda quemada en estado 'aceptada', sin
-- ejecutar, sin poder reintentarse ni descartarse.
--
-- O sea: correr este rollback sin tocar también lib/actions/ai.ts deja el
-- circuito HITL roto para los dos tipos de recomendación que la capa AI más
-- produce hoy. Es un rollback de emergencia, no un camino de vuelta cómodo.
--
-- La alternativa sana, si hubiera que cortar el camino AI: dejar 0029 aplicada y
-- que la interfaz no ofrezca esas recomendaciones.

create or replace function cases_subject_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  editable text[] := array[
    'case_subject_type', 'case_subject_source', 'case_subject_set_by',
    'case_subject_set_at', 'updated_at'
  ];
begin
  if is_system() then return new; end if;

  if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
    raise exception
      'cases es espejo de Noloco: desde la app solo se clasifica el sujeto del caso';
  end if;

  if new.case_subject_type is distinct from old.case_subject_type
     or new.case_subject_source is distinct from old.case_subject_source
     or new.case_subject_set_by is distinct from old.case_subject_set_by then
    if new.case_subject_source is distinct from 'humano' then
      raise exception
        'La clasificación del sujeto del caso hecha desde la app es de origen humano';
    end if;
    if new.case_subject_set_by is distinct from auth.uid() then
      raise exception
        'La clasificación del sujeto del caso se atribuye a quien la hace';
    end if;
  end if;

  return new;
end $$;

create or replace function activities_engagement_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then return new; end if;

  if new.engagement_quality is distinct from old.engagement_quality
     or new.engagement_source  is distinct from old.engagement_source
     or new.engagement_set_by  is distinct from old.engagement_set_by then
    if new.engagement_source is distinct from 'humano' then
      raise exception
        'Clasificar una interacción desde la app deja origen humano (no import ni regla)';
    end if;
    if new.engagement_set_by is distinct from auth.uid() then
      raise exception 'La clasificación de la interacción se atribuye a quien la hace';
    end if;
  end if;

  return new;
end $$;

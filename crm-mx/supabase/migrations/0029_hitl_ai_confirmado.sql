-- 0029: aceptar una clasificación propuesta por la IA no puede fallar siempre.
--
-- EL BUG (ALT-02 de AUDITORIA_CRM.md, abierto desde el 9/8/2026)
--
-- El contrato HITL dice que la IA propone y un humano decide. Cuando el humano
-- aprieta Aceptar sobre una recomendación de clasificación, lib/actions/ai.ts
-- escribe con la SESIÓN DEL USUARIO:
--     case_subject_source = 'ai_confirmado'   (ai.ts:198)
--     engagement_source   = 'ai_confirmado'   (ai.ts:214)
-- y los guards de 0024 exigían literalmente 'humano', así que la excepción salta
-- SIEMPRE. Peor: acceptRecommendation reclama la fila con un compare-and-set
-- ANTES de ejecutar el payload —correcto para que dos clicks no ejecuten dos
-- veces— así que al fallar la recomendación queda en 'aceptada' terminal: no se
-- puede reintentar (el reintento exige status='propuesta') ni descartar.
--
-- El propio schema ya decía que 'ai_confirmado' era válido: los CHECK de 0022
-- (`cases_subject_source_check`, `activities_engagement_source_check`) lo
-- aceptan desde el día uno. El conflicto era trigger contra check, no una
-- restricción de dominio.
--
-- QUÉ CAMBIA
--
-- La regla de 0024 era "desde la app, origen humano". Se mantiene la intención y
-- se corrige la implementación: lo que 0024 quería impedir es que un cliente se
-- haga pasar por el sistema, no que un humano confirme una propuesta de la IA.
--
--   'humano'        → alguien lo tipeó en /calidad
--   'ai_confirmado' → la IA lo propuso y un humano hizo click en Aceptar
--
-- Las dos tienen una persona detrás y las dos se atribuyen a `auth.uid()`, que es
-- el chequeo que de verdad protege la autoría y NO se toca. 'import' y 'regla'
-- siguen siendo exclusivas del sistema (is_system()).
--
-- El allowlist pasa a ser POSITIVO —se enumera lo permitido en vez de rechazar un
-- valor— así que un valor nuevo en el CHECK de una migración futura nace
-- prohibido desde la app hasta que alguien lo habilite a propósito.
--
-- Criterio de cierre: `npm run test:seguridad`, chequeo 5, de PENDIENTE a OK.
-- Idempotente: create or replace.

-- ---------------------------------------------------------------------------
-- 1. cases
-- ---------------------------------------------------------------------------

create or replace function cases_subject_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  -- columnas que la app SÍ puede tocar (updated_at lo pone set_updated_at)
  editable text[] := array[
    'case_subject_type', 'case_subject_source', 'case_subject_set_by',
    'case_subject_set_at', 'updated_at'
  ];
  -- procedencias con una persona detrás; el resto es del sistema
  humanas text[] := array['humano', 'ai_confirmado'];
begin
  if is_system() then return new; end if;

  -- comparar el resto de la fila como jsonb cubre también las columnas que
  -- Noloco agregue en el futuro: por defecto quedan protegidas.
  if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
    raise exception
      'cases es espejo de Noloco: desde la app solo se clasifica el sujeto del caso';
  end if;

  if new.case_subject_type is distinct from old.case_subject_type
     or new.case_subject_source is distinct from old.case_subject_source
     or new.case_subject_set_by is distinct from old.case_subject_set_by then
    if new.case_subject_source is null or not (new.case_subject_source = any(humanas)) then
      raise exception
        'La clasificación del sujeto del caso hecha desde la app la decide una persona: '
        'humano (la tipeó) o ai_confirmado (la propuso la IA y alguien la aceptó)';
    end if;
    if new.case_subject_set_by is distinct from auth.uid() then
      raise exception
        'La clasificación del sujeto del caso se atribuye a quien la hace';
    end if;
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 2. activities
-- ---------------------------------------------------------------------------

create or replace function activities_engagement_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  humanas text[] := array['humano', 'ai_confirmado'];
begin
  if is_system() then return new; end if;

  if new.engagement_quality is distinct from old.engagement_quality
     or new.engagement_source  is distinct from old.engagement_source
     or new.engagement_set_by  is distinct from old.engagement_set_by then
    if new.engagement_source is null or not (new.engagement_source = any(humanas)) then
      raise exception
        'Clasificar una interacción desde la app la decide una persona: humano o '
        'ai_confirmado (no import ni regla, que son del sistema)';
    end if;
    if new.engagement_set_by is distinct from auth.uid() then
      raise exception 'La clasificación de la interacción se atribuye a quien la hace';
    end if;
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Autoverificación (mismo criterio que 0027: la migración se prueba a sí misma)
-- ---------------------------------------------------------------------------
-- No se puede ejercitar el guard acá adentro: sin JWT `auth.uid()` es null, o sea
-- is_system() = true, y el trigger devuelve new antes de mirar nada. Lo que sí se
-- verifica es que el texto vigente de las dos funciones contenga el allowlist —
-- si alguien re-aplica 0024 después de esta migración, el guard vuelve atrás en
-- silencio y esto lo delata. La prueba de comportamiento es el chequeo 5 de
-- scripts/security-checks.ts, con transacciones revertidas y un rol real.
do $$
declare
  falta text[] := array[]::text[];
begin
  if position('ai_confirmado' in pg_get_functiondef('cases_subject_guard()'::regprocedure)) = 0 then
    falta := falta || 'cases_subject_guard';
  end if;
  if position('ai_confirmado' in pg_get_functiondef('activities_engagement_guard()'::regprocedure)) = 0 then
    falta := falta || 'activities_engagement_guard';
  end if;
  if array_length(falta, 1) is not null then
    raise exception '0029 no quedó aplicada en: %', array_to_string(falta, ', ');
  end if;
end $$;

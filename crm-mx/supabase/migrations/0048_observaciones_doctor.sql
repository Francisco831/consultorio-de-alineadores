-- 0048 — Observaciones libres del doctor: los "datos de colores" del brief.
--
-- Pedido de Pancho el 26/8: el brief previo a la llamada tenía que incluir
-- "datos de colores, de los cuales puedan salir de observaciones o bien se pueda
-- completar a mano". Eso último no existía: no hay ningún campo donde Rocío o
-- Juan puedan escribir lo que quieran de un doctor.
--
-- POR QUÉ NO SIRVE NINGUNO DE LOS QUE YA ESTÁN:
--   · `why_interesting` (3.264 fichas cargadas) responde otra pregunta —por qué
--     ESTE prospecto vale la pena— y la llenó un import, no una persona. Pisarla
--     con notas de relación borraría el criterio de captación.
--   · `doctor_ai_profile` (0017) es la memoria cualitativa de la capa AI y su
--     `last_source` solo acepta 'humano' o 'ai_confirmado': tiene su propio
--     circuito de confirmación, no es una libreta.
--   · `tags` es un canal semántico (sigue-instagram, ig-alt:…), no texto libre.
--   · `custom` jsonb existe pero exige registrar el campo en custom_field_defs
--     para que se vea: más ceremonia que valor para una nota suelta.
--
-- Una columna de texto y listo. La escribe una persona, la lee una persona, y el
-- brief la usa como PRIMERA opción para abrir la llamada: lo que alguien se tomó
-- el trabajo de anotar a mano gana sobre cualquier regla que deduzca el sistema.
--
-- Rollback: supabase/rollbacks/0048_observaciones_doctor_rollback.sql

alter table doctors
  add column if not exists observaciones text;

comment on column doctors.observaciones is
  'Notas libres sobre el doctor, escritas a mano por el equipo comercial. Es lo primero que usa el brief previo a la llamada (lib/brief-doctor.ts). NO la escribe ningún import ni la capa AI: si tiene algo, lo puso una persona.';

-- El guard de doctors (0019) es una lista explícita de columnas protegidas
-- (scores, universo, campos de manager). Una columna nueva no está en ninguna,
-- así que queda escribible por cualquier rol que no sea VIEWER, que es lo que
-- se quiere. Verificado acá para que el día que el guard cambie, salte:
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'doctors' and column_name = 'observaciones'
  ) then
    raise exception '0048: la columna observaciones no quedó creada';
  end if;
  raise notice '0048 OK: doctors.observaciones lista para el brief.';
end $$;

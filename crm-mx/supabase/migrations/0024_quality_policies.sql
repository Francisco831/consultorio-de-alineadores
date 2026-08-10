-- 0024: la revisión humana de calidad de datos necesita poder escribir.
--
-- 0022 agregó las columnas de clasificación (cases.case_subject_*,
-- activities.engagement_*) pero NO el permiso para cargarlas desde la app:
--  * `cases` es espejo de Noloco y en 0004 quedó sin policy de escritura para
--    clientes (solo service-role importa). La clasificación del sujeto del caso
--    NO es dato de Noloco: es criterio humano del CRM. Se abre UPDATE para
--    no-VIEWER y un guard trigger limita el cambio a las cuatro columnas
--    case_subject_* — cualquier otra columna del espejo sigue siendo intocable.
--  * `activities` ya tenía UPDATE para no-VIEWER (0004). Lo que faltaba era
--    garantizar la PROCEDENCIA: que nadie pueda marcar una interacción como
--    clasificada por otra persona o como si viniera de un import.
--
-- Regla de esta migración: la app puede decir QUÉ es un caso, nunca reescribir
-- el espejo; y la atribución de quién clasificó la pone la base, no el cliente.
--
-- Idempotente (no hay ledger de migraciones): drop if exists / or replace.

-- ---------------------------------------------------------------------------
-- 1. cases: UPDATE acotado a la clasificación del sujeto
-- ---------------------------------------------------------------------------

drop policy if exists cases_update_subject on cases;
create policy cases_update_subject on cases
  for update to authenticated using (can_write()) with check (can_write());

create or replace function cases_subject_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  -- columnas que la app SÍ puede tocar (updated_at lo pone set_updated_at)
  editable text[] := array[
    'case_subject_type', 'case_subject_source', 'case_subject_set_by',
    'case_subject_set_at', 'updated_at'
  ];
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

drop trigger if exists cases_subject_guard_trg on cases;
create trigger cases_subject_guard_trg
  before update on cases
  for each row execute function cases_subject_guard();

-- ---------------------------------------------------------------------------
-- 2. activities: procedencia real de la clasificación de contacto
-- ---------------------------------------------------------------------------

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

drop trigger if exists activities_engagement_guard_trg on activities;
create trigger activities_engagement_guard_trg
  before update on activities
  for each row execute function activities_engagement_guard();

-- ---------------------------------------------------------------------------
-- 3. Cola de revisión de casos, priorizada por parecido de nombre
-- ---------------------------------------------------------------------------
-- case_self_similarity() es por caso: pedirla fila por fila desde la app serían
-- ~1.000 llamadas. Esta función la aplica del lado de la base y devuelve la cola
-- ya ordenada. NO clasifica nada: el parecido solo decide qué mira primero el
-- humano (un caso a nombre del propio doctor es candidato a ser su caso propio).

create or replace function case_subject_review_queue(p_limit int default 50)
returns table (
  case_id uuid,
  doctor_id uuid,
  doctor_nombre text,
  paciente text,
  case_label text,
  etapa text,
  fecha_ingreso timestamptz,
  is_new_case boolean,
  similarity real
)
language sql stable security invoker set search_path = public as $$
  select *
  from (
    select c.id,
           c.doctor_id,
           d.nombre,
           c.paciente,
           coalesce(c.id_externo, c.noloco_case_id),
           c.etapa,
           c.fecha_ingreso,
           c.is_new_case,
           case_self_similarity(c.id)
    from cases c
    join doctors d on d.id = c.doctor_id
    where c.is_demo = false
      and c.case_subject_type = 'UNKNOWN'
      and c.case_subject_source is null
  ) q(case_id, doctor_id, doctor_nombre, paciente, case_label, etapa,
      fecha_ingreso, is_new_case, similarity)
  order by q.similarity desc nulls last, q.fecha_ingreso desc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
$$;

comment on function case_subject_review_queue(int) is
  'Cola humana de clasificación de casos, ordenada por parecido entre el nombre '
  'del paciente y el del doctor. Prioriza la revisión; nunca decide.';

revoke execute on function case_subject_review_queue(int) from public, anon;
grant execute on function case_subject_review_queue(int) to authenticated, service_role;

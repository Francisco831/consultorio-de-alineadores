-- Rollback de 0061. Saca los índices del buscador, el check de formato y la
-- función de etiquetas en uso, y vuelve tasks_audit() a la versión de 0003
-- (solo audita status). Las etiquetas que el equipo haya cargado desde la
-- ficha se DEJAN: son datos, no schema. La app sin tags_en_uso() sigue andando
-- (el filtro por etiqueta muestra la lista vacía y acepta la etiqueta tipeada).

drop index if exists activities_summary_trgm_idx;
drop index if exists activities_outcome_trgm_idx;
drop index if exists doctors_observaciones_trgm_idx;
drop index if exists tasks_title_trgm_idx;

create or replace function tasks_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    perform log_audit('task', new.id, 'status', old.status::text, new.status::text);
  end if;
  return new;
end $$;
revoke all on function tasks_audit() from public, anon;

alter table doctors drop constraint if exists doctors_tags_formato;
drop function if exists etiquetas_validas(text[]);

drop function if exists tags_en_uso(boolean);

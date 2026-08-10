-- 0018: ROI por evento (curso / congreso / meeting) — agregación en la DB.
--
-- Con 6.4k doctores no se puede traer la tabla al cliente para agrupar en JS
-- (PostgREST capea en 1000 filas sin avisar). Esta función devuelve una fila
-- por campaña ya agregada.
--
-- Un doctor queda ligado a un evento por DOS vías, según cómo entró:
--   - prospecto nuevo del import  → doctors.campaign_id
--   - doctor que YA era cliente   → tag 'evento:<slug del nombre de la campaña>'
-- Se deduplica el par (evento, doctor) ANTES de agregar: un doctor puede
-- matchear por las dos vías y contaría doble (y sum(distinct) sumaría valores
-- distintos, no doctores distintos).

create or replace function evento_roi()
returns table (
  evento text,
  fecha date,
  tipo text,
  contactos bigint,
  clientes bigint,
  acreditados_post bigint,
  activados bigint,
  casos bigint
)
language sql stable security definer set search_path = public as $$
  with ev as (
    select c.id,
           c.nombre,
           c.starts_on,
           c.tipo::text as tipo,
           'evento:' || left(regexp_replace(
             lower(translate(c.nombre, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU')),
             '[^a-z0-9]+', '-', 'g'), 40) as tag
    from campaigns c
  ),
  pares as (
    select distinct
           ev.nombre, ev.starts_on, ev.tipo,
           d.id, d.is_accredited, d.accredited_at, d.new_case_count
    from ev
    join doctors d
      on d.campaign_id = ev.id
      or d.tags && array[ev.tag]
  )
  select nombre,
         starts_on,
         tipo,
         count(*)                                        as contactos,
         count(*) filter (where is_accredited)           as clientes,
         -- atribuible al evento: se acreditó DESPUÉS de la fecha del evento.
         -- En los cursos la acreditación ocurre EN el evento (por eso da bajo);
         -- ahí el número que vale es "clientes".
         count(*) filter (where is_accredited
                            and starts_on is not null
                            and accredited_at > starts_on) as acreditados_post,
         count(*) filter (where new_case_count > 0)      as activados,
         coalesce(sum(new_case_count), 0)::bigint        as casos
  from pares
  group by nombre, starts_on, tipo
  order by count(*) desc
$$;

revoke execute on function evento_roi() from public, anon;
grant execute on function evento_roi() to authenticated, service_role;

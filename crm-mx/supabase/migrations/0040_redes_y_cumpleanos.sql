-- 0040 — Redes sociales y cumpleaños del doctor.
--
-- Pedido de Pancho (26/8): "habilitar para poner las redes de cada dr, mismo
-- fecha de cumpleaños, y en los inicios que salgan alertas de los cumpleaños y
-- si se cumplen años de que es acreditado nuestro".
--
-- Hoy solo existe `doctors.instagram` (0036) y es de SOLO LECTURA en la UI: no
-- hay formulario que la escriba. Esta migración agrega los campos que faltan y
-- la función que alimenta el bloque de avisos de /hoy.
--
-- El aniversario de acreditación sale de `accredited_at`, que ya existe y está
-- blindada contra escritura manual (0019: solo la escribe el trigger de journey
-- al mover el doctor a "Acreditado"). Acá solo se LEE.
--
-- Rollback: supabase/rollbacks/0040_redes_y_cumpleanos_rollback.sql

alter table doctors
  add column if not exists birth_date date,
  add column if not exists facebook text,
  add column if not exists tiktok   text,
  add column if not exists linkedin text,
  add column if not exists website  text;

comment on column doctors.birth_date is
  'Cumpleaños del doctor. Si no se sabe el año, cargar 1900: el aviso usa mes y día, y la edad queda en null.';
comment on column doctors.facebook is 'Usuario o URL de Facebook, como lo escriba quien carga.';
comment on column doctors.tiktok   is 'Handle de TikTok sin arroba.';
comment on column doctors.linkedin is 'Usuario o URL de LinkedIn.';
comment on column doctors.website  is 'Sitio web o link de la clínica (puede ser un linktree).';

-- birth_date no puede ser futura ni delirante
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'doctors_birth_date_rango') then
    alter table doctors add constraint doctors_birth_date_rango
      check (birth_date is null or (birth_date >= date '1900-01-01' and birth_date <= current_date));
  end if;
end $$;

create index if not exists doctors_birth_date_idx on doctors (birth_date) where birth_date is not null;
create index if not exists doctors_accredited_at_idx on doctors (accredited_at) where accredited_at is not null;

-- ---------------------------------------------------------------------------
-- Helper: la misma efeméride, en el año que se pida.
-- El 29/2 en año no bisiesto cae el 28 (si no, make_date levanta excepción).
-- ---------------------------------------------------------------------------
create or replace function efemeride_en(origen date, anio int) returns date
language sql immutable as $$
  select make_date(
    anio,
    extract(month from origen)::int,
    least(
      extract(day from origen)::int,
      extract(day from (
        date_trunc('month', make_date(anio, extract(month from origen)::int, 1))
        + interval '1 month - 1 day'
      ))::int
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Cumpleaños y aniversarios de acreditación en una ventana.
--
-- Se resuelve en SQL y no en el cliente porque "hoy" tiene que ser el día de
-- México (America/Mexico_City), igual que todo el resto del CRM (lib/dates.ts).
-- La ventana arranca AYER a propósito: si nadie entró el día del cumpleaños,
-- el aviso sigue estando al día siguiente en vez de desaparecer.
-- ---------------------------------------------------------------------------
create or replace function doctores_efemerides(dias_adelante int default 7)
returns table (
  doctor_id uuid,
  nombre text,
  tipo text,              -- 'cumple' | 'aniversario'
  fecha date,             -- la del año en curso (o la del que viene si ya pasó)
  dias int,               -- 0 = hoy, -1 = ayer, positivo = faltan
  anios int,              -- años que cumple; null si no se sabe el año de origen
  categoria doctor_categoria,
  city text,
  whatsapp text,
  phone text,
  instagram text,
  owner_id uuid
)
language sql stable security definer set search_path = public as $$
  with hoy as (select (now() at time zone 'America/Mexico_City')::date as d),
  candidatos as (
    select d.id, d.nombre, d.categoria, d.city, d.whatsapp, d.phone, d.instagram,
           d.owner_id, e.tipo, e.origen, h.d as hoy_mx
    from doctors d
    cross join hoy h
    cross join lateral (values
      ('cumple'::text, d.birth_date),
      ('aniversario'::text, case when d.is_accredited then d.accredited_at end)
    ) as e(tipo, origen)
    where not d.is_demo and e.origen is not null
  ),
  proyectados as (
    select c.*,
      case
        when efemeride_en(c.origen, extract(year from c.hoy_mx)::int) < c.hoy_mx - 1
          then efemeride_en(c.origen, extract(year from c.hoy_mx)::int + 1)
        else efemeride_en(c.origen, extract(year from c.hoy_mx)::int)
      end as fecha_proyectada
    from candidatos c
  )
  select p.id, p.nombre, p.tipo, p.fecha_proyectada,
         (p.fecha_proyectada - p.hoy_mx)::int,
         case when extract(year from p.origen) <= 1900 then null
              else (extract(year from p.fecha_proyectada) - extract(year from p.origen))::int
         end,
         p.categoria, p.city, p.whatsapp, p.phone, p.instagram, p.owner_id
  from proyectados p
  where p.fecha_proyectada between p.hoy_mx - 1 and p.hoy_mx + greatest(coalesce(dias_adelante, 7), 0)
  order by p.fecha_proyectada, p.nombre;
$$;

revoke all on function doctores_efemerides(int) from public, anon;
grant execute on function doctores_efemerides(int) to authenticated, service_role;
revoke all on function efemeride_en(date, int) from public, anon;
grant execute on function efemeride_en(date, int) to authenticated, service_role;

comment on function doctores_efemerides(int) is
  'Cumpleaños y aniversarios de acreditación entre ayer y +N días, con el día de hoy en hora de México. La usa el bloque "Fechas para saludar" de /hoy.';

do $$
declare n int; m int;
begin
  select count(*) into n from doctores_efemerides(365);
  select count(*) into m from doctores_efemerides(7);
  raise notice '0040 OK: redes + cumpleaños. Efemérides a 365 días: %, en los próximos 7: %', n, m;
end $$;

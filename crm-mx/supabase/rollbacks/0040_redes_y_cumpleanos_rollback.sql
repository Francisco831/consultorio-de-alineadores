-- Rollback de 0040_redes_y_cumpleanos.sql
drop function if exists doctores_efemerides(int);
drop function if exists efemeride_en(date, int);
drop index if exists doctors_birth_date_idx;
drop index if exists doctors_accredited_at_idx;
alter table doctors drop constraint if exists doctors_birth_date_rango;
alter table doctors
  drop column if exists birth_date,
  drop column if exists facebook,
  drop column if exists tiktok,
  drop column if exists linkedin,
  drop column if exists website;

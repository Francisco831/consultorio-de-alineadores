-- 0032: recalcular al cruzar de área.
--
-- QUÉ ARREGLA. Los cinco recompute_doctor_trigger del proyecto están sobre las
-- tablas HIJAS —cases, activities, opportunities, tasks (0005:430-441) y payments
-- (0015:312)— y ninguno sobre `doctors`. O sea: el score se recalcula cuando pasa
-- algo ALREDEDOR del doctor, pero no cuando cambia el doctor mismo.
--
-- La consecuencia se ve el día del cruce. Un doctor que se acredita conserva
-- priority_bucket = 'nuevo_negocio' —la rama del universo A del score
-- (0019:206-209)— y sigue apareciendo en el bloque "Nuevos doctores — Todavía NO
-- acreditados" de /hoy, que agrupa por priority_bucket. Se queda del lado
-- equivocado hasta el recompute nocturno, o hasta que alguien le cargue una
-- actividad por casualidad.
--
-- Con las dos áreas separadas eso deja de ser un detalle: es un doctor visible en
-- el área que ya no le corresponde.
--
-- POR QUÉ NO SE MUERDE LA COLA. recompute_doctor escribe scores y etapas sobre
-- doctors (0019:602-637) pero NUNCA toca is_accredited, así que la cláusula WHEN
-- —que solo mira ese campo— corta la recursión en la segunda vuelta.
--
-- POR QUÉ NO LO FRENA EL GUARD. recompute_doctor hace set_config('app.system','on')
-- en su primera línea (0019:65) y doctors_guard deja pasar todo lo que viene del
-- sistema (0019:726-728).
--
-- NO CAMBIA NINGÚN DATO: solo recalcula lo que ya se recalcula por otras vías.

create or replace function doctors_recompute_al_cruzar() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  perform recompute_doctor(new.id);
  return null;
end $fn$;

revoke execute on function doctors_recompute_al_cruzar() from public, anon, authenticated;

drop trigger if exists doctors_cruce_recompute_trg on doctors;

-- AFTER, y con la condición en el WHEN y no adentro de la función: así Postgres ni
-- siquiera llama al trigger en los updates que no cruzan de área, que son casi todos.
create trigger doctors_cruce_recompute_trg
  after update on doctors
  for each row
  when (old.is_accredited is distinct from new.is_accredited)
  execute function doctors_recompute_al_cruzar();

comment on function doctors_recompute_al_cruzar() is
  'Recalcula el score de un doctor cuando cambia de área (is_accredited). Las dos áreas puntúan con fórmulas distintas, así que sin esto el doctor queda con el bucket del área anterior hasta el recompute nocturno.';

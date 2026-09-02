-- Rollback de 0053: el envoltorio del recálculo vuelve a la versión de 0005, que
-- deja `app.system` prendida hasta el final de la transacción.
--
-- OJO: correr esto reabre el agujero. Después de cualquier recálculo disparado
-- por trigger —registrar una actividad, mover una tarea— todos los guards del
-- CRM quedan abiertos para el resto de esa transacción.

create or replace function recompute_doctor_trigger() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_doctor uuid;
begin
  if tg_op = 'DELETE' then
    v_doctor := old.doctor_id;
  else
    v_doctor := new.doctor_id;
  end if;
  if v_doctor is not null then
    perform recompute_doctor(v_doctor);
  end if;
  return null;
end $fn$;

revoke execute on function recompute_doctor_trigger() from public, anon, authenticated;

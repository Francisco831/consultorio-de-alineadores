-- Rollback de 0032. Sacar el trigger devuelve el comportamiento anterior: el doctor
-- que cruza de área conserva el score del área vieja hasta el recompute nocturno.
-- No hay datos que restaurar — 0032 no escribe nada propio.
drop trigger if exists doctors_cruce_recompute_trg on doctors;
drop function if exists doctors_recompute_al_cruzar();

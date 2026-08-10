-- 0010: nueva primera etapa del pipeline — Viabilidad.
-- "Posible caso que el doctor está pensando si entra o no": el doctor manda
-- fotos/datos al grupo y Carlos Vera responde nivel (Medium, etc). Vive en
-- WhatsApp/intranet (sin API); acá se trackea como etapa pre-paciente_potencial.
-- (En transacción separada de 0011: un valor de enum nuevo no puede usarse
-- en la misma transacción que lo crea.)
alter type opp_stage add value if not exists 'viabilidad' before 'paciente_potencial';

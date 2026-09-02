-- Rollback de 0043_seguimiento_render_viabilidad.sql
-- Vuelve evaluate_automations() a la versión de 0020 y saca la regla nueva.
delete from automation_rules where key = 'viabilidad_sin_respuesta';
update automation_rules
   set params = '{"days": 7, "cutoff": "2026-06-01"}'::jsonb
 where key = 'aprobacion_pendiente';
-- Después de este rollback hay que reaplicar supabase/migrations/0020_tareas_acotadas.sql para restaurar evaluate_automations(). (Antes esto era un \echo de psql, que node-pg no entiende y hacía fallar el archivo entero.)

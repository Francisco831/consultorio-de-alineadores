-- Rollback de 0043_seguimiento_render_viabilidad.sql
-- Vuelve evaluate_automations() a la versión de 0020 y saca la regla nueva.
delete from automation_rules where key = 'viabilidad_sin_respuesta';
update automation_rules
   set params = '{"days": 7, "cutoff": "2026-06-01"}'::jsonb
 where key = 'aprobacion_pendiente';
\echo 'Reaplicar supabase/migrations/0020_tareas_acotadas.sql para restaurar evaluate_automations().'

-- Rollback de 0045_render_v2.sql
-- Saca el espejo de keepsmiling-v2. La pantalla vuelve al criterio viejo
-- (fecha_video sin fecha_aprobacion_video), con el 1/3 de falsos pendientes que
-- eso implica. Antes de correrlo, apagar el cron de /api/sync/render en
-- vercel.json: sin las columnas, la ruta responde error en cada corrida.
drop index if exists cases_render_esperando_idx;
alter table cases
  drop column if exists video_stage,
  drop column if exists video_sub_stage,
  drop column if exists video_estado,
  drop column if exists fecha_rechazado,
  drop column if exists video_v2_synced_at;

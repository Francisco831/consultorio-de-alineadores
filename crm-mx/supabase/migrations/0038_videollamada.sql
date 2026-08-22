-- 0038 — "videollamada" como tipo de tarea y de actividad.
--
-- El equipo MX trabaja mucho por videollamada y no había cómo registrarla:
-- caía disfrazada de "llamada" o "reunion". Mismo patrón que 0010/0014.
alter type task_type add value if not exists 'videollamada' after 'llamada';
alter type activity_type add value if not exists 'videollamada' after 'llamada';

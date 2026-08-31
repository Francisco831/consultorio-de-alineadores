# Alerta de rechazos → se mudó a ~/ks-alertas

`alerta_rechazos.py`, `fetch_datos.py` y `alerta_config.json` viven ahora en
`~/ks-alertas/` (con su propio `.env` y `alerta.log`).

Motivo: el LaunchAgent `com.keepsmiling.alerta-rechazos` corría desde acá pero
macOS (TCC) no deja a launchd leer Desktop/ → fallaba en silencio. Misma receta
que el tablero (`~/ks-tablero`). Mudanza: 21/8/26.

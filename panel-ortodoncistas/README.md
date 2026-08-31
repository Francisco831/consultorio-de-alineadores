# Panel Ortodoncistas

Panel por ortodoncista con datos en vivo de Noloco (keepsmiling-v2). Tres vistas: Equipo (Eugenia), Ortodoncista (individual), Doctoras (ranking por tasa de modificación).

## Actualizar datos y ver

```bash
python3 fetch_datos.py        # baja de Noloco → data.json (credenciales en ../tracer/.env)
python3 -m http.server 8095   # y abrir http://localhost:8095
```

Los casos con >90 días en el stage se muestran aparte como "viejos" (dato sin cerrar en Noloco, no trabajo real).

## Objetivos semanales

Editar `objetivos.json`: `default` aplica a todas, `porOrto` pisa por nombre completo (ej. `"Agustina Cercedo": 30`). El valor actual (20) es provisorio.

## Métricas de modificación (6 meses)

- **Tasa de modificación** = casos movidos que después tuvieron `fechaMovimientosAct` (re-trabajo, típico rechazo de video/render) ÷ casos movidos. Los meses recientes suben con el tiempo (la modificación llega semanas después del movimiento).
- **Modificaciones pedidas** = comunicaciones con motivo "modificaciones de video y/o renders". El detalle por caso (×n) y por mes está en el hover de cada doctora.
- **Vence** en "Casos a mover" = `fechaProcesoMovimientos` (fecha planificada del cronograma).
- **Rechazos de propuesta** (vista Equipo): cada rechazo es una comunicación de modificación; N rechazos ≈ N+1 propuestas en la intranet (la 1ª no genera comunicación). Ventana (30/60/90/180 días) y mínimo (1+/2+/3+) elegibles; checkbox "solo pedido no cumplido" (pieza repetida). Los rechazos sin texto cuentan y se marcan "s/texto". Debajo, tabla "Doctoras que más rechazan" en la misma ventana.
- **Botón WhatsApp** (🟢 junto a la doctora en rechazos, doctoras que más rechazan y colas de casos): link `wa.me` con mensaje pre-armado — abre el WhatsApp de la máquina donde se clickea (app de escritorio o Web), así cada ortodoncista escribe desde su propio número sin configurar nada. El mensaje nombra al **paciente** (campo `paciente` del caso; si falta, cae al id del caso). Teléfonos: campo `telefono` de la colección doctores en Noloco, normalizados por país en `fetch_datos.py` (`normalizar_telefono`); sin teléfono usable = sin botón.
- **Propuestas** (tabla de rechazos): conteo REAL por caso desde `keepsmilingPropuestasCollection` (campo denormalizado `cantPropuestaCaso`; puede diferir de rechazos+1 en ambos sentidos: doctoras que mandan 2 mensajes por rechazo, o propuestas regeneradas). "≈N" = estimado cuando el caso no tiene conteo. Badge "aprob. directa" = flag `aprobacionDirecta` de Noloco (hoy solo 7 doctoras, casi todas internas). Guion de comunicación para acreditados: `guion-acreditados-modificaciones.md`.
- **Filtro Desde/Hasta** (fechas exactas, excluyente con Mes) · con filtro de período los KPI de semana/mes se reemplazan por **"Movidos en la selección"** (los "esta semana / este mes" de siempre solo aplican sin filtro) · **auto-recarga** al volver a la pestaña si hay deploy nuevo (ETag de data.json, chequeo cada 5 min) · **Candidatas a aprobación directa** (pestaña Doctoras): 8+ casos, tasa ≤ ½ de la media, cero rechazos.
- **Casos con modificación** (vista Ortodoncista): tabla con el detalle de los casos que forman la tasa de modificación (caso, doctora, fecha del re-trabajo), respeta los filtros.

**OJO (21/8/26):** `fetch_datos.py` del panel fue restaurado acá después de la mudanza de la alerta a `~/ks-alertas/` (esa copia escribe su propio data.json y NO tiene teléfonos; son archivos independientes).

## Alarma Slack (2+ rechazos)

`alerta_rechazos.py` corre por launchd (9:30 y 14:30, `com.keepsmiling.alerta-rechazos`): detecta casos que llegan a un 2º+ rechazo de propuesta (solo los nuevos, estado en `alerta_estado.json`) y avisa al canal. **Activarla = pegar la Incoming Webhook URL en `alerta_config.json`.** Log en `alerta.log`.

## Versión online (Eugenia)

**https://panel-ortodoncistas.vercel.app** — usuario `keepsmiling`, contraseña en `.password-panel` (proyecto Vercel `panel-ortodoncistas`, equipo crm-mexico). Se actualiza solo vía launchd (`com.keepsmiling.panel-refresco`, **cada hora a los :45**) **desde `~/ks-panel/`** (instalado 21/8/26; TCC no deja a launchd leer Desktop, misma receta que `~/ks-alertas`): `~/ks-panel/refresco.sh` baja datos con su propio `fetch_datos.py`/`.env` y deploya. **REGLA: el `index.html` canónico se edita ACÁ; después de cambiarlo, copiarlo a `~/ks-panel/` (`cp index.html middleware.js vercel.json objetivos.json ~/ks-panel/`) o el próximo cron pisa el deploy con la versión vieja.** Log: `~/ks-panel/refresco.log`. Redeploy manual desde acá: `npx vercel deploy --prod --yes --scope crm-mexico`. El `refresco_diario.sh` y el plist de este directorio quedaron obsoletos.

También hay Artifact privado (datos congelados 19/8): https://claude.ai/code/artifact/8bbe74ae-d91f-470a-b1aa-035e495823cb

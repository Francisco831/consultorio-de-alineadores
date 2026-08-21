# Mercado Pago vía API — cómo enchufarlo

El script [`scripts/mp-sync.ts`](../scripts/mp-sync.ts) trae los movimientos de
la cuenta de Mercado Pago directo de la API oficial (reporte de liberaciones),
sin exportar nada a mano. Carga `statement_lines` (el extracto CONFIRMA, no
duplica) y la conciliación se hace en la pantalla de siempre con "Sugerir".

## Crear el token (una vez por cuenta, lo hace Pancho)

1. Entrar a **mercadopago.com.mx** (o .com.ar para el consultorio) con la
   cuenta de la empresa → menú **Tus integraciones** (panel de desarrolladores,
   también en https://www.mercadopago.com.mx/developers/panel/app).
2. **Crear aplicación** — nombre p. ej. `finanzas-ks`. Tipo de solución: da
   igual (no se cobra nada con esto, solo se leen reportes).
3. Dentro de la app → **Credenciales de producción** → copiar el
   **Access Token** (empieza con `APP_USR-`).
4. Pegarlo en `finanzas/.env.local` (NUNCA en git):

   ```
   MP_ACCESS_TOKEN_MX="APP_USR-..."
   MP_ACCESS_TOKEN_AR="APP_USR-..."   # cuando toque el consultorio
   ```

> El token da acceso amplio a la cuenta (leer pagos, crear cobros). Vive solo
> en `.env.local` (chmod 600). Si se filtra, se regenera desde el mismo panel.

## Usar

```bash
npx tsx scripts/mp-sync.ts --empresa mx                  # dry-run del rango pendiente
npx tsx scripts/mp-sync.ts --empresa mx --apply          # carga en serio
npx tsx scripts/mp-sync.ts --empresa mx --desde 2026-08-01 --hasta 2026-08-21 --apply
```

- Rango `[desde, hasta)` — `hasta` excluido. Sin flags: desde el watermark del
  último sync ok (o el día 1 del mes) hasta hoy.
- Dedup doble: por `SOURCE_ID` contra lo ya importado a mano (PDF/CSV) y por
  clave de contenido — re-correr el mismo rango es no-op.
- Cada corrida queda en `sync_runs` (fuente `mp_api_mx` / `mp_api_ar`) y el
  archivo en `import_batches` con su sha256.

## Qué es el "reporte de liberaciones"

El reporte oficial de conciliación de MP: todo lo que afecta el saldo
disponible (cobros netos de comisión, retiros, devoluciones, bloqueos), en CSV
con `SOURCE_ID` por operación. Referencia:
https://www.mercadopago.com.ar/developers/es/docs/reports/released-money/api

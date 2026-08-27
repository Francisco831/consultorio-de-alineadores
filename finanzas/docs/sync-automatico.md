# El sync que corre solo (Vercel Cron)

Hasta el 27/8/26 la caja del consultorio entraba a la base únicamente cuando
corría una tarea programada de Claude **en la Mac de Pancho**: una vez por día,
a las 10:00, y sólo si la Mac estaba despierta. El 27/8 durmió hasta las 09:39 y
la tarea de las 08:30 nunca disparó — por eso `/ar/movimientos` "no se
actualizaba". La página no cachea nada (se renderiza en vivo en cada visita);
el que no corría era el que llena la base.

Desde entonces eso corre en Vercel:

| Cron | Cuándo | Qué hace |
|---|---|---|
| `/api/cron/sync?paso=caja` | cada hora, en punto | Apps Script de la caja → ledger AR |
| `/api/cron/sync?paso=mp` | cada 3 horas, y :20 | Mercado Pago AR y MX → `statement_lines` |

Está declarado en [`vercel.json`](../vercel.json). La ruta es
[`app/api/cron/sync/route.ts`](../app/api/cron/sync/route.ts).

## Variables que tiene que tener el proyecto en Vercel

Sin estas, el paso se **saltea** (no falla, lo dice en la respuesta):

| Variable | Para qué | Dónde sacarla |
|---|---|---|
| `CRON_SECRET` | Vercel la manda como `Authorization: Bearer …`. Sin ella la ruta devuelve 401 | inventarla (32+ caracteres); está también en `.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | escribir en el ledger | panel de Supabase |
| `CAJA_AR_URL` / `CAJA_AR_SECRET` | leer la caja del consultorio | el deploy del Apps Script (`scripts/gas-caja-ar.gs`) |
| `MP_ACCESS_TOKEN_AR` | Mercado Pago del consultorio | [docs/mercadopago-api.md](mercadopago-api.md) |
| `MP_ACCESS_TOKEN_MX` | Mercado Pago de KS México | ídem |

> El token de MP y la service-role key dan acceso amplio: van como variables de
> entorno del proyecto en Vercel (encriptadas), **nunca** en git.

## Qué pasa si algo sale mal

Cada corrida queda en `sync_runs`, y la app muestra en alertas cuándo se
sincronizó por última vez cada fuente (ver [`lib/alertas-sync.ts`](../lib/alertas-sync.ts)).
Los dos gates de la caja abortan **antes** de escribir:

- **regresión**: un mes ya cerrado no puede achicarse. Si Claudia borra filas
  viejas, la corrida se marca en rojo y la base no se toca.
- **desaparecidos**: más de 15 filas que ya no están en la caja no es una
  edición puntual, es un problema de la fuente.

Después de escribir corre el **gate de totales**: la base tiene que quedar
idéntica a la caja mes a mes y moneda por moneda, o la corrida es un error.

La respuesta de la ruta trae el detalle de cada paso, y queda en los logs de
Vercel (Deployments → Functions → `/api/cron/sync`).

## Probarlo a mano

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://finanzas-ks.vercel.app/api/cron/sync?paso=caja"
```

Ojo: el Apps Script tarda ~70 segundos en devolver la caja entera. Es normal.

## Lo que sigue corriendo en la Mac

`scripts/cron-sync-pagos.sh` y la tarea programada `sync-pagos-mx` siguen
haciendo la cadena de México (planilla de Juan → CRM → finanzas), las
cotizaciones del blue, el matcher y los comprobantes del Drive. Eso todavía
depende de que la Mac esté despierta. Re-correr la caja desde ahí no rompe nada
(el import es idempotente), pero ya no hace falta.

# Finanzas — KS México · Consultorio Argentina

Sistema de administración financiera de DOS empresas **totalmente separadas**
(nunca consolidadas): Keep Smiling México (MXN) y Consultorio Argentina
(ARS + USD). Histórico desde 01/01/2026.

Principios no negociables:

- **Un solo ledger** (`movements`): la plata entra y sale únicamente por ahí.
  Los módulos generan o aplican movimientos; jamás guardan montos propios.
- **Nada se consolida**: cada total es un bucket por moneda ("ARS X" + "US$ Y").
  No existe función de conversión en el código, a propósito.
- **Aislamiento en 3 capas**: FKs compuestas `(id, company_id)` (físico),
  RLS por membresía (base), empresa en la URL `/mx/...` `/ar/...` (app).
- **Transferencia interna ≠ ingreso/gasto** (par de filas vía `create_transfer`).
- La plata **no se borra**: `void` auditado, nunca DELETE.
- Movimientos importados/sincronizados: los montos se corrigen **en la fuente**.

## Estado (20/8/2026) — el MVP completo, andando con datos reales

Base creada y sembrada en `kgkzbjqxuvdfxxtjowej` (us-west-2), 15 migraciones:

- **Etapa 1**: 878 movimientos AR + 174 ingresos MX con sus gates en verde,
  298 líneas de extracto y 265 sugerencias de conciliación.
- **Etapa 2**: nómina real de marzo y abril (costo laboral idéntico a la
  planilla), 18 precios de lista KS, y **35 liquidaciones de doctoras calculadas
  con Δ$0 contra `build_liquidaciones.py`**. Cuentas por pagar, por cobrar e
  impuestos quedan listas y vacías: se cargan con datos ciertos.

- **Etapa 3**: proveedores con ranking (14,4M gastados en 2026, el top 5 es el 92%),
  compras con detalle de productos e historial de precios, costos del consultorio
  (fijos vs variables) y costos de producción de México, y cash flow proyectado
  que descuenta los gastos fijos que vienen.
- **Cierre del MVP**: alertas automáticas en el dashboard, calendario financiero
  con lo que entra y sale cada día, presupuesto contra real, reportes en CSV y
  búsqueda global con ⌘K (busca también por monto exacto).

Camino crítico verificado de punta a punta: confirmar una liquidación la manda a
"Por pagar", pagarla genera el egreso en la cuenta y la saca de la bandeja.

**Vercel** (cuando quieras deployar): proyecto nuevo con Root Directory `finanzas`.

## Levantar la base desde cero (si algún día hay que rehacerla)

```bash
npx tsx scripts/db-migrate.ts --check-connection   # ¿hablo con la base correcta?
npx tsx scripts/db-migrate.ts --dry-run            # valida sin escribir
npx tsx scripts/db-migrate.ts --apply              # aplica 0000–0009
```

Seeds (cada uno: primero sin flags = dry-run, después `--apply`):

```bash
npx tsx scripts/seed-base.ts --apply               # empresas, cuentas, categorías
npx tsx scripts/import-movimientos-ar.ts --apply   # 877 movimientos AR (gate por mes)
npx tsx scripts/import-payments-mx.ts --apply      # 174 ingresos MX (gate Δ$0)
npx tsx scripts/import-extractos-ar.ts --apply     # líneas Macro + BBVA USD + MP
npx tsx scripts/conciliar-inicial.ts --apply      # corre el matcher y puebla la cola
```

Los gates son duros: si un total mensual difiere en un centavo de la fuente,
el script sale con error. No usar números que no pasaron el gate.

## Desarrollo

```bash
npm run dev              # servidor local (puerto 3020)
npm run typecheck        # next typegen && tsc
npm test                 # módulos puros + runner de migraciones (75 tests)
npm run test:aislamiento  # que la separación entre empresas la imponga la BASE
npm run build
```

`test:aislamiento` crea un usuario ficticio con membresía en una sola empresa y
verifica que no pueda ver ni escribir nada de la otra. Corre dentro de una
transacción que se revierte: no deja rastro. Correrlo después de tocar RLS.

## Estructura

- `supabase/migrations/` — 0000 ledger · 0001 enums · 0002 empresas+RLS helpers ·
  0003 catálogos · 0004 movements + create_transfer · 0005 audit+documents+guard ·
  0006 import/conciliación + void_movement · 0007 RLS · 0008 revokes · 0009 vistas ·
  **0010 grants por rol** · 0011 por cobrar (+aging) · 0012 por pagar/impuestos
  (+`pay_payable`) · 0013 sueldos y liquidaciones · 0014 RLS de la Etapa 2 ·
  0015 líneas agrupadas del matcher · 0016 compras/productos/precios/costos ·
  0017 cash flow con recurrentes.

  Sobre la 0010: en este proyecto una tabla nueva **nace sin DML** para los roles
  de la API (ACL por defecto `{TRUNCATE,REFERENCES,TRIGGER}`). Sin grants
  explícitos los seeds fallan con "permission denied" y la app ve la base vacía.
  La 0010 los otorga y además fija `alter default privileges` para que las tablas
  de las Etapas 2 y 3 nazcan bien.
- `scripts/db-migrate.ts` — runner con checksum y guard de destino (heredado del CRM;
  producción exige confirmación escrita SIEMPRE). Migrar en 3 pasos:
  `--print-target` → `--dry-run` → `--apply`.
- `lib/import/` — normalización (medios de pago, montos, fechas DD/MM), parser Macro
  (sobrevive columnas corridas), claves de idempotencia con ordinal intra-día.
- `lib/conciliacion/matcher.ts` — port del motor de `consultorio-gestion/conciliar_mp.py`
  (5 pasadas, fuzzy Dice ≥0.8).
- `seed-data/` — datasets fuente versionados (los originales viven fuera de git).

## Datos y fuentes de verdad

| Dato | Fuente | Regla |
|---|---|---|
| Ingresos MX | Ledger del CRM (planilla Administración MX) | `external_key` compartida: el sync nunca duplica. Correcciones EN el CRM. |
| Caja AR | Sheet vivo de la caja (doctoras/secretaria) | La app importa; el Sheet sigue vivo. |
| Extractos | Macro xlsx · BBVA (via GyG) · MP | Confirman movimientos, no los duplican. |
| Saldos | `v_account_balances` (solo `confirmed`) | Pendientes visibles, nunca sumados como caja real. |

## Roadmap

Etapa 2: CxC (pacientes/planes/cuotas), CxP + recurrentes, impuestos + calendario
fiscal, sueldos, liquidaciones profesionales 40%. Etapa 3: compras con líneas de
producto + historial de precios, costos (producción MX / consultorio AR), cash flow,
presupuesto, alertas, reportes. Etapa 4: sync CRM automático, API MP, OCR, IA.

## Por qué las cuentas por cobrar nacen vacías

El histórico arranca el 1/1/2026 y solo el 9% de los cobros dice a qué cuota
pertenece. De ese 9%, no se puede saber si las cuotas anteriores se pagaron en
2025 —fuera del dataset— o están impagas: "Garat pagó la cuota 6 de 6" no
significa que deba las cinco primeras. Reconstruirlo habría cargado unos
**$94.000.000 de deuda que no existe**. El módulo quedó construido y se puebla
con datos ciertos: cada tratamiento que cargues en cuotas genera sus vencimientos.

## Liquidaciones de profesionales

`scripts/liquidaciones.ts` recalcula el 40% desde el ledger y **compara contra la
salida de `consultorio-gestion/build_liquidaciones.py`**; sin Δ$0 no guarda nada.
Las 35 liquidaciones de enero a julio dieron idénticas. El costeo KS vive en
`lib/liquidaciones/costeo.ts` con tests de regresión de los casos que costaron
diferencias reales (cuotas partidas en dos pagos, "cuotas 3 y 4 de 4", dos cuotas
del mismo día y monto, etapa adicional sin costo).

Ojo: el resultado depende del ORDEN de las filas del registro original, por eso
cada movimiento sembrado guarda su número de fila en `meta.seq`
(`scripts/backfill-seq.ts`). Es una fragilidad heredada del método viejo; cargar
los planes de tratamiento explícitamente la elimina.

## Lo que reveló cruzar la caja contra el banco (20/8/2026)

Confirmado con datos: **Mercado Pago arranca el 28/4/2026** y el extracto de Banco
Macro se corta el **12/5** — el "borrón y cuenta nueva". Y 86 de las 100 líneas del
extracto de Macro cierran contra cobros que la caja anota como "Tr KS": son la
misma cuenta con dos nombres.

Tres hallazgos que la planilla sola no mostraba:

1. **No faltaba plata.** Las 8 líneas del banco que parecían no registradas eran
   pagos partidos: Badiola transfirió $400.000 + $234.000 el mismo día y la caja
   lo anotó como $634.000. Se agregó la pasada `lineas_agrupadas` al matcher
   (N líneas de extracto → 1 cobro) y quedaron 7 de las 8 conciliadas solas.

2. **$8.955.239 salieron por Mercado Pago sin pasar por la caja** (junio y julio):
   alquiler $1.810.800 mensual, expensas $943.850, y **$4.534.789 de retiros de
   las doctoras**. Se registraron con `scripts/registrar-egresos-mp.ts`, cada uno
   conciliado con su línea de extracto.

3. **Las liquidaciones de julio estaban infladas.** Como esos retiros no estaban
   en la caja, el sistema —y el script viejo— mostraban "retiros $0". Con los
   retiros reales, cuatro doctoras quedan en saldo negativo (retiraron de más) y
   lo que hay que pagar en julio baja de $4,36M a $1,97M.

Por eso `scripts/liquidaciones.ts` ya no exige que los RETIROS coincidan con
`build_liquidaciones.py`: ese script solo mira la caja y no puede verlos. Los
reporta aparte como corrección. Todo lo demás (cobrado, costo KS, liquidación)
sigue exigiendo Δ$0 y da idéntico en las 35 liquidaciones.

### Pendiente de revisar

Quedan **$6,4M cobrados como "Tr KS" después del 12/5** (8 cobros de junio y
julio: Badiola, Evelin Herrera, Lázaro, Ancora) sin extracto que los respalde,
porque los extractos de Macro terminan ahí. Hay que conseguir los extractos de
junio y julio, o confirmar a qué cuenta entraron.

## Dos módulos que nacen vacíos y por qué

**Compras con detalle** y **costos de producción de México** arrancan sin datos, y
es la decisión correcta:

- No existe un histórico de compras con detalle de productos. Inventar líneas a
  partir de un total ("$800.000 a Dental X") daría un historial de precios falso.
  Se llena solo a partir de la primera compra que cargues: al escribir un producto
  que ya compraste, el formulario te muestra el precio anterior y la variación.
- México no tiene un solo gasto cargado todavía, y **nadie sabe cuántos alineadores
  se producen por mes**: el CRM tiene casos, pero un caso no dice cuántos
  alineadores tiene. Ese número se carga a mano una vez por mes y el costo unitario
  sale del cruce con las categorías marcadas `cost_center='produccion_mx'`.

## Las alertas se calculan, no se guardan

`lib/alertas.ts` mira los datos en el momento de abrir la pantalla: no hay tabla
de alertas ni cron que las genere. Con este volumen son unas pocas consultas y
siempre dicen la verdad de ahora; una tabla habría que refrescarla y podría
quedar mintiendo hasta la próxima corrida.

Detecta: caja proyectada negativa, pagos y cobros vencidos, vencimientos de la
semana, gasto del mes disparado contra el promedio, concentración de un proveedor,
productos que aumentaron 15% o más, y el trabajo pendiente del propio sistema
(líneas sin conciliar, movimientos sin clasificar, liquidaciones sin confirmar).

Regla de redacción: cada alerta dice el número y adónde ir. "Tus gastos subieron"
no sirve; "el gasto de agosto va 34% arriba del promedio" sí.

## Exportar

`/api/export?empresa=ar&r=movimientos` devuelve CSV con la misma RLS que la app.
Reportes disponibles: `movimientos`, `proveedores`, `liquidaciones`, `precios`.
CSV y no xlsx a propósito: abre en Excel y en Sheets, y no arrastra una librería
de 3 MB al servidor. El BOM inicial es lo que hace que Excel muestre los acentos.

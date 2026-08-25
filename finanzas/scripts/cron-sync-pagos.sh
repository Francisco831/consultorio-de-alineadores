#!/bin/bash
# Corredor del sync de pagos MX en un solo comando.
# Cadena: planilla de Juan (Apps Script) → CRM (gates) → finanzas.
# Si hay token de MP configurado, también trae los movimientos de MP.
# Log: ~/Library/Logs/ks-sync-pagos.log
#
# La corrida programada diaria es una tarea de Claude (scheduled task
# "sync-pagos-mx", 10:00). NO va por launchd: macOS (TCC) le niega a los
# agentes launchd el acceso a Desktop/ — probado 21/8/26, mismo error que
# tiene silenciada a com.keepsmiling.alerta-rechazos desde que existe.
# Este .sh queda como corredor manual (./cron-sync-pagos.sh) o para launchd
# el día que se le dé Full Disk Access a bash en Ajustes del Sistema.
set -uo pipefail
export PATH="/Users/franciscobasilico/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin:/usr/local/bin"
REPO="/Users/franciscobasilico/dev/Periskope"
LOG="$HOME/Library/Logs/ks-sync-pagos.log"

echo "===== $(date '+%Y-%m-%d %H:%M:%S') sync pagos MX =====" >> "$LOG"

cd "$REPO/crm-mx" || exit 1
npx tsx scripts/sync-pagos-planilla.ts --cron --apply >> "$LOG" 2>&1
CRM_RC=$?
echo "-- planilla→CRM: exit $CRM_RC" >> "$LOG"

cd "$REPO/finanzas" || exit 1
if [ $CRM_RC -eq 0 ]; then
  npx tsx scripts/import-payments-mx.ts --apply --yes >> "$LOG" 2>&1
  echo "-- CRM→finanzas pagos: exit $?" >> "$LOG"
  npx tsx scripts/import-casos-mx.ts --apply --yes >> "$LOG" 2>&1
  echo "-- CRM→finanzas casos: exit $?" >> "$LOG"
else
  echo "-- CRM→finanzas: salteado (falló la etapa anterior)" >> "$LOG"
fi

# blue del día (Ámbito): sin la cotización de la fecha, un cobro en dólares
# frena el recálculo de liquidaciones — a propósito, para no pesificar a ojo
npx tsx scripts/sync-cotizaciones.ts --apply --yes >> "$LOG" 2>&1
echo "-- cotizaciones blue: exit $?" >> "$LOG"

# tipos de tratamiento desde Noloco (para el costo KS por paciente)
npx tsx scripts/tipos-tratamiento-noloco.ts --yes --apply >> "$LOG" 2>&1
echo "-- tipos Noloco: exit $?" >> "$LOG"

# sugerencias de conciliación para que la cola amanezca lista
npx tsx scripts/sugerir-matches.ts --empresa mx --yes --apply >> "$LOG" 2>&1
npx tsx scripts/sugerir-matches.ts --empresa ar --yes --apply >> "$LOG" 2>&1
echo "-- matcher: listo" >> "$LOG"

# caja del consultorio AR via Apps Script (si no esta instalado: exit 2, se saltea)
npx tsx scripts/sync-caja-ar.ts --apply >> "$LOG" 2>&1
CAJA_RC=$?
echo "-- caja AR: exit $CAJA_RC" >> "$LOG"
if [ $CAJA_RC -eq 0 ]; then
  npx tsx scripts/import-movimientos-ar.ts --apply --yes >> "$LOG" 2>&1
  echo "-- caja AR import: exit $?" >> "$LOG"
  # el import regenera meta y PISA meta.seq; sin esto, liquidaciones.ts se
  # frena con "cobros sin meta.seq" (el costeo depende del orden de la caja)
  npx tsx scripts/backfill-seq.ts --apply --yes >> "$LOG" 2>&1
  echo "-- caja AR seq: exit $?" >> "$LOG"
  npx tsx scripts/control-solicitud.ts --yes >> "$LOG" 2>&1
  echo "-- control solicitud: exit $?" >> "$LOG"
fi

# comprobantes AR del Drive -> pagos (con el inventario que haya; el refresco
# del inventario lo hace la tarea programada via MCP)
npx tsx scripts/vincular-comprobantes.ts --yes --apply >> "$LOG" 2>&1
echo "-- comprobantes AR: exit $?" >> "$LOG"

if grep -q '^MP_ACCESS_TOKEN_MX=' .env.local 2>/dev/null; then
  npx tsx scripts/mp-sync.ts --empresa mx --apply --yes >> "$LOG" 2>&1
  echo "-- MP api: exit $?" >> "$LOG"
else
  echo "-- MP api: sin token, salteado" >> "$LOG"
fi

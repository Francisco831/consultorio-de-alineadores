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
REPO="/Users/franciscobasilico/Desktop/Claude/Periskope"
LOG="$HOME/Library/Logs/ks-sync-pagos.log"

echo "===== $(date '+%Y-%m-%d %H:%M:%S') sync pagos MX =====" >> "$LOG"

cd "$REPO/crm-mx" || exit 1
npx tsx scripts/sync-pagos-planilla.ts --cron --apply >> "$LOG" 2>&1
CRM_RC=$?
echo "-- planilla→CRM: exit $CRM_RC" >> "$LOG"

cd "$REPO/finanzas" || exit 1
if [ $CRM_RC -eq 0 ]; then
  npx tsx scripts/import-payments-mx.ts --apply --yes >> "$LOG" 2>&1
  echo "-- CRM→finanzas: exit $?" >> "$LOG"
else
  echo "-- CRM→finanzas: salteado (falló la etapa anterior)" >> "$LOG"
fi

if grep -q '^MP_ACCESS_TOKEN_MX=' .env.local 2>/dev/null; then
  npx tsx scripts/mp-sync.ts --empresa mx --apply --yes >> "$LOG" 2>&1
  echo "-- MP api: exit $?" >> "$LOG"
else
  echo "-- MP api: sin token, salteado" >> "$LOG"
fi

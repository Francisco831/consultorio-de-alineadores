#!/bin/bash
# Refresco del panel: baja datos de Noloco y re-publica en Vercel.
export PATH="/Users/franciscobasilico/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/franciscobasilico/dev/Periskope/panel-ortodoncistas
echo "=== $(date) ==="
/usr/bin/python3 fetch_datos.py && npx vercel deploy --prod --yes --scope crm-mexico

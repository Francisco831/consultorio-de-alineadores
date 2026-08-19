#!/bin/bash
# Configura el sync automático Noloco→CRM en Vercel (una sola vez).
#
# Qué hace: genera CRON_SECRET, lee las credenciales Noloco de tracer/.env,
# carga las tres variables en Vercel (producción), guarda CRON_SECRET en
# .env.local, redespliega producción y prueba la ruta. Nada se imprime en claro.
#
# Correr desde crm-mx/:  bash scripts/configurar-sync-vercel.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"

if grep -q '^CRON_SECRET=' .env.local 2>/dev/null; then
  SECRET=$(grep '^CRON_SECRET=' .env.local | head -1 | cut -d= -f2-)
  echo "· CRON_SECRET ya existe en .env.local — se reusa"
else
  SECRET=$(openssl rand -hex 32)
  printf '\n# Sync Noloco: secreto del cron (/api/sync/noloco) — mismo valor cargado en Vercel prod\nCRON_SECRET=%s\n' "$SECRET" >> .env.local
  echo "· CRON_SECRET generado y guardado en .env.local"
fi

EMAIL=$(grep '^KEEPSMILING_EMAIL=' ../tracer/.env | cut -d= -f2-)
PASS=$(grep '^KEEPSMILING_PASSWORD=' ../tracer/.env | cut -d= -f2-)
[ -n "$EMAIL" ] && [ -n "$PASS" ] || { echo "ERROR: faltan credenciales en tracer/.env"; exit 1; }
IEMAIL=$(grep '^INTRANET_EMAIL=' ../tracer/.env | cut -d= -f2-)
IPASS=$(grep '^INTRANET_PASSWORD=' ../tracer/.env | cut -d= -f2-)

# Si la variable ya existe en Vercel, `env add` falla: se borra y recarga.
for VAR in CRON_SECRET KEEPSMILING_EMAIL KEEPSMILING_PASSWORD INTRANET_EMAIL INTRANET_PASSWORD; do
  npx vercel env rm "$VAR" production --yes >/dev/null 2>&1 || true
done
printf '%s' "$SECRET" | npx vercel env add CRON_SECRET production >/dev/null
printf '%s' "$EMAIL"  | npx vercel env add KEEPSMILING_EMAIL production >/dev/null
printf '%s' "$PASS"   | npx vercel env add KEEPSMILING_PASSWORD production >/dev/null
if [ -n "$IEMAIL" ] && [ -n "$IPASS" ]; then
  printf '%s' "$IEMAIL" | npx vercel env add INTRANET_EMAIL production >/dev/null
  printf '%s' "$IPASS"  | npx vercel env add INTRANET_PASSWORD production >/dev/null
  echo "· Credenciales del intranet cargadas (sync de contact points)"
else
  echo "· OJO: sin INTRANET_EMAIL/INTRANET_PASSWORD en tracer/.env — el cron de contact points va a saltearse"
fi
echo "· Variables cargadas en Vercel (production)"

echo "· Redesplegando producción para que tomen efecto…"
npx vercel redeploy https://crm-mx-puce.vercel.app 2>&1 | tail -2

echo "· Probando la ruta del sync (puede tardar 1-2 min)…"
HTTP=$(curl -s -o /tmp/sync-test.json -w '%{http_code}' --max-time 290 \
  -H "Authorization: Bearer $SECRET" https://crm-mx-puce.vercel.app/api/sync/noloco)
echo "  HTTP $HTTP"
python3 -c "import json;d=json.load(open('/tmp/sync-test.json'));print(json.dumps(d.get('resumen', d), indent=2, ensure_ascii=False)[:800])" 2>/dev/null || head -c 400 /tmp/sync-test.json
echo ""
echo "LISTO: el cron corre cada 2 horas. Para actualizar a mano:"
echo '  curl -H "Authorization: Bearer $(grep ^CRON_SECRET= .env.local | cut -d= -f2-)" https://crm-mx-puce.vercel.app/api/sync/noloco'

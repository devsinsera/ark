#!/usr/bin/env bash
# Build supabase-docker/.env from .env.example + /opt/sinsera-stack/secrets.env + LAN settings.
# Gateway on 54321 (8000 was taken by another container on Node 1). Run on Node 1.
set -euo pipefail
STACK=/opt/sinsera-stack
cd "$STACK/supabase-docker"
[ -f "$STACK/secrets.env" ] || { echo "create $STACK/secrets.env via gen-secrets.sh first" >&2; exit 1; }
cp .env.example .env; . "$STACK/secrets.env"
PORT=54321; URL="http://sinsera-core.local:$PORT"
for kv in "JWT_SECRET=$JWT_SECRET" "ANON_KEY=$ANON_KEY" "SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY" \
  "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" "SECRET_KEY_BASE=$SECRET_KEY_BASE" "VAULT_ENC_KEY=$VAULT_ENC_KEY" \
  "PG_META_CRYPTO_KEY=$PG_META_CRYPTO_KEY" "DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD" \
  "KONG_HTTP_PORT=$PORT" "API_EXTERNAL_URL=$URL" "SUPABASE_PUBLIC_URL=$URL" "SITE_URL=$URL"; do
  sed -i "s|^${kv%%=*}=.*|$kv|" .env
done
chmod 600 .env; echo "configured .env on port $PORT"

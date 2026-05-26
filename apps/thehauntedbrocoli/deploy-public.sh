#!/usr/bin/env bash
# Deploy the TheHauntedBrocoli launcher to sinsera.co/thehauntedbrocoli/
# via lftp. Reads FTP creds from /Ark/app/.env.local (same creds as the
# Ark deploy uses).
#
# Usage:  bash deploy-public.sh

set -euo pipefail
cd "$(dirname "$0")"

# Pull creds from app/.env.local (same gitignored file the Ark deploy reads)
ENV_FILE="$(cd ../.. && pwd)/app/.env.local"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${SINSERA_FTP_HOST:?SINSERA_FTP_HOST not set in app/.env.local}"
: "${SINSERA_FTP_USER:?SINSERA_FTP_USER not set in app/.env.local}"
: "${SINSERA_FTP_PASS:?SINSERA_FTP_PASS not set in app/.env.local}"

REMOTE_DIR="/thehauntedbrocoli"

echo "→ Mirroring public/ → ${SINSERA_FTP_HOST}:${REMOTE_DIR}"
lftp -c "
  set net:timeout 20
  set net:max-retries 2
  set ftp:ssl-allow false
  open -u '${SINSERA_FTP_USER}','${SINSERA_FTP_PASS}' '${SINSERA_FTP_HOST}'
  mkdir -p '${REMOTE_DIR}' 2>/dev/null
  mirror -R --delete --parallel=4 --exclude-glob '.DS_Store' \
    'public/' '${REMOTE_DIR}/'
"

echo "✓ Deployed."
echo "  Live at https://sinsera.co${REMOTE_DIR}/"

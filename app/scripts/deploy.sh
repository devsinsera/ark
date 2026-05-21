#!/usr/bin/env bash
# Ark deploy — builds + mirrors dist/ to HostGator /ark via lftp.
# Reads FTP creds from .env.local (gitignored).

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${SINSERA_FTP_HOST:?SINSERA_FTP_HOST not set in .env.local}"
: "${SINSERA_FTP_USER:?SINSERA_FTP_USER not set in .env.local}"
: "${SINSERA_FTP_PASS:?SINSERA_FTP_PASS not set in .env.local}"

REMOTE_DIR="${SINSERA_FTP_REMOTE_DIR:-/ark}"

# Commit pending source changes from the parent /Ark repo.
ROOT="$(cd .. && pwd)"
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no -- app 2>/dev/null)" ]; then
  echo "→ Committing source changes…"
  MSG="${1:-Deploy $(date '+%Y-%m-%d %H:%M')}"
  git -C "$ROOT" add app 2>/dev/null || true
  git -C "$ROOT" commit -m "$MSG" || true
fi

if git -C "$ROOT" remote get-url origin > /dev/null 2>&1; then
  BR="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  if [ -n "$(git -C "$ROOT" log @{u}.. 2>/dev/null)" ] || ! git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' > /dev/null 2>&1; then
    echo "→ Pushing origin/${BR}…"
    git -C "$ROOT" push origin "$BR" 2>&1 | tail -3 || true
  fi
fi

echo "→ Building…"
npm run build > /dev/null

echo "→ Mirroring dist/ → ${SINSERA_FTP_HOST}:${REMOTE_DIR}"
lftp -c "
  set net:timeout 20
  set net:max-retries 2
  set ftp:ssl-allow false
  open -u '${SINSERA_FTP_USER}','${SINSERA_FTP_PASS}' '${SINSERA_FTP_HOST}'
  mkdir -p '${REMOTE_DIR}' 2>/dev/null
  mirror -R --delete --parallel=4 --exclude-glob '.DS_Store' --exclude-glob '*.map' \
    'dist/' '${REMOTE_DIR}/'
"

echo "✓ Deploy complete (HostGator)."
echo "  Live at https://sinsera.co/ark/"

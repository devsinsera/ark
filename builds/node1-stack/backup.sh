#!/usr/bin/env bash
# Local backup of the self-hosted stack → Supabase DB (full pg_dump) + Gitea data + stack config.
# Keeps the last 7 of each. Runs via a daily systemd timer. Offsite push to the cloud = pending 402.
set -euo pipefail
STACK=/opt/sinsera-stack
DEST="$STACK/backups"
mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M)
cd "$STACK/supabase-docker"
docker compose exec -T db pg_dump -U postgres -d postgres --clean --if-exists 2>/dev/null | gzip > "$DEST/db-$TS.sql.gz"
tar czf "$DEST/gitea-$TS.tar.gz"  -C "$STACK" gitea 2>/dev/null || true
tar czf "$DEST/config-$TS.tar.gz" -C "$STACK" secrets.env supabase-docker/.env gitea-compose.yml 2>/dev/null || true
for p in db gitea config; do ls -1t "$DEST/$p-"* 2>/dev/null | tail -n +8 | xargs -r rm -f; done
echo "backup $TS done → $(du -sh "$DEST" | cut -f1) total; db=$(du -h "$DEST/db-$TS.sql.gz" | cut -f1)"

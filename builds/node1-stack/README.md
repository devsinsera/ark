# node1-stack

Self-hosted Supabase (trimmed) + Gitea for Node 1 (sinsera-core).
Deployed to /opt/sinsera-stack on the NVMe. Secrets generated on-device, never committed.

## Access (LAN) — Phase A live 2026-06-16
- Supabase API + Studio: http://sinsera-core.local:54321  (8000 was taken; gateway moved to 54321)
  - Studio login: user `supabase`, password = DASHBOARD_PASSWORD in /opt/sinsera-stack/secrets.env
  - App config: ANON_KEY in /opt/sinsera-stack/secrets.env
- Gitea: http://sinsera-core.local:3001  (git ssh :2222) — complete first-run admin setup in the browser
- Stack root: /opt/sinsera-stack (on the NVMe). Supabase stack vendored in supabase-docker/ (gitignored).

## Reproduce / bring up
    gen-secrets.sh > /opt/sinsera-stack/secrets.env && chmod 600 /opt/sinsera-stack/secrets.env
    configure.sh                                   # builds supabase-docker/.env
    cd /opt/sinsera-stack/supabase-docker && docker compose up -d
    cd /opt/sinsera-stack && docker compose -f gitea-compose.yml up -d
Both stacks use restart: unless-stopped → survive reboot.

## Notes / deviations from the original plan
- COMPOSE_FILE=docker-compose.yml (base only) → analytics/vector NOT included; no trim override needed.
- Newer Supabase needs extra secrets (SECRET_KEY_BASE, VAULT_ENC_KEY, PG_META_CRYPTO_KEY, DASHBOARD_PASSWORD) — all generated.
- Gateway on 54321 (port 8000 already used by another container on Node 1).

## Full status (2026-06-16 overnight) — Phases A, D(partial), E done; owner+Gitea seeded
- **Supabase (local primary):** LAN `http://sinsera-core.local:54321` · Tailscale `http://100.89.129.56:54321`
  - Studio login `supabase` / DASHBOARD_PASSWORD (secrets.env)
  - **Owner user created:** peta.stockdale@outlook.com / OWNER_PASSWORD (secrets.env) — for the app once repointed
  - Schema: 102 tables (from migration replay); ~20 replay gaps; clean schema + data load pending cloud DB pw / 402
- **Gitea:** `http://sinsera-core.local:3001` (Tailscale `100.89.129.56:3001`) · git-ssh :2222
  - Admin `sinsera` / GITEA_ADMIN_PASSWORD (secrets.env)
  - Repos mirrored in: sinsera-core, ark, eufybridge, votescope
- **Tailscale:** Node 1 = 100.89.129.56 (tailnet up; iPad/iPhone joined) → private remote access works now
- **Backups:** daily systemd timer (03:00) → /opt/sinsera-stack/backups (DB + Gitea + config, last 7). Offsite cloud push pending 402.
- **Secrets (all on Node 1, never committed):** /opt/sinsera-stack/secrets.env

## Still needs the user
- Lift the cloud 402 (or give the cloud DB password) → finish Phase B (clean schema + real data), then Phase C (repoint apps) + offsite backup leg.
- Phase C hosting decision: serve the Sinsera app from Node 1 (private) and point kiosks at it.
- Reconcile the diverged /opt/eufy/eufy_bridge.py before deploying the wall red-eye cursor.
- Flash Node 2 (bedroom) image; live reboot tests.

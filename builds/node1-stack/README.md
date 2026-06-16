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

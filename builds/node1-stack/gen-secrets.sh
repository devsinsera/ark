#!/usr/bin/env bash
# Supabase self-host secrets → prints KEY=VALUE lines. Run on Node 1 (needs python3 + openssl).
# Save to /opt/sinsera-stack/secrets.env (chmod 600), then run configure.sh.
set -euo pipefail
JWT_SECRET=$(openssl rand -hex 40)
mkjwt(){ python3 - "$JWT_SECRET" "$1" <<'PY'
import sys,hmac,hashlib,base64,json,time
s,r=sys.argv[1],sys.argv[2]
b=lambda d:base64.urlsafe_b64encode(json.dumps(d,separators=(',',':')).encode()).rstrip(b'=')
n=int(time.time())
m=b({"alg":"HS256","typ":"JWT"})+b'.'+b({"role":r,"iss":"supabase","iat":n,"exp":n+10*365*24*3600})
print((m+b'.'+base64.urlsafe_b64encode(hmac.new(s.encode(),m,hashlib.sha256).digest()).rstrip(b'=')).decode())
PY
}
cat <<SECRETS
JWT_SECRET=$JWT_SECRET
ANON_KEY=$(mkjwt anon)
SERVICE_ROLE_KEY=$(mkjwt service_role)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SECRET_KEY_BASE=$(openssl rand -hex 32)
VAULT_ENC_KEY=$(openssl rand -hex 16)
PG_META_CRYPTO_KEY=$(openssl rand -hex 16)
DASHBOARD_PASSWORD=$(openssl rand -hex 12)
SECRETS

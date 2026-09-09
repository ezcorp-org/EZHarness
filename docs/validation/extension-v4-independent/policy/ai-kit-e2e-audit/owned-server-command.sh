#!/usr/bin/env bash
set -euo pipefail
name=ai-kit-policy-owned-$$
run_root=$(mktemp -d /tmp/ai-kit-owned-XXXXXXXX)
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$run_root"; }
trap cleanup EXIT
mkdir -p "$run_root/data" "$run_root/state"
docker run -d --name "$name" --user "$(id -u):$(id -g)" -p 127.0.0.1:31847:3000 \
 -e EZCORP_PORT=3000 -e ORIGIN=http://localhost:31847 -e EZCORP_PUBLIC_URL=http://localhost:31847 \
 -e EZCORP_ENCRYPTION_SECRET=owned-local-encryption-secret-0000 \
 -e EZCORP_ENCRYPTION_SALT=owned-local-salt \
 -e EZCORP_JWT_SECRET=owned-local-jwt-secret-000000000 \
 -v "$run_root/data:/app/data" -v "$run_root/state:/app/.ezcorp" \
 localhost/ezcorp-extension-v4:audit-final-3ec53eaa >/dev/null
for _ in $(seq 1 90); do curl -fsS http://127.0.0.1:31847/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:31847/api/health >/dev/null
payload='{"name":"AI Kit Audit","email":"ai-kit-audit@test.local","password":"OwnedTestPass1!"}'
curl -fsS -c "$run_root/cookies" -H 'content-type: application/json' --data "$payload" http://127.0.0.1:31847/api/auth/setup >/dev/null
curl -fsS -b "$run_root/cookies" -c "$run_root/cookies" -H 'content-type: application/json' --data '{"email":"ai-kit-audit@test.local","password":"OwnedTestPass1!"}' http://127.0.0.1:31847/api/auth/login >/dev/null
key_json=$(curl -fsS -b "$run_root/cookies" -H 'content-type: application/json' --data '{"name":"ai-kit-audit","scopes":["read","chat","extensions"]}' http://127.0.0.1:31847/api/settings/developer/api-keys)
key=$(printf '%s' "$key_json" | /tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun -e 'let s="";for await(const c of Bun.stdin.stream())s+=new TextDecoder().decode(c);process.stdout.write(JSON.parse(s).key)')
EZCORP_E2E_BASE_URL=http://127.0.0.1:31847 EZCORP_E2E_API_KEY="$key" /tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun test \
 ./src/extensions/first-party-integration/ai-kit/e2e/doctor.test.ts \
 ./src/extensions/first-party-integration/ai-kit/e2e/internal-auth.test.ts

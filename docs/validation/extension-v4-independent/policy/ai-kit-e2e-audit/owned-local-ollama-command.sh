#!/usr/bin/env bash
set -euo pipefail
name=ai-kit-policy-owned-$$
run_root=$(mktemp -d /tmp/ai-kit-owned-XXXXXXXX)
cleanup(){ docker logs "$name" > /tmp/ai-kit-fanout-server.log 2>&1 || true; docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$run_root"; }
trap cleanup EXIT
mkdir -p "$run_root/data" "$run_root/state"
docker run -d --name "$name" --user "$(id -u):$(id -g)" --network host \
 -e EZCORP_PORT=3000 -e ORIGIN=http://localhost:3000 -e EZCORP_PUBLIC_URL=http://localhost:3000 \
 -e EZCORP_ENCRYPTION_SECRET=owned-local-encryption-secret-0000 \
 -e EZCORP_ENCRYPTION_SALT=owned-local-salt \
 -e EZCORP_JWT_SECRET=owned-local-jwt-secret-000000000 \
 -v "$run_root/data:/app/data" -v "$run_root/state:/app/.ezcorp" \
 localhost/ezcorp-extension-v4:audit-final-3ec53eaa >/dev/null
for _ in $(seq 1 90); do curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3000/api/health >/dev/null
payload='{"name":"AI Kit Audit","email":"ai-kit-audit@test.local","password":"OwnedTestPass1!"}'
curl -fsS -c "$run_root/cookies" -H 'content-type: application/json' --data "$payload" http://127.0.0.1:3000/api/auth/setup >/dev/null
curl -fsS -b "$run_root/cookies" -c "$run_root/cookies" -H 'content-type: application/json' --data '{"email":"ai-kit-audit@test.local","password":"OwnedTestPass1!"}' http://127.0.0.1:3000/api/auth/login >/dev/null
key_json=$(curl -fsS -b "$run_root/cookies" -H 'content-type: application/json' --data '{"name":"ai-kit-audit","scopes":["read","chat","extensions"]}' http://127.0.0.1:3000/api/settings/developer/api-keys)
key=$(printf '%s' "$key_json" | /tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun -e 'let s="";for await(const c of Bun.stdin.stream())s+=new TextDecoder().decode(c);process.stdout.write(JSON.parse(s).key)')

curl -fsS -b "$run_root/cookies" -H 'content-type: application/json' -X PUT --data '{"value":[{"modelId":"gemma4:e2b","provider":"ollama","tier":"balanced","baseUrl":"http://127.0.0.1:11434"}]}' 'http://127.0.0.1:3000/api/settings/provider%3AcustomModels' >/dev/null
curl -fsS -b "$run_root/cookies" -H 'content-type: application/json' -X PUT --data '{"value":{"fast":[{"provider":"ollama","model":"gemma4:e2b"}],"balanced":[{"provider":"ollama","model":"gemma4:e2b"}],"powerful":[{"provider":"ollama","model":"gemma4:e2b"}]}}' 'http://127.0.0.1:3000/api/settings/provider%3AtierModels' >/dev/null
export EZCORP_E2E_BASE_URL=http://127.0.0.1:3000 EZCORP_E2E_API_KEY="$key"
/tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun -e 'import {EzcorpClient} from "./packages/@ezcorp/ai-kit/src/client.ts"; const c=new EzcorpClient({baseUrl:process.env.EZCORP_E2E_BASE_URL,apiKey:process.env.EZCORP_E2E_API_KEY}); const common={prompt:"Reply briefly.",provider:"ollama",model:"gemma4:e2b",maxTokens:32}; const researcher=await c.createAgent({name:"researcher",...common}); const writer=await c.createAgent({name:"writer",...common}); await c.createAgent({name:"owned-team",prompt:"Coordinate briefly.",category:"team",provider:"ollama",model:"gemma4:e2b",maxTokens:32,references:{autoSpinUp:true,members:[{agentConfigId:researcher.id},{agentConfigId:writer.id}]}});'
export EZCORP_E2E_BASE_URL=http://127.0.0.1:3000
export EZCORP_E2E_API_KEY="$key"
BUN=/tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun
"$BUN" test ./src/extensions/first-party-integration/ai-kit/e2e/fanout.test.ts ./src/extensions/first-party-integration/ai-kit/e2e/quickstart.test.ts -t 'parallel|autoSpinUp'

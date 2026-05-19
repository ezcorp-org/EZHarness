# ai-kit E2E tests

These tests run against a **live** SvelteKit dev server (under `web/` in the repo
root) and a real DB. They're opt-in — by default they skip cleanly when the
target server isn't reachable.

## To run

```sh
# 1. Start the EZCorp dev server (separate terminal, from repo root)
cd web && bun run dev     # serves on http://localhost:5173

# 2. Generate an API key via the UI: Settings → Developer → New Key
#    (must have `chat` scope for fan-out tests; `read` is enough for doctor)

# 3. Export creds and run E2E
export EZCORP_E2E_BASE_URL=http://localhost:5173
export EZCORP_E2E_API_KEY=ez_...
bun test test/e2e
```

## Files

| File | Validates |
|---|---|
| `quickstart.test.ts` | Mirrors `docs/quickstart-curl.md` end-to-end (auth → create → send → stream). |
| `fanout.test.ts` | All four fan-out mechanisms (`spawn_chats`, parallel `![agent:…]`, team autoSpinUp, task assignments). |
| `doctor.test.ts` | `ai-kit doctor` happy + error branches. |
| `install-claude-code.test.ts` | `ai-kit install claude-code` into a sandbox HOME + verify the MCP config works. Skipped when the `claude` CLI is not in PATH. |
| `ezcorp-self.test.ts` | Loads the package as an EZCorp extension, spawns a sibling chat from inside. |

## When to skip

- `EZCORP_E2E_BASE_URL` unset → entire suite skipped.
- Server at the URL not responding to `/api/health` within 2s → suite skipped.
- `EZCORP_E2E_API_KEY` unset → auth-requiring tests skipped; doctor's unauth branch still runs.

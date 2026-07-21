# web/ — SvelteKit frontend

Svelte 5 (runes), Vite, Tailwind 4. Routes under `src/routes/**/+page.svelte`;
prod served via `svelte-adapter-bun`; dev is `vite dev` (the repo-root
`docker-compose.yml` dev container runs it with HMR). No React; no Bun
HTML-imports pattern — `Bun.serve()` is the backend's server, not the
frontend build.

## Tests in this tree

- Svelte component (`*.component.test.ts`), server-route (`*.server.test.ts`),
  and `*.unit.test.ts` files run under **Vitest** (`bun run --cwd web
  test:component`, config `web/vitest.config.ts`) — Svelte 5 files need the
  Svelte compiler at import, which bun lacks. This is the ONLY sanctioned
  Vitest surface in the repo; don't add Vitest anywhere else.
- All other `web/src/**/*.test.ts` run bun-side via `scripts/test-web.sh`
  (repo root, the CI "bun-leg orphans" pool).
- E2E: Playwright specs in `web/e2e/` — `bun run test:e2e` (mock tier); the
  real-auth/real-DB tier is `web/playwright.real.config.ts` + `PI_E2E_REAL=1`.
  Frontend-visual changes MUST ship an `@evidence`-tagged spec calling
  `captureEvidence(page, testInfo, label)` (`web/e2e/fixtures/evidence.ts`) —
  the `Visual evidence` CI gate enforces it.

## API routes (remote-testability contract)

Routes live under `src/routes/api/**`; the contract is enforced by the CI
meta-test `src/__tests__/route-contract.test.ts`
(full spec: [../docs/harness-contract.md](../docs/harness-contract.md)):

- **New `/api/*` route** → register it in `src/api-registry.ts` (repo root)
  with a `scope` (`read`/`chat`/`extensions`/`admin`/`public`). It then
  documents itself and appears in the generated OpenAPI spec (`src/openapi.ts`,
  repo root).
  The meta-test ratchets the unregistered-route count and enforces admin
  scope↔role pairing and controllable↔harness-client route parity.
- **New `/api/__test/**` route** (determinism tier) → gate it with
  `isTestSurfaceEnabled()` from `$lib/server/test-surface`. Fail-CLOSED: 404
  unless ALL of `EZCORP_ALLOW_TEST_SURFACE=1`, `PI_E2E_REAL=1`, and a
  non-production `NODE_ENV` hold.
- **New client-facing runtime event** → add it ONLY to
  `src/lib/runtime-event-names.ts` (SSE `BUS_EVENTS` and `ws.ts`'s `WSRunEvent`
  both derive from it).
- Cold-start auth is `ezcorp key mint` (CLI, no UI). The control tier is
  scope-gated and works in production; the determinism tier never does.
  External harnesses extend
  `@ezcorp/harness-client` (`packages/@ezcorp/harness-client`), not ad-hoc
  fetch, for any `harness: { controllable: true }` route.

## Mention grammar (composer)

Five sigils share one pure-logic module `src/lib/mention-logic.ts`; the single
`/api/mentions/search` endpoint routes on `type=`.

| Sigil | Kind(s) | Token format | Source |
|---|---|---|---|
| `!` | `agent`, `ext`, `team`, `EZ` | `![kind:name]` | DB (`agentConfigs`, `extensions`) + executor's in-memory map + EZ-action registry + built-in tool categories |
| `@` | `file`, `dir` | `@[kind:relpath]` | Active project's filesystem (symlink-escape filtered) |
| `/` | `cmd` | `/[cmd:name]` | `.claude/{commands,agents}`, `.codex/prompts`, `agents/` (project + home) + `user_commands` DB table |
| `$` | `feature` | `$[feature:name]` | DB (`features` table, scoped to active project) |
| `%` | `lesson` | `%[lesson:slug]` | DB (`lessons` table, scoped to user + project, visibility-filtered) |

`![ext:<name>/` nests tool autocomplete (`type=tool`). `![EZ:name]`
(case-insensitive) is stripped pre-prompt and invokes a runtime action instead
of reaching the LLM. Slash commands (discovery gated by
`EZCORP_SCAN_GLOBAL_COMMANDS`, default on), feature, and lesson mentions
expand **server-side** in `src/runtime/mention-wiring.ts` (repo root): raw
token persisted, expansion literal — never re-parse expanded text; unknown
targets are silent no-ops. Feature expansion emits plain-text file paths,
never `@[file:…]` tokens (no double-expansion). Full specs:
[../docs/features/composer/mention-grammar.md](../docs/features/composer/mention-grammar.md),
[../docs/slash-commands.md](../docs/slash-commands.md).

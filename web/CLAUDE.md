# web/ — SvelteKit frontend

Svelte 5 (runes), Vite, Tailwind 4. Routes under `src/routes/**/+page.svelte`;
prod served via `svelte-adapter-bun`; dev is `vite dev` (the repo-root
`docker-compose.yml` dev container runs it with HMR). No React; no Bun
HTML-imports pattern — `Bun.serve()` is the backend's server, not the
frontend build.

## TypeScript is a DUAL install — don't "tidy" it to one

`package.json` carries two compilers on purpose:

| dep | version | who uses it |
|---|---|---|
| `typescript` | `^6.0.3` | `tsc --noEmit` (`scripts/typecheck.sh`), the editor language service, Vite |
| `@typescript/native` | `npm:typescript@7.0.2` | `svelte-check --tsgo` only |

This is the shape svelte-check itself prescribes, and it is load-bearing:
`svelte-check/bin/ts-version-check.js` reads `require('typescript/package.json')`
and **throws** when that major is `>= 7` — no flag suppresses it. So bumping
`typescript` to 7 breaks the `Svelte check` CI job outright (that is exactly
what dependabot PR #163 did). TypeScript 7 is the native Go port; it reaches
the codebase only through the alias, selected by `--tsgo`.

Consequences:

- **`--tsgo` must be on every svelte-check call site**, and there are three:
  `.github/workflows/ci.yml`, `scripts/lib/hook-lib.sh` (`svelte_check`), and
  the `check` / `check:watch` scripts here. Drop it from one and that path
  throws instead of checking — a hole, not a failure.
- The repo root still pins `typescript@^5.9.3` for the backend leg. Root and
  web are separate installs (`web` is not a bun workspace), so the versions are
  independent by design.

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

**Take `test` from the fixtures, never from `@playwright/test`.** Every route
here is server-rendered, so `await expect(page.getByText("…")).toBeVisible()`
after a `goto` is satisfied at FIRST PAINT — the text, the `<textarea>` and the
send button are all in the raw HTML with zero JS run (33 KB on the chat route,
measured with `curl`). A `fill()` next can land on the pre-hydration node;
hydration then re-creates the composer with `value = ""`, throws the typed text
away, and the send button stays disabled FOREVER, so the click burns its full
timeout. It reproduces only when the box is starved, which is why it reached
CI (issue #145; audit: 489 such windows across 150 of 344 specs).

The gate is therefore structural, not per-spec: `app.html` ships
`data-hydrated="false"`, the root `+layout.svelte` onMount flips it to `"true"`,
and `e2e/fixtures/hydration.ts` wraps `page.goto` to wait for the flip. Import
`test`/`expect` from `fixtures/test-base.js` (mock tier) or
`fixtures/hydration.js` (real-auth + docker specs, which must not pull in the
fetch mocks) and you inherit it. `src/__tests__/e2e-hydration-gate.test.ts`
enforces this. Two consequences worth knowing:

- `sendComposerMessage` (`fixtures/composer.ts`) is still required for sending —
  hydration is necessary but not sufficient; the send button also needs
  `/api/models` plus the picker's autoselect.
- Assertions about a message must be scoped with `threadMessages(page)`. On a
  fully-hydrated page the sidebar row carries the same auto-title text, so an
  unscoped `getByText(sent)` is a strict-mode violation.

## API routes (remote-testability contract)

Routes live under `src/routes/api/**`; the contract is enforced by the CI
meta-test `src/__tests__/route-contract.test.ts`
(full spec: [../docs/harness-contract.md](../docs/harness-contract.md)):

- **New `/api/*` route** → register it in `src/api-registry.ts` (repo root)
  with a `scope` (`read`/`write`/`chat`/`extensions`/`admin`/`public`), set to
  what the handler actually ENFORCES — never what it ought to. It then
  documents itself and appears in the generated OpenAPI spec (`src/openapi.ts`,
  repo root).
  The meta-test requires registration ABSOLUTELY (both directions — no route
  unregistered, no entry without a handler), ratchets the `scope` half against
  a frozen list of the entries that predate it (93 at freeze, 91 today, and it
  may only shrink), and enforces admin
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
| `!` | `agent`, `ext`, `team`, `EZ`, `workflow` | `![kind:name]` | DB (`agentConfigs`, `extensions`) + executor's in-memory map + EZ-action registry + built-in tool categories + the merged workflow cache |
| `@` | `file`, `dir` | `@[kind:relpath]` | Active project's filesystem (symlink-escape filtered) |
| `/` | `cmd` | `/[cmd:name]` | `.claude/{commands,agents}`, `.codex/prompts`, `agents/` (project + home) + `user_commands` DB table |
| `$` | `feature` | `$[feature:name]` | DB (`features` table, scoped to active project) |
| `%` | `lesson` | `%[lesson:slug]` | DB (`lessons` table, scoped to user + project, visibility-filtered) |

`![ext:<name>/` nests tool autocomplete (`type=tool`). `![EZ:name]`
(case-insensitive) is stripped pre-prompt and invokes a runtime action instead
of reaching the LLM. Slash commands (discovery gated by
`EZCORP_SCAN_GLOBAL_COMMANDS`, default on), feature, lesson, and workflow
mentions expand **server-side** in `src/runtime/mention-wiring.ts` (repo root):
raw token persisted, expansion literal — never re-parse expanded text; unknown
targets are silent no-ops. Feature expansion emits plain-text file paths,
never `@[file:…]` tokens (no double-expansion). `![workflow:name]` is a
REFERENCE — it expands to a note describing the workflow and never runs it;
the separate `run_workflow` built-in executes (wired only at
`orchestrationDepth === 0`, on owned conversations). `workflow` is a 5th KIND
under `!`, NOT a 6th sigil — the count above stays five. Full specs:
[../docs/features/composer/mention-grammar.md](../docs/features/composer/mention-grammar.md),
[../docs/slash-commands.md](../docs/slash-commands.md).

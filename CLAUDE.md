## Project

EZCorp — a self-hosted AI platform for multi-model chat with persistent memory and an extension ecosystem.

**Goals:**
- **Extensibility** — user-built extensions for custom UI, tools, and interactions
- **Security** — RBAC and per-tool-call permissions for LLM actions
- **Reliability** — safe migrations, durable storage, single-container deploy

Stack: Bun runtime, PGlite/Postgres, SvelteKit frontend (`web/`), backend (`src/`), runtime executor + built-in tools.

---

## Development lifecycle (binding)

Trunk-based: branch off `main` (`feat/ fix/ ci/ docs/ chore/ security/`), open a
PR, land all required checks green + a non-author review, squash-merge to `main`
(always deployable), release via an `app-vX.Y.Z` tag. Full spec:
[docs/development-lifecycle.md](docs/development-lifecycle.md).

**Feature contract — every feature you ship MUST:**
1. Cover each **new source file** to its threshold (default **100%**) and add a
   key to `scripts/coverage-thresholds.json` (or a justified `EXCLUDES` entry in
   `scripts/coverage-config.ts`).
2. Cover **every new/changed executable line** (patch-coverage gate).
3. Add/update a **Playwright e2e spec** under `web/e2e/` for user-facing behavior.
4. For a **frontend-visual change** (route/layout pages, `web/src/lib/components/**`,
   css), ship an `@evidence`-tagged Playwright e2e spec under `web/e2e/` that
   calls `captureEvidence(page, testInfo, label)`. The `Visual evidence` CI gate
   enforces a spec is present and the bot attaches screenshots to the PR.
5. **Never** weaken the gate or fake green — no lowered thresholds, no new
   `EXCLUDES`, no `.skip/.only/.todo`, no assertion-free tests. These are
   blocked by the `Gate integrity` CI check; a maintainer-only
   `gate-change-approved` label is the only bypass (you cannot apply it).

The gate files (`scripts/coverage-*.ts`, `coverage-thresholds.json`, CI
workflows, `playwright.config.ts`) are CODEOWNERS-owned — changing them needs
human review. Verify locally before pushing:
`bun run typecheck && bun run lint && bun run test && bun run test:coverage`.

**Worktree isolation (binding):** ALWAYS run agents in a separate git
worktree — never let a spawned agent edit the primary working directory
directly. Before delegating work, create an isolated worktree on its own
branch (`git worktree add ../ez-corp-ai-<slug> -b <branch>`), point the
agent at that path, and have it do all reads/writes/commits there. This
keeps parallel agents from contaminating each other or the main tree, and
keeps `main` clean. When using the Agent/Workflow tools, pass
`isolation: "worktree"` so each agent gets its own worktree automatically.
Notes: `tasks/` is gitignored and does NOT propagate to a fresh worktree —
copy any planning docs over after `git worktree add`; and dev-container
compose mounts resolve relative paths from the compose CWD, so recreate the
container from the worktree dir if it must serve worktree edits.

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Extension data

Every extension in `docs/extensions/examples/*/` stores its persistent
user-visible state under `<projectRoot>/.ezcorp/extension-data/<extension-name>/`.
When reading or writing extension-managed files (task stores, note vaults,
config json, etc.), always use that path. The `.ezcorp/` directory is
gitignored. See `docs/extensions/data-storage.md` for the full convention.

## Extension logging

Host-side extension code (integration daemons, reverse-RPC handlers, spawn
bridges) MUST get its logger from `extensionLogger(name, component?)` in
`src/logger.ts` — never `logger.child(...)` directly — so every extension log
lands under the `ext.<name>[.<component>]` subsystem namespace. That lets an
operator raise debug for one extension via `EZCORP_DEBUG=ext.<name>` (or all
extensions via `EZCORP_DEBUG=ext`, everything via `EZCORP_DEBUG=1`) without the
global `LOG_LEVEL=debug` firehose. Default-visible `info` should carry
once-per-cycle summaries; `debug` carries per-item detail; never log secret/token
plaintext. See `docs/extensions/logging.md` for the full convention.

## Mention grammar

The chat composer supports five mention sigils — all five share one
pure-logic module at `web/src/lib/mention-logic.ts`, and the single
`/api/mentions/search` endpoint routes on a `type=` query parameter.

| Sigil | Kind(s) | Token format | Source |
|---|---|---|---|
| `!` | `agent`, `ext`, `team`, `EZ` | `![kind:name]` | DB (`agentConfigs`, `extensions`) + executor's in-memory map + EZ-action registry |
| `@` | `file`, `dir` | `@[kind:relpath]` | Active project's filesystem (symlink-escape filtered) |
| `/` | `cmd` | `/[cmd:name]` | `.claude/{commands,agents}`, `.codex/prompts`, `agents/` (project + home) + `user_commands` DB table |
| `$` | `feature` | `$[feature:name]` | DB (`features` table, scoped to active project) |
| `%` | `lesson` | `%[lesson:slug]` | DB (`lessons` table, scoped to user + project, visibility-filtered) |

The `EZ` kind is nested under `!` (`![EZ:name]`): unlike `agent`/`ext`/`team`,
these tokens are stripped pre-prompt by `stripEzActionTokens` and invoke a
code-defined runtime action instead of being shown to the LLM. Lesson mentions
(`%[lesson:slug]`) expand server-side via `applyLessonExpansion`. The full
per-feature reference lives under
[docs/features/composer/](docs/features/composer/mention-grammar.md).

Slash-command discovery is gated by `EZCORP_SCAN_GLOBAL_COMMANDS` (default on).
Commands are expanded server-side in `src/runtime/mention-wiring.ts`'s
`applyCommandExpansion` — the raw `/[cmd:name]` token is persisted;
the LLM sees the substituted body. Expansion is literal — never
re-parse expanded text for other mention kinds. See
[docs/slash-commands.md](docs/slash-commands.md) for the full spec.

Feature mentions are expanded server-side in
`src/runtime/mention-wiring.ts`'s `applyFeatureExpansion` — the raw
`$[feature:name]` token is persisted; the LLM sees a system note
listing the feature's description + plain-text file paths. Like
slash-command expansion, this is literal — files are NOT emitted as
`@[file:…]` tokens (no double-expansion). Unknown / deleted features
are silent no-ops, mirroring `@[file:…]` for missing files. See
[docs/plans/2026-05-01-feature-index-design.md](docs/plans/2026-05-01-feature-index-design.md)
for the full spec.

## Context compaction

Conversation history is trimmed per-model before every LLM call via
pi-agent-core's `transformContext` hook, wired in
`src/runtime/stream-chat/build-pi-agent.ts` and configured from
`src/runtime/stream-chat/context-compaction.ts`. It is a swappable
strategy (`trim` default, `summarize` for an LLM condense that fails open
to `trim`, `none` to disable) selected by the `compaction:strategy`
setting.

**Invariant — input-only:** never mutate `model.maxTokens` (or clone
the model) to "save context". For the Codex API that field is metadata
only (no `max_output_tokens` is sent); for other providers pi-ai
already derives the output cap from it, so shrinking it truncates
output. Trim **input** only; `responseReserve` sizes the budget and is
never written back. See
[docs/context-compaction.md](docs/context-compaction.md) for the full
spec, settings keys, and how to add a custom strategy.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- PGlite (`@electric-sql/pglite`) for embedded PostgreSQL. Don't use `bun:sqlite` or `better-sqlite3`.
- `Bun.sql` for external Postgres (when `DATABASE_URL` is set). Don't use `pg` or `postgres.js`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Remote testability contract

The app is remotely controllable + deterministically testable by external
harnesses, and new features must keep it that way. A CI meta-test
(`web/src/__tests__/route-contract.test.ts`) enforces the rules; see
[docs/harness-contract.md](docs/harness-contract.md) for the full spec.

- **New `/api/*` route** → register it in `src/api-registry.ts` with a `scope`
  (`read`/`chat`/`extensions`/`admin`/`public`). It then documents itself and
  appears in the generated OpenAPI spec (`src/openapi.ts`). The meta-test
  ratchets the unregistered-route count — a new unregistered route fails.
- **New `/api/__test/**` route** (determinism tier) → gate it with
  `isTestSurfaceEnabled()` from `$lib/server/test-surface`. The gate is
  fail-CLOSED: it returns 404 unless **all three** of
  `EZCORP_ALLOW_TEST_SURFACE=1` (conscious operator opt-in), `PI_E2E_REAL=1`,
  and a non-production `NODE_ENV` hold. The meta-test fails any ungated one.
- **New client-facing runtime event** → add it to the single canonical list
  `web/src/lib/runtime-event-names.ts` (the SSE `BUS_EVENTS` and `ws.ts`'s
  `WSRunEvent` both derive from it). Never re-list event names elsewhere.
- **Cold-start auth** is `ezcorp key mint` (CLI, no UI). The control tier is
  scope-gated and works in production; the determinism tier never does.
- External harnesses use the `@ezcorp/harness-client` package — extend it (not
  ad-hoc fetch) when adding a `harness: { controllable: true }` route.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

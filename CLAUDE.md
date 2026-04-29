## Project

EZCorp — a self-hosted AI platform for multi-model chat with persistent memory and an extension ecosystem.

**Goals:**
- **Extensibility** — user-built extensions for custom UI, tools, and interactions
- **Security** — RBAC and per-tool-call permissions for LLM actions
- **Reliability** — safe migrations, durable storage, single-container deploy

Stack: Bun runtime, PGlite/Postgres, SvelteKit frontend (`web/`), backend (`src/`), runtime executor + built-in tools.

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

## Mention grammar

The chat composer supports three mention sigils — all three share one
pure-logic module at `web/src/lib/mention-logic.ts`, and the single
`/api/mentions/search` endpoint routes on a `type=` query parameter.

| Sigil | Kind(s) | Token format | Source |
|---|---|---|---|
| `!` | `agent`, `ext`, `team` | `![kind:name]` | DB (`agentConfigs`, `extensions`) + executor's in-memory map |
| `@` | `file`, `dir` | `@[kind:relpath]` | Active project's filesystem (symlink-escape filtered) |
| `/` | `cmd` | `/[cmd:name]` | `.claude/{commands,agents}`, `.codex/prompts`, `agents/` (project + home) + `user_commands` DB table |

Slash-command discovery is gated by `EZCORP_SCAN_GLOBAL_COMMANDS` (default on).
Commands are expanded server-side in `src/runtime/mention-wiring.ts`'s
`applyCommandExpansion` — the raw `/[cmd:name]` token is persisted;
the LLM sees the substituted body. Expansion is literal — never
re-parse expanded text for other mention kinds. See
[docs/slash-commands.md](docs/slash-commands.md) for the full spec.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- PGlite (`@electric-sql/pglite`) for embedded PostgreSQL. Don't use `bun:sqlite` or `better-sqlite3`.
- `Bun.sql` for external Postgres (when `DATABASE_URL` is set). Don't use `pg` or `postgres.js`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

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

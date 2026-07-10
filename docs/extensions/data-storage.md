# Data Storage Convention

Every extension that writes persistent data to the host filesystem MUST put it under a single, predictable path. This keeps the repo tidy, prevents collisions between extensions, and makes it trivial for users (and agents helping users) to find, back up, or reset extension state.

For permissions and the `ezcorp/storage` key-value API, see [API Reference](api-reference.md) and [Manifest Schema](manifest-schema.md).

---

## The Convention

```
<projectRoot>/.ezcorp/extension-data/<extension-name>/
```

- `<projectRoot>` -- the nearest ancestor directory containing a `.git/` folder. If no `.git/` is found while walking up, fall back to `process.cwd()`.
- `<extension-name>` -- must match the `name` field in the extension's `ezcorp.config.ts` manifest.

Inside that directory the extension owns the layout. Use subdirectories for logical groupings (e.g. `vault/`, `cache/`) and keep top-level files for small singletons like `config.json`.

> **Visibility: the tree is PROJECT-SHARED, not per-user.** Everything an
> extension writes here is served to *every* chat-scoped user of the
> deployment via `GET /api/extensions/<name>/data/<path>` (the route
> requires the extension to be installed **and enabled**, but it does not
> — and cannot — partition files by user). Never write per-user private
> data (personal notes, tokens, per-user documents) into this tree. Use
> the `ezcorp/storage` key-value API with **user scope** for per-user
> state, and the extension **secrets** capability for credentials — both
> are host-mediated and scoped to the acting user. See
> [API Reference](api-reference.md).

---

## Why

- **One `.gitignore` rule** -- the project root already ignores `.ezcorp/`, so no extension can accidentally cause user vault files, task stores, or logs to be committed.
- **Zero collisions** -- two extensions can both pick `config.json` as a filename without clobbering each other.
- **Trivial reset** -- deleting `.ezcorp/extension-data/` wipes every extension's state at once; deleting a single subdirectory resets just one.
- **Single hidden directory** -- the platform itself uses `.ezcorp/` for its own state, so users only ever see one hidden directory at the project root.

---

## How to Implement

**Inside a sandboxed tool subprocess you cannot walk the filesystem for `.git` yourself** — the Phase 3 sandbox-preload poisons `node:fs` / `Bun.file` at module load (see `packages/@ezcorp/sdk/src/runtime/fs.ts`). The production pattern has two halves:

1. **Project root:** read the `EZCORP_PROJECT_ROOT` env var. The host does the `.git` walk once and injects the answer at subprocess spawn time (`buildAllowedEnv` in `src/extensions/registry.ts`).
2. **File IO:** use the SDK's host-mediated helpers — `fsRead`, `fsWrite`, `fsList`, `fsStat`, `fsExists`, `fsMkdir`, `fsUnlink` from `@ezcorp/sdk/runtime`. They call the host's `ezcorp/fs.*` reverse-RPC and are the only supported fs path from extension code.

This is exactly what `docs/extensions/examples/task-stack/index.ts` does — its `resolveProjectRoot()` prefers the env var and only falls back to a lazy `require("node:fs")` walk for unit tests and ad-hoc CLI runs where no sandbox is active:

```typescript
import { join, dirname } from "node:path";
import { fsRead, fsWrite, fsMkdir } from "@ezcorp/sdk/runtime";

export function resolveProjectRoot(from: string = process.cwd()): string {
  // (1) Host-injected — production fast path.
  const fromEnv = process.env.EZCORP_PROJECT_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  // (2) Lazy fs walk — test / CLI contexts only (no sandbox active).
  let fs: typeof import("node:fs");
  try {
    fs = require("node:fs") as typeof import("node:fs");
  } catch {
    return from; // fs poisoned and no env hint — defer the error to IO time
  }
  let dir = from;
  while (true) {
    if (fs.existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from; // reached filesystem root
    dir = parent;
  }
}

const DATA_DIR = join(resolveProjectRoot(), ".ezcorp", "extension-data", "my-extension");
// Then read/write via fsRead(path) / fsWrite(path, contents) — never raw node:fs.
```

A raw `node:fs` `.git` walker is still fine **host-side** — in `scripts/postinstall.ts` and other install/build scripts that run outside the sandbox (see the next section), or via the SDK's `findProjectRoot()` helper, which is host-side only.

`.ezcorp/` is already listed in the top-level `.gitignore`, so there is nothing for the extension author to add.

---

## `postinstall.ts` Pattern

Scaffold the directory in your `scripts/postinstall.ts` so it exists on first run. Postinstall scripts run **host-side** (outside the tool sandbox), so a raw `node:fs` walker is legitimate here:

```typescript
#!/usr/bin/env bun
import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

function findProjectRoot(from: string = process.cwd()): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

const dataDir = join(findProjectRoot(), ".ezcorp", "extension-data", "my-extension");
mkdirSync(dataDir, { recursive: true });
console.log(`my-extension data dir initialized at ${dataDir}`);
```

Register the script in your manifest:

```typescript
scripts: {
  postinstall: "scripts/postinstall.ts",
}
```

---

## Reading Extension Data from Outside the Extension

An agent that is **not** the extension itself -- for example, the Claude-style assistant a user is chatting with -- will sometimes need to read or edit an extension's user-visible files (open a note, inspect a task store, tail a log). Discovery is identical: walk up for `.git/`, then append the convention path.

Shell (for agents running commands):

```bash
# From anywhere inside the project
ls "$(git rev-parse --show-toplevel)/.ezcorp/extension-data/"

# Read auto-note's config
cat "$(git rev-parse --show-toplevel)/.ezcorp/extension-data/auto-note/config.json"
```

TypeScript (for agents using Bun or Node APIs):

```typescript
const root = findProjectRoot();
const autoNoteVault = join(root, ".ezcorp", "extension-data", "auto-note", "vault");
const taskStore   = join(root, ".ezcorp", "extension-data", "task-stack", "task-stack.json");
```

Agents should prefer reading from these paths over asking the user where an extension stores its data. The convention is the contract.

---

## Storage API vs Filesystem Convention

Two different mechanisms, two different use cases:

| Mechanism | Use it for | Lives where |
|-----------|------------|-------------|
| `ezcorp/storage` reverse-RPC | Opaque key-value state, server-authoritative, isolated per-extension, quota-enforced | Platform database |
| `.ezcorp/extension-data/<name>/` | User-visible files -- markdown vaults, JSON task stores, logs, generated output users might open in an editor | Project filesystem |

If a human would ever want to open the file in their editor or grep it with `rg`, use the filesystem convention. If it's internal state the user never needs to see, use `ezcorp/storage`.

---

## Worked Examples

### `task-stack`

Single JSON store at the root of its data directory:

```
<projectRoot>/.ezcorp/extension-data/task-stack/
  task-stack.json         # all stacks, tasks, subtasks, deps, artifacts
```

See `docs/extensions/examples/task-stack/index.ts` for the `resolveProjectRoot()` + `STORE_PATH` wiring (env-var first, host-mediated `fsRead`/`fsWrite` for IO).

### `auto-note`

Mixed layout -- a markdown vault the user browses plus a small JSON config:

```
<projectRoot>/.ezcorp/extension-data/auto-note/
  config.json             # vault settings, category overrides
  vault/
    _index.md             # auto-generated index
    ideas/
    tasks/
    decisions/
    references/
    journal/
    meetings/
```

See `docs/extensions/examples/auto-note/scripts/postinstall.ts` for the scaffold and `docs/extensions/examples/auto-note/lib/vault.ts` for runtime usage.

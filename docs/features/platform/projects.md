# Projects & Root Resolution

> _Two unrelated "project" concepts: a user-facing **project record** (a named workspace whose `path` parameterizes every file tool) and the host-internal **install-root resolver** (`getProjectRoot()`) that locates the EZCorp checkout for bundled-extension discovery and the `$CWD` grant._

## Intent

A **project** is the workspace a conversation runs against. Each project row carries a name, a filesystem `path`, an icon, and a free-form `variables` bag. The `path` is the single source of truth for *where on disk* an agent's file tools may read and write — every built-in file tool and the `@`-mention file scanner are parameterized by the active conversation's project path. Per-project tool-permission modes let an operator dial the approval friction (`ask` / `auto-edit` / `yolo`) independently per workspace.

Separately and confusingly named, `getProjectRoot()` in `src/extensions/bundled.ts` resolves the **EZCorp install root** — the directory containing `docs/extensions/examples/`. This is host infrastructure (bundled-extension lookup, `$CWD` grant base), **not** a user project path. The two never coincide except by accident.

## How it works

### The project record (user-facing)

1. **Schema** — `projects` (`src/db/schema.ts`): `id` (TEXT — a uuid for user-created rows, or the seeded literals `global` / `self`), `name`, `path` (both `notNull`), `icon` (nullable), `variables` (jsonb, default `{}`), plus timestamps. There is **no `userId` column** — project rows are instance-global, not user-scoped (see Notes).
2. **CRUD queries** — `src/db/queries/projects.ts` exposes `listProjects` / `getProject` / `createProject` / `updateProject` / `deleteProject` / `getProjectByName`. None filter by user; `listProjects()` returns every row.
3. **HTTP surface** — `web/src/routes/api/projects/+server.ts` (`GET` list, `POST` create) and `web/src/routes/api/projects/[id]/+server.ts` (`GET` / `PUT` / `DELETE`). Bodies are Zod-validated (`.strict()`); create requires non-empty `name` and `path` (preserved 400 message: `"name and path required"`).
4. **Conversation binding** — `conversations.projectId` is `notNull` with `onDelete: "cascade"`: a conversation always belongs to exactly one project, and deleting a project deletes its conversations. Many other tables FK to `projects` (runs, memories, features, lessons, knowledge_base_files, …) with `set null` or `cascade`.
5. **The data path into agents** — when a turn runs, `ExecutorEngine.resolveInput` (`src/runtime/executor.ts`) merges, in priority order, account settings → `{ cwd: project.path }` → `project.variables` → the call's explicit input. So the project's `path` becomes the agent's `cwd` and its `variables` become input defaults. In the chat send path, `web/src/routes/api/conversations/[id]/messages/+server.ts` calls `getProject(conv.projectId)` and passes `project.path` as `projectRoot` to the streaming runtime; that `projectRoot` is what file tools resolve against.
6. **File-tool containment** — built-in file tools resolve relative paths against `projectRoot` via `validatePath` (`src/runtime/tools/validate.ts`), a **lexical** `resolve`/`relative`/`startsWith` check (no realpath). The `@`-mention / autocomplete scanner (`src/runtime/fs/scan-fs.ts`) instead uses `realpathInsideRoot` (realpath-based, symlink-escape filtered). This asymmetry is intentional but worth knowing (see Notes).
7. **Seeded rows** — `migrate()` idempotently seeds two rows on boot: the `global` sentinel (`id='global'`, `path='/'`) and — only when `EZCORP_SELF_PROJECT_PATH` is set — the **self project** (`id='self'`, `src/db/seed-self-project.ts`), a workspace whose `path` is the app's own source checkout so a dev-compose instance can dogfood EZCorp on its own code. First insert also seeds a standing-guidance system prompt as `settings['project:self:systemPrompt']` (delivered via `resolveSystemPrompt`, editable/deletable at `/project/self/settings` — never re-seeded, so user edits stick) and the repo-shipped icon (`/self-project-icon.png` from `web/static/`, backfilled onto older rows only while `icon` is NULL). On later boots only `path` follows the env var; name/icon choices are preserved, and deleting the project re-creates it next boot (a dev affordance, by design). `listProjects()` pins the `self` row first so it's the top option in every project surface. The dev compose stack sets the var to `/repo` (the full-checkout mount); the older seed-marketplace "Test Project" (`path` = container cwd) is superseded by this for dogfooding.

### Per-project tool-permission mode

8. Stored as a **settings KV entry**, not a project column: key `project:<projectId>:tool_permission_mode`, value one of `ask` / `auto-edit` / `yolo`. Read/written by `handleGetPermissionMode` / `handleSetPermissionMode` in `src/routes/tool-permission.ts`, fronted by `web/src/routes/api/projects/[id]/tool-permission-mode/+server.ts`. `GET` falls back to `DEFAULT_PERMISSION_MODE` (`"yolo"`) when unset. `PUT` upserts the setting and, if a `conversationId` is supplied, emits a `tool:permission_mode_change` bus event so live UIs update.

### The install-root resolver (host-internal, unrelated)

9. `getProjectRoot()` / `resolveProjectRoot()` (`src/extensions/bundled.ts`) resolve the EZCorp checkout root, first-match-wins:
   1. `EZCORP_PROJECT_ROOT` env var — accepted only if it exists **and** contains `docs/extensions/examples/` (a stale/typo'd value falls through rather than failing closed).
   2. substring match on `import.meta.dir` / `import.meta.url` containing `src/extensions` (direct `bun src/...` runs).
   3. `.git` walk-up from the meta dir then `process.cwd()`, accepted only if the result contains `docs/extensions/examples/` (needed under `vite preview`, where the bundler rewrites `import.meta.url`).
   4. `process.cwd()` fallback with a WARN log.
   The result is cached process-lifetime (`__resetProjectRootCacheForTests` resets it for tests).
10. **Consumers**: `ensureBundledExtensions()` joins `getProjectRoot()` with each bundled entry's `path` to load its on-disk manifest; the `$CWD` extension-grant token expands to `getProjectRoot()` via `grantCwdBase()` in `src/extensions/permissions.ts` (`expandGrantPrefix`); the registry injects `EZCORP_EXTENSION_DATA_ROOT = getProjectRoot()` into extension subprocess env. In production the host cwd already **is** the install root (`/app`), so `$CWD` → project-root is a no-op there; it only matters under the vite-SSR dev server where host cwd is `/app/web`.

## Usage

**REST**

- `GET /api/projects` — list all projects (requires `read` scope + auth).
- `POST /api/projects` — create. Body `{ name, path, icon?, variables? }`; returns `201`.
- `GET /api/projects/:id` — fetch one (`404` if missing).
- `PUT /api/projects/:id` — partial update of `name` / `path` / `icon` / `variables`.
- `DELETE /api/projects/:id` — delete (cascades to conversations).
- `GET /api/projects/:id/tool-permission-mode` — `{ mode }` (defaults `"yolo"`).
- `PUT /api/projects/:id/tool-permission-mode` — body `{ mode, conversationId? }`; `mode ∈ {ask, auto-edit, yolo}` (`chat` scope for `PUT`, `read` for `GET`).
- `/api/projects/:id/features…` — the per-project feature index lives under this prefix (separate feature; see [[feature-index]]).

**Frontend**

- `web/src/lib/api.ts` — `fetchProjects` / `createProject` / `updateProject` / `deleteProject` client helpers.
- `web/src/lib/components/ProjectForm.svelte` — create/edit form (default new-project path `/app/projects/`, the docker-compose host bind mount).
- `web/src/lib/components/ProjectPicker.svelte`, `ProjectRail.svelte` — workspace selection UI.
- `web/src/lib/components/PermissionModeIndicator.svelte` — surfaces / toggles the per-project mode.
- `web/src/lib/stores.svelte.ts` — `activeProjectId` state, persisted to `localStorage` (key `activeProjectId`), defaulting to the `"global"` sentinel (a non-project scope used by cross-project surfaces like memories/search, **not** a real project id).

**Env vars / settings**

- `EZCORP_PROJECT_ROOT` — explicit override for the install-root resolver (must contain `docs/extensions/examples/`).
- `EZCORP_SELF_PROJECT_PATH` / `EZCORP_SELF_PROJECT_NAME` — boot-seed the `self` project **record** at that path (dev-compose dogfooding). Despite the similar name, unrelated to `EZCORP_PROJECT_ROOT`: this creates a user-facing workspace row; the other configures the host-internal install-root resolver.
- `EZCORP_EXTENSION_DATA_ROOT` — injected into extension subprocesses; derived from `getProjectRoot()`.
- Settings key `project:<id>:tool_permission_mode` — per-project mode (not a project column).
- Settings key `project:<id>:systemPrompt` — per-project standing prompt; seeded once for `self` with self-modification guidance.

## Key files

- `src/db/schema.ts` — `projects` table (id/name/path/icon/variables/timestamps); `conversations.projectId` notNull FK.
- `src/db/queries/projects.ts` — project CRUD queries (no user filter).
- `src/db/seed-self-project.ts` — env-gated boot seed of the `self` project + its guidance prompt (called from `migrate()`).
- `web/src/routes/api/projects/+server.ts` — list / create routes.
- `web/src/routes/api/projects/[id]/+server.ts` — get / update / delete routes.
- `web/src/routes/api/projects/[id]/tool-permission-mode/+server.ts` — per-project mode route shim.
- `src/routes/tool-permission.ts` — `handleGet/SetPermissionMode` (settings-KV backed) + the tool-call approval handler.
- `src/runtime/executor.ts` — `resolveInput` merges `cwd: project.path` + `project.variables` into agent input.
- `web/src/routes/api/conversations/[id]/messages/+server.ts` — loads `getProject(conv.projectId)`, passes `project.path` as `projectRoot` to the runtime.
- `src/runtime/tools/validate.ts` — `validatePath` lexical containment against `projectRoot`.
- `src/runtime/fs/scan-fs.ts` — `realpathInsideRoot` (realpath-based scanner containment).
- `src/extensions/bundled.ts` — `getProjectRoot` / `resolveProjectRoot` install-root resolver + `BUNDLED_EXTENSIONS`.
- `src/extensions/permissions.ts` — `grantCwdBase` / `expandGrantPrefix` ($CWD → install root).
- `web/src/lib/components/ProjectForm.svelte`, `ProjectPicker.svelte`, `ProjectRail.svelte`, `PermissionModeIndicator.svelte` — UI.
- `web/src/lib/api.ts`, `web/src/lib/stores.svelte.ts` — client helpers + `activeProjectId` store.

## Features it touches

- [[conversations]] — every conversation has a `notNull` `projectId`; deleting a project cascades its conversations.
- [[builtin-file-tools]] — file tools resolve relative paths against the active project's `path`.
- [[mention-grammar]] — the `@[file:…]` / `@[dir:…]` sigils scan the active project's filesystem.
- [[rbac-and-permission-modes]] — per-project `tool_permission_mode` selects approval friction.
- [[permissions-and-grants]] — the `$CWD` extension grant expands to the install root (`getProjectRoot()`), not the project path.
- [[bundled-catalog]] — `ensureBundledExtensions` joins `getProjectRoot()` with each entry's path to load manifests.
- [[runtime-and-rpc]] — `EZCORP_EXTENSION_DATA_ROOT` (from `getProjectRoot()`) is injected into extension subprocesses.
- [[feature-index]] — features live under `/api/projects/:id/features`, scoped to the active project.
- [[persistent-memory]] — memories FK to `projects` and can be project-scoped or global.
- [[runs-lifecycle]] — runs carry a nullable `projectId`.
- [[api-security]] — project routes gate on `requireAuth` + `requireScope`.

## Related docs

- [extension data storage convention](../../extensions/data-storage.md) — the `<projectRoot>/.ezcorp/extension-data/<name>/` path that `$CWD` / `getProjectRoot()` anchors.
- The user-facing project record itself has no dedicated doc — this is the primary reference.

## Notes & gotchas

- **Projects are NOT user-scoped.** Despite the "user-scoped project records" framing in some prior notes, the `projects` table has no `userId` column and the queries apply no ownership filter — `listProjects()` returns every project on the instance, and any authenticated caller with `read` scope can read/update/delete any project by id. Conversations *are* user-owned (`conversations.userId`), but their containing project is shared.
- **Two unrelated "project" concepts.** `project.path` (a user-chosen workspace dir, e.g. `/app/projects/foo`) and `getProjectRoot()` (the EZCorp install root, e.g. `/app`) are independent. `getProjectRoot()` is **never** derived from a project record and a project's `path` is **never** the `$CWD` grant base. Conflating them is the easiest mistake here.
- **Lexical vs realpath containment asymmetry.** Built-in file tools use `validatePath` (lexical `startsWith`, no realpath), while the `@`-mention scanner uses `realpathInsideRoot` (realpath). A symlink inside `project.path` pointing outside it is filtered by the scanner but **not** by the lexical tool check — the tool would resolve through it. This is a known asymmetry, not a fixed bug.
- **`DEFAULT_PERMISSION_MODE = "yolo"`** (`src/runtime/tools/permissions.ts`) is an intentional, permanent product decision; the per-project mode falls back to it when unset. Not a security finding.
- **Cross-tenant active-run IDOR (open).** `web/src/routes/api/conversations/[id]/active-run/+server.ts` calls only `requireAuth` + `requireScope` with **no conversation-ownership check** — SvelteKit does not wrap a child `+server.ts` in a parent guard. A user can read another tenant's live `partialResponse` or cancel their run by id. Still open as of this writing; relevant here because a conversation's project binding does not add any ownership gate.
- **`activeProjectId === "global"`** is a sentinel for cross-project surfaces (memories, Cmd+K search), not a real project id — guard for it before treating it as a uuid.
- **`$CWD` is a dev-only widening.** In production host cwd already equals the install root, so `$CWD → getProjectRoot()` is a no-op; it only differs under the vite-SSR dev server (`/app/web` → `/app`), which can only *permit* more, never less. `getProjectRoot` is imported **statically** in `permissions.ts` because a lazy `require` silently fails under the vite-SSR transform.
- **Project deletion cascades.** Because `conversations.projectId` is `onDelete: "cascade"`, `DELETE /api/projects/:id` silently removes every conversation in that project (and, transitively, their messages/runs). The route does no confirmation or soft-delete.

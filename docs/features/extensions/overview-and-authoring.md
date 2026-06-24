# Extension Authoring & SDK

> _How a user-built EZCorp extension is declared, scaffolded, tested, and shipped: a single `ezcorp.config.ts` descriptor, the `@ezcorp/sdk` package (types + host-mediated runtime helpers + entity CRUD), a `bun src/cli.ts ext …` dev loop, and a deterministic zero-LLM `verify` gate._

## Intent

Extensions are EZCorp's primary extensibility surface — user-built packages that add LLM-callable tools, prompt skills, agent personas, Hub pages, message-toolbar buttons, settings forms, and managed entity types. Each extension is one directory whose `ezcorp.config.ts` declares everything the host needs, and whose capabilities are declared in the manifest, granted by the user at install, and re-intersected on every call. The `@ezcorp/sdk` package gives authors typed manifest helpers, a pure scaffolder, host-mediated runtime wrappers (so extension subprocesses never touch raw `node:fs`/`child_process`), and entity CRUD generation. The whole loop is anchored on one machine-checked acceptance contract — `ezcorp ext verify` — so "done" is never a self-judged "looks installed".

## How it works

### The descriptor (`ezcorp.config.ts` → `defineExtension`)

- An extension's entry point is a default-exported manifest wrapped in `defineExtension(...)` from `@ezcorp/sdk`. `defineExtension` is an identity function (like Vite's `defineConfig`) — it only provides type inference; at load time its function-valued props (e.g. tool `handler` references) are stripped before validation (`packages/@ezcorp/sdk/src/define.ts`).
- The manifest type is `ExtensionManifestV2` (`packages/@ezcorp/sdk/src/types.ts`). The type literally pins `schemaVersion: 2`, but the validator accepts **`2` or `3`** (a v3 manifest skips the migration below). Required scalar fields: `name`, `version` (strict `x.y.z` semver), `description`, `author.name`. The `permissions` block is required by the TS type but tolerated empty by the validator (the scaffold emits `permissions: {}`). Optional component blocks: `tools[]`, `skills[]`, `agent`, `mcpServers[]`, `scripts`, `panel`, `pages[]` (Hub, max 3), `messageToolbar[]`, `entities[]`, `settings`, `acceptedAttachmentMimes[]`, `lifecycleHooks[]`, `dependencies`, `resources` (`memory`/`storage`/`callTimeoutMs`), and the `smokeTest` block.
- `entrypoint` (a relative, no-`..`, non-absolute path) is **required when `tools[]` is non-empty** and `kind !== "mcp"`. `skill`/`agent` packages declare no entrypoint.
- A v2 manifest is auto-promoted to v3 shape on load via `migrateManifestV2ToV3` (`src/extensions/manifest.ts`): every tool inherits the extension-wide permission ceiling translated into a per-tool `CapabilityDeclaration` (`deriveCapsFromExtensionPerms`), and authored per-tool `capabilities` are preserved exactly — the migration **never widens** an authored cap set.

### Validation (`validateManifestV2`)

`src/extensions/manifest.ts` is a hand-rolled (non-Zod) error-array validator. It runs at install time and inside `verify`. It enforces:

- `name` matches `/^[a-z0-9][a-z0-9-_.]{0,63}$/` and contains no `..` (filesystem-safe — it becomes a directory name under `data/extensions/<name>`).
- Per-component shape: each tool needs `name`/`description`/`inputSchema`; v3 per-tool `capabilities` shape; skills need `name`/`description`; MCP servers need a valid `transport` (`stdio`|`http`|`sse`); `agent.prompt` is required.
- `messageToolbar[]` ids are slugs, deduped, and each `event` MUST be prefixed `<manifest.name>:` and also listed in `permissions.eventSubscriptions` (mirrors the dispatcher's namespace rule).
- `pages[]` capped at **3**, with title/description length caps.
- `settings` keys match `/^[a-z][a-z0-9_]{0,63}$/`; each field is `select`/`text`/`number`/`boolean` with default/bounds cross-checks (the same per-rule predicates drive admit-time errors and clamp-time coercion via `isValidForField`).
- `entities[]` via `validateEntitiesArray`; `dependencies` via `validateDependencies` (exact `1.2.3` or caret `^1.2.3` only — no `~`/`*`/`>=`); `acceptedAttachmentMimes[]` against an RFC-6838 token regex.
- `smokeTest` is **OPTIONAL in the base validator** (the bundled corpus predates it) but cross-checks `smokeTest.tool` against declared tool names when present. The author path makes it required for tool/multi.

### Scaffolding (`scaffoldExtension` + 4 templates)

- `scaffoldExtension({ name, type, description })` (`packages/@ezcorp/sdk/src/scaffold/index.ts`) is a **pure** function: it returns `{ files: Record<relpath, content> }` and never touches disk. It throws on a bad `name` (re-checks the host's `NAME_REGEX`) or `type`.
- The four `ExtType`s are `tool` | `skill` | `agent` | `multi`. Every type emits `ezcorp.config.ts`, `index.test.ts`, `README.md`, `.gitignore`, `tsconfig.json` (standalone, resolves `@ezcorp/sdk` from npm), and `package.json`. `tool`/`multi` additionally emit `index.ts`; `skill`/`agent` omit it (prompt/persona-only).
- The `tool`/`multi` scaffold ships a valid `smokeTest` wired to the example tool and an `index.ts` JSON-RPC stdio server that runs its loop **only** under `import.meta.main` (so importing it for `handleRequest` / tests / `loadManifest` doesn't lock stdin's reader).
- Two consumers wrap the pure scaffolder: the CLI's `initExtension` (`src/extensions/sdk/init.ts`, writes files via `Bun.write`) and the in-app `extension-author` bundled extension (writes to a draft dir). External LLMs building extensions can `import { scaffoldExtension } from "@ezcorp/sdk"` directly.

### The `@ezcorp/sdk` package (4 entry points)

`packages/@ezcorp/sdk/package.json` exports four subpaths (Bun resolves `./src/*.ts` directly; published consumers get `./dist`):

- **`.`** — manifest types, `defineExtension`, `scaffoldExtension`/`EXT_TYPES` (`src/index.ts`).
- **`./runtime`** — host-mediated runtime helpers used inside a tool subprocess (`src/runtime/index.ts`): `getChannel`/`JsonRpcError`, `createToolDispatcher`/`toolResult`/`toolError`, host-mediated fs (`fsRead`/`fsWrite`/`fsList`/…), `withLock`, `fetchPermitted`, `Storage`, `Memory`, `Lessons`, `Llm`, `Search`, `Schedule`, `AgentConfigs`, `TaskEvents`, `Events`, `spawnAssignment`, `cancelRun`, `PageBuilder`/`PanelBuilder`/`createCanvas`, `getSetting`, `registerLifecycleHook`, and the `defineLoop` loop primitive.
- **`./entities`** — entity declaration/validation + auto-CRUD tool generation (`buildEntityToolMap`, `buildEntityToolDefinitions`, `validateRecord`, slug helpers). There is **no `defineEntity` function** — entity types are declared declaratively via the manifest's `entities[]` array, and the host auto-generates 5 CRUD tools per declaration (`list_<plural>`, `get_<sing>`, `create_<sing>`, `update_<sing>`, `delete_<sing>`).
- **`./test`** — a placeholder barrel today (empty export); the published `./test` map entry is reserved for the test harness.

### Capabilities & reverse-RPC

A tool subprocess never gets raw OS access. It calls host services back over the **same stdio channel** via reverse-RPC methods the host routes in `src/extensions/tool-executor.ts` (`ezcorp/storage`, `ezcorp/memory`, `ezcorp/lessons`, `ezcorp/append-message`, `ezcorp/spawn-assignment`, `ezcorp/llm-complete`, `ezcorp/drafts`, …). Each method is gated by a declared permission (`storage: true`, `spawnAgents: { maxPerHour }`, etc.). The SDK runtime wrappers (`Storage`, `Memory`, `spawnAssignment`, …) are thin clients over these methods.

### The deterministic acceptance gate (`verify`)

`src/extensions/sdk/verify.ts` is a zero-LLM, schema-driven pipeline — the single source of "done":

1. `loadManifest(extDir)` → structured FAIL if it can't load.
2. `validateManifestV2(manifest)` → FAIL on any error.
3. If the manifest declares LLM-callable `tools[]` (and is not `kind:"mcp"`), a `smokeTest` block is **required** (`requiresSmokeTest`); absence is a FAIL. `skill`/`agent`/`mcp` with no smokeTest pass on manifest validation alone.
4. `createTestExtension(extDir, { sandbox: true })` → `proc.callTool(smokeTest.tool, smokeTest.input)` → `assertToolResult(result, { isError, text: textIncludes })` → `proc.kill()` in a `finally` on every path.
5. Returns `VerifyResult { pass, steps: { name, ok, detail }[] }`; the CLI exits `0` iff `pass`.

### Install path

`installFromLocal` (`src/extensions/installer.ts`) loads + validates the manifest, runs the **env-key-leak install gate** (`src/extensions/clamp-permissions.ts:checkEnvKeyLeakInstallGate`, pattern `/(_API_KEY|TOKEN|SECRET)$/i`), prompts for / clamps permissions, and persists the extension. The in-app `extension-author` install endpoint runs the same secure pipeline plus a hard `verify` smoke-test gate for tool/multi.

## Usage

### CLI (`bun src/cli.ts ext …`, shorthand `ezcorp ext …`)

There is no installed `ezcorp` binary; the CLI is `src/cli.ts`, invoked from the repo root as `bun src/cli.ts ext …` or `bun index.ts ext …` (`index.ts` calls `cli(Bun.argv.slice(2))`). The `ext` subcommands (`src/cli.ts`):

| Command | Purpose |
|---|---|
| `ext init <name> [--type tool\|skill\|agent\|multi]` | Scaffold a new extension directory (interactive wizard if no `--type`). |
| `ext install <source> [--yes]` | Install from a local path or git source (with dependency resolution + permission prompting). |
| `ext update [name]` | Update one extension, or all; warns on dependent version incompatibility. |
| `ext list` | Table of installed extensions (name/version/source/status/deps). |
| `ext remove <name> [--force]` | Remove; blocked if a dependent requires it unless `--force`. |
| `ext info <name>` | Detail: version, author, permissions, tools/skills/agent, dependency tree, "Required by". |
| `ext dev [dir]` | Dev server: installs from local, watches with debounce, hot-reloads the registry. |
| `ext test [dir] [--filter <name>]` | Run `bun test` under `prlimit` RSS cap + filtered env; folds in the `verify` smoke round-trip when a `smokeTest` is declared. |
| `ext verify [dir] [--json]` | The authoritative deterministic acceptance gate; exit 0 iff `pass`. |
| `ext publish [--token <token>]` | Validate → verify token → run tests → publish a version to the marketplace. |

(Outside `ext`: `ezcorp key mint …` mints a remote-control API key; `ezcorp serve`/`run`/`pipeline` drive the runtime.)

### SDK (npm package `@ezcorp/sdk`)

```ts
import { defineExtension, scaffoldExtension } from "@ezcorp/sdk";
import { createToolDispatcher, toolResult, Storage } from "@ezcorp/sdk/runtime";
import { buildEntityToolMap } from "@ezcorp/sdk/entities";
```

### In-app authoring (the `extension-author` bundled extension)

A user can ask the chat assistant to build an extension. The `extension-author` extension (`docs/extensions/examples/extension-author/`) exposes a fixed 3-step tool chain — `create_extension` (scaffold a draft) → `validate_extension` (run the host's `verify` gate, returns the structured `VerifyResult`) → `install_draft` (install the validated draft behind a one-time permission card). `modify_extension` re-opens an already-installed, admin-flagged-`modifiable`, user-authored extension for in-place edit + re-install.

### JSON-RPC tool contract

Tool servers read newline-delimited JSON-RPC 2.0 on stdin and write one JSON object per line on stdout. `tools/call` params are `{ name, arguments }`; results are `{ content: [{ type:"text", text }], isError }`. Echo the request `id` exactly. The per-call timeout defaults to **30 s** (override via `resources.callTimeoutMs`). Memory cap defaults to `DEFAULT_MEMORY_LIMIT_MB` (override via `resources.memory`).

### Env vars / gates

- **env-key-leak install gate** — `permissions.env` entries matching `/(_API_KEY|TOKEN|SECRET)$/i` are refused at install for user-authored extensions (pass credentials as tool inputs instead). The only exemption is a **bundled** extension entry that opts in with the per-entry `envEscapeHatch: true` flag (`BundledExtension.envEscapeHatch` in `src/extensions/bundled.ts`); a bundled entry without it still fails closed.
- `__EZCORP_TEST_EXTENSIONS_DIR` — install target override for tests.

## Key files

- `packages/@ezcorp/sdk/src/define.ts` — `defineExtension` identity helper + the `ExtensionConfig` type that admits function-valued handler props.
- `packages/@ezcorp/sdk/src/types.ts` — `ExtensionManifestV2` (the descriptor), permission/resource/smokeTest shapes, JSON-RPC types.
- `packages/@ezcorp/sdk/src/index.ts` — public barrel: types + `defineExtension` + `scaffoldExtension`.
- `packages/@ezcorp/sdk/src/runtime/index.ts` — runtime helpers barrel (host-mediated fs/storage/llm/search/loop/etc.).
- `packages/@ezcorp/sdk/src/entities/index.ts` — entity declaration/validation + auto-CRUD tool builders barrel.
- `packages/@ezcorp/sdk/src/scaffold/index.ts` — pure `scaffoldExtension` + `EXT_TYPES`.
- `packages/@ezcorp/sdk/src/scaffold/templates/{tool,skill,agent,multi}.ts` — the four template generators (manifest + entrypoint + test + README).
- `packages/@ezcorp/sdk/package.json` — the four export subpaths (`.`, `./runtime`, `./test`, `./entities`).
- `src/cli.ts` — `cli()` entry; `ext init/install/update/list/remove/info/dev/test/verify/publish` + `key mint`.
- `src/extensions/manifest.ts` — `validateManifestV2`, `migrateManifestV2ToV3`, `deriveCapsFromExtensionPerms`, `satisfiesRange`, `generateSlug`, the `NAMESPACE_MAP`.
- `src/extensions/sdk/verify.ts` — the deterministic zero-LLM acceptance pipeline (`verifyExtension` → `VerifyResult`).
- `src/extensions/sdk/init.ts` — CLI wrapper around `scaffoldExtension` (dir create + `Bun.write`).
- `src/extensions/sdk/dev.ts` — `startDevServer`: local install + recursive watch + registry hot-reload.
- `src/extensions/sdk/test-runner.ts` — `bun test` under `prlimit` + filtered env; folds in the `verify` smoke round-trip.
- `src/extensions/sdk/publish.ts` — marketplace publish pipeline (token verify, tests, version record).
- `src/extensions/loader.ts` — `loadManifest`/`loadManifestFresh`.
- `src/extensions/installer.ts` — `installFromLocal`, `installWithDependencies`, update/remove.
- `src/extensions/clamp-permissions.ts` — `checkEnvKeyLeakInstallGate` (the `_API_KEY|TOKEN|SECRET` gate) + permission clamping.
- `src/extensions/tool-executor.ts` — host-side reverse-RPC router (`ezcorp/storage`, `ezcorp/spawn-assignment`, …).
- `src/extensions/bundled.ts` — `BUNDLED_EXTENSIONS` (24 boot-wired entries).
- `docs/extensions/AUTHORING.md` — the canonical authoring contract (consulted by the `extension-author` tools).

## Features it touches

- [[permissions-and-grants]] — manifest permissions are declared here, granted at install, and intersected at every call.
- [[runtime-and-rpc]] — tool subprocesses speak JSON-RPC over stdio and call host services via reverse-RPC.
- [[sandbox-and-isolation]] — `verify`/`ext test` spin the extension up sandboxed; the host-mediated fs helpers exist because raw `node:fs` is poisoned in the sandbox.
- [[data-and-entities]] — `entities[]` declarations auto-generate the 5-tool CRUD surface via `@ezcorp/sdk/entities`.
- [[hub-pages]] — `pages[]` (max 3) contributes tabs to the Extension Hub.
- [[message-toolbar]] — `messageToolbar[]` buttons emit namespaced bus events.
- [[settings]] — `settings` declares the per-extension user-editable config form.
- [[mcp-servers]] — `kind:"mcp"` manifests connect to a live MCP server instead of spawning a subprocess.
- [[marketplace]] — `ext publish` ships versions; `ext install <source>` pulls them.
- [[bundled-catalog]] — `BUNDLED_EXTENSIONS` boot-wires the first-party extensions using this same descriptor.
- [[scheduling-and-loops]] — the `defineLoop` primitive and `Schedule` helper ship from `@ezcorp/sdk/runtime`.
- [[web-search]] — the `Search` runtime wrapper + `permissions.search` brokered surface.
- [[persistent-memory]] — the `Memory` runtime wrapper over `ezcorp/memory` reverse-RPC.
- [[lessons]] — the `Lessons` runtime wrapper over `ezcorp/lessons` reverse-RPC.
- [[canvas-cards]] — `createCanvas`/`PanelBuilder` runtime UI builders.
- [[attachments]] — `acceptedAttachmentMimes[]` unions extension MIMEs into the composer accept list.
- [[developer-api-keys]] — `ext publish` authenticates with a developer publish token; `key mint` mints remote-control keys.

## Related docs

- [Extension authoring guide](../../extensions/AUTHORING.md) — the canonical, host-authoritative authoring contract.
- [Getting started](../../extensions/getting-started.md) — first tool/skill walkthrough.
- [Manifest schema](../../extensions/manifest-schema.md), [security model](../../extensions/security.md), [settings](../../extensions/settings.md), [data storage](../../extensions/data-storage.md), [pages](../../extensions/pages.md), [message toolbar](../../extensions/message-toolbar.md), [canvas cards](../../extensions/canvas-cards.md), [loops](../../extensions/loops.md), [API reference](../../extensions/api-reference.md).

## Notes & gotchas

- **No `defineEntity` export.** Entity types are declared declaratively in the manifest's `entities[]` array (validated by `validateEntitiesArray`); `@ezcorp/sdk/entities` exposes the validation + auto-CRUD *builders* the host uses, not a `defineEntity` wrapper. Records live in reserved storage keys (`__entity:<type>:<slug>` + `__entity-index:<type>`) extensions may not write directly.
- **`schemaVersion` accepts 2 *and* 3.** Authors keep writing v2; the loader runs `migrateManifestV2ToV3` so every downstream consumer (registry, tool-executor, PDP, audit) sees v3 per-tool capabilities. The migration never widens an authored cap set.
- **`smokeTest` is optional in `validateManifestV2`, required via the author path.** The base validator keeps it optional so the bundled corpus stays valid; `verify` makes it mandatory for any extension with non-MCP `tools[]`, and the `extension-author`/web install endpoint hard-fails (4xx) a missing/failing tool-or-multi smoke test. "Installed/enabled" is registry state — it is *not* acceptance.
- **`./test` SDK entry is a stub.** `packages/@ezcorp/sdk/src/test/index.ts` is an empty barrel today; test helpers used by `verify` (`createTestExtension`, `assertToolResult`) live host-side in `src/extensions/sdk/test-helpers.ts`, not in the published `./test` map yet.
- **Examples on disk ≠ bundled at boot.** `docs/extensions/examples/` has ~39 directories (including `test-*` fixtures and `harness-smoke-test`); `BUNDLED_EXTENSIONS` wires **24** of them at boot. Do not conflate the two counts.
- **Env-key-leak gate is end-anchored + uppercase-leaning.** `/(_API_KEY|TOKEN|SECRET)$/i` refuses `OPENAI_API_KEY`, `GITHUB_TOKEN`, `MY_SECRET`; but `secret_value` (suffix not at end) and `WEATHER_DEBUG` pass. There is no host-brokered `ctx.secrets` surface yet — pass credentials as tool inputs.
- **Built-in file-tool path containment is lexical, the FS scanner is realpath.** The built-in file tools' `validatePath` (`src/runtime/tools/validate.ts`) checks containment *lexically* (no `realpath`), while the `@`-autocomplete FS scanner (`src/runtime/fs/scan-fs.ts` `realpathInsideRoot`) resolves symlinks. This asymmetry matters when an extension's filesystem grant overlaps a symlinked path — see [[sandbox-and-isolation]] / [[builtin-file-tools]].
- **`DEFAULT_PERMISSION_MODE = "yolo"` is intentional.** The runtime's default permission mode (`src/runtime/tools/permissions.ts`) is a permanent product decision, not a security gap; it does not weaken the manifest declare→grant→intersect model.
- **`ext init` refuses an existing directory**, and the scaffolder throws on a name that fails `/^[a-z0-9][a-z0-9-_.]{0,63}$/` or contains `..`.
- **`entrypoint` must stay inside the install dir.** Absolute paths and `..` segments are rejected at validation — a malicious manifest cannot point the entrypoint at `/etc/shadow` or `../../node_modules/...`.

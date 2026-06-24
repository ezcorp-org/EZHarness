# Built-in File & Shell Tools

> _The host-side LLM toolset every project chat gets for free — `readFile`, `listFiles`, `readDirectory`, `editFile`, `shell`, `grep`, `glob` — each path-contained to the project root, output-capped below the model's input ceiling, and filterable by mode/team/conversation scope._

## Intent

These seven tools are the agent's hands on the filesystem and shell. Unlike the rest of EZCorp's tool surface (which lives in sandboxed extensions), the file tools are **host-side built-ins**: they run in-process with direct `Bun.file` / `Bun.spawn` access, scoped to the active project's directory. They exist so a chat can read, search, edit, and execute against a real codebase without the round-trip cost of the extension subprocess, while three layers — lexical path containment, per-tool output caps, and the layered tool filter — keep a single runaway call from escaping the project root, poisoning the conversation history, or surviving a restrictive mode.

## How it works

### Construction

- `getBuiltinToolDefs(projectPath, preview?, shellSandbox?)` (`src/runtime/tools/index.ts`) builds the seven `BuiltinToolDef`s by calling each factory (`createReadFileTool`, `createListFilesTool`, `createReadDirectoryTool`, `createEditFileTool`, `createShellTool`, `createGrepTool`, `createGlobTool`). The `projectPath` is captured in each tool's closure — it is the containment root for that tool's entire lifetime.
- After building, the loop stamps each def's `maxOutputBytes` from `getToolOutputLimit(name)` and **appends the cap sentence to the description** (`describeOutputCap`) so the LLM and any UI both see the limit inline.

### Wiring into a run (`src/runtime/stream-chat/setup-tools.ts`)

1. When `options.projectId` resolves to a project with a `path`, setup-tools calls `getBuiltinToolDefs(project.path, previewWiring)` and registers every def into `ctx.builtinToolDefsMap` (name → def, used later for category lookups by the filter).
2. Each def is wrapped into an `AgentTool` whose `execute` first consults the **permission gate** (`needsApproval(def.category, permissionMode)` → emits `tool:permission_request` + blocks on `createPermissionGate` when the mode requires it), then delegates to `def.execute`. The wrapper also registers a per-call `AbortController` in `ctx.toolAbortControllers` so an in-flight tool can be cancelled.
3. The wrapped tools are pushed onto `ctx.agentTools`.

### Per-tool behavior

- **`readFile`** (`read`, card `default`) — `Bun.file(resolved).text()`, then `truncateText(...)` to the default 8 MiB cap. Surfaces `Error: …` text on read failure.
- **`listFiles`** (`read`, `default`) — `readdir(withFileTypes)`, marks directories with a trailing `/`, optional `Bun.Glob` filter on the basename.
- **`readDirectory`** (`read`, `default`) — ASCII tree (`├──` / `└──`) up to `depth` clamped to 1–3 (default 2); skips dotfiles and `node_modules`.
- **`editFile`** (`write`, card `diff`) — three modes selected by which args are present:
  - **create/overwrite** (no `old_string`) — `mkdir -p` the parent dir, write `new_string` whole. Returns the prior content as `details.oldContent` (or `null`) for the diff card.
  - **search-and-replace** (`old_string` set) — exact substring match; **errors if found 0 times**, and **errors if found >1 time unless `replace_all: true`**. Empty `old_string` is rejected (omit it to create instead).
  - **line range** (`lineRange: {startLine, endLine}`, 1-indexed inclusive) — splices the range out and inserts `new_string`'s lines; validates the range against the file length.
- **`shell`** (`execute`, card `terminal`) — see the dedicated section below.
- **`grep`** (`read`, card `search-results`) — see below.
- **`glob`** (`read`, card `search-results`) — `Bun.Glob(...).scan({ cwd, dot: false })`, capped at `maxResults` (default 200), sorted, with an inline `[truncated at N results]` marker.

### Path containment — `validatePath` (lexical)

Every file-touching tool resolves its `path` arg through `validatePath(projectPath, relPath)` (`src/runtime/tools/validate.ts`):

- `resolve(projectPath, relPath)` then a `relative()` check — if the result starts with `..` **or** the absolute path doesn't `startsWith(projectPath)`, it throws `"Path traversal detected"`.
- This is a **lexical** check — it operates on resolved strings, **never `realpath`**. A symlink inside the project whose target lives outside the project root passes this check (the resolved string still starts with `projectPath`). This is an intentional asymmetry with the `@`-mention FS scanner (`src/runtime/fs/scan-fs.ts`'s `realpathInsideRoot`), which **does** `realpath` and would reject such a symlink. See gotchas.

### The `shell` tool (`src/runtime/tools/shell.ts`)

1. **Audit log** — every command is logged (`shell-audit`: command, cwd, timestamp).
2. **Dangerous-command blocklist** — `DANGEROUS_COMMAND_PATTERNS` (regex list) blocks `rm -rf /`, `mkfs.*`, `dd ... of=/dev/*`, `chmod` of `/etc|/usr|/bin|/sbin`, `> /etc/...`, and `curl|wget … | sh`. A match returns `"command blocked by security policy"` with `exitCode: -1` **before** spawning.
3. **Timeout** — `validateTimeout(params.timeout)` clamps to `[1000, 600000]` ms (default 120000). The tool's `callTimeoutMs` is pinned to **600 000 ms** so the executor watchdog can't preempt a legitimately long build/test before the tool's own timeout fires.
4. **Secret-env stripping** — `sanitizeEnv()` copies `process.env` minus any key matching `/SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY/i`, so the child shell never inherits provider keys or the JWT secret.
5. **Optional preview launch** — if `ShellPreviewWiring` is threaded (conversation owner present) and `detectDevServerCommand(command)` recognizes a dev server, `preview.launch(...)` runs it under the conversation's **preview uid** (fs-isolated, uid-attributed) instead of the normal spawn. A refusal (`{ok:false}`) falls back to the normal path — fail-safe.
6. **Optional per-run sandbox** — `resolveShellSandbox(command, sandbox)` builds a jailed argv via `buildSandboxArgv` when `ShellSandboxWiring` is present **and** the host has a non-advisory sandbox tier. The jail makes the per-run `workspaceDir` the only writable host path and excludes `.ezcorp/data`. A build failure logs + falls back to the bare spawn. **Not wired by the live chat path today** — see gotchas.
7. **Spawn** — `Bun.spawn(["/bin/sh","-c",command], { cwd, env })` (or the jailed argv). stdout streams back through `onUpdate` in real time; both stdout and stderr are bounded to the shell's **1 MiB** cap by `readStream` (closing the reader SIGPIPEs an unbounded producer like `yes`). The execute body races process-completion vs. timeout vs. external abort.

### The `grep` tool (`src/runtime/tools/grep.ts`)

- **Backend** — `resolveBackend` prefers ripgrep (`Bun.which("rg")`, honours `.gitignore`, parallel) and falls back to GNU `grep -r`; `EZCORP_GREP_BACKEND` forces either. The GNU path manually adds `--exclude-dir` for `.git`, `node_modules`, `dist`, `build`, `coverage`, `.ezcorp`, `.svelte-kit`, `.next` (ripgrep gets this from `.gitignore` for free).
- **Argv** — `buildSearchArgs` is a pure flag translator; the pattern is passed after a `--` / `-e` guard so a leading-`-` pattern can't be parsed as a flag.
- **Soft timeout** — owned by the tool: `parseGrepTimeoutMs(EZCORP_GREP_TIMEOUT_MS)` (default 30 000 ms, clamped `[1000, 600000]`). On expiry it `proc.kill()`s and returns a graceful "narrow your pattern" message. The tool's `callTimeoutMs = softTimeout + 15000` is pinned **above** that soft timeout so the watchdog can never preempt the tool's own clean return (the bug that turned a slow grep into a whole-run kill).
- **Streams** — stdout and stderr are drained **concurrently** (`drainBounded`), each bounded to the grep cap, to avoid the stderr-pipe-fills-and-deadlocks-stdout stall on large trees.
- **Exit handling** — exit 2 with no output → real error; exit 1 or empty → "No matches found." `matchCount` counts only `filename:lineno:` lines (context lines and `--` group breaks excluded).

### Output caps (`src/runtime/tools/output-limits.ts`)

- `DEFAULT_MAX_OUTPUT_BYTES = 8 MiB` (2 MiB under OpenAI's 10 MiB single-input-string hard limit). Only `shell` overrides it, to **1 MiB** (`TOOL_OUTPUT_LIMITS`).
- `truncateText` (readFile, grep) cuts at the cap and appends a precise `[output truncated: X omitted of Y total …]` marker (non-fatal UTF-8 decode at the cut point). `buildStreamTruncationMarker` (shell) reports only the cap, since measuring the true total would require draining an unbounded stream.

### Tool filtering — `applyToolFilters` (`src/runtime/tools/filter.ts`)

Before every turn the executor (`src/runtime/executor.ts`) narrows `ctx.agentTools` through `applyToolFilters(tools, builtinToolDefsMap, opts)`, layered in this order:

1. **`toolRestriction`** — `read-only` keeps only `category === "read"` builtins (+ orchestration tools + host-vouched `readOnlyAllowedTools`); `none` strips all but orchestration; `allowlist` is a pass-through that fail-closes to orchestration-only if no `allowedTools` accompanies it; `all` is a no-op.
2. **`allowedTools`** — if non-empty, keep only those names (+ orchestration).
3. **`deniedTools`** — remove those names (+ orchestration always preserved).
4. **`forceDeniedTools`** — remove **unconditionally**, the **only** layer that can strip orchestration tools. Reserved for the conversation's explicit per-tool toggles (the composer's Tools dropdown), compiled by `computeModeToolScope` from `conv.extensionTools`.

`ORCHESTRATION_TOOLS` (e.g. `invoke_agent`, `ask-user__ask_user_question`, the `scratchpad__*` and `task_*` family) are preserved through every layer except `forceDeniedTools` — agents must always be able to delegate, coordinate, and ask for input. The `/api/tools` listing endpoint runs the **same** `computeModeToolScope` + `applyToolFilters` pair so the header tool-count badge matches the runtime surface exactly.

### Permission gate (`src/runtime/tools/permissions.ts`)

- `needsApproval(category, mode)` against the `AUTO_APPROVE` matrix: `ask` auto-approves `read`/`ez`; `auto-edit` adds `write`; `yolo` adds `execute` (everything). `DEFAULT_PERMISSION_MODE = "yolo"` — an **intentional, permanent product decision**, not a misconfiguration.
- The per-project mode is read from the `project:<id>:tool_permission_mode` setting (cached per run, overridable mid-run by the `tool:permission_mode_change` bus event).

## Usage

These tools are **not** invoked directly via a REST route — they are injected into the LLM's tool list for any project chat and called by the model during a streamed turn (`POST /api/conversations/[id]/messages` → `executor.streamChat`). They appear in the chat as their respective cards (`terminal`, `diff`, `search-results`, `default`).

- **Tool listing** — `GET /api/tools?modeId=&conversationId=` (`read` scope) returns the mode/conversation-scoped surface for the header badge. Note: this endpoint lists **extension** tools + whatever `getBuiltInToolMetadata()` carries — post-Phase-5 that is just the `ez` concierge metadata, with **no entries for the file tools**. The file tools are injected straight into `ctx.agentTools` in `setup-tools.ts`, not through that registry, so they never appear in the `/api/tools` listing — but they are still filtered identically at runtime via `ctx.builtinToolDefsMap`.
- **Permission mode** — set per project via the `project:<id>:tool_permission_mode` setting (`ask` | `auto-edit` | `yolo`); switch mid-run from the composer (emits `tool:permission_mode_change`).

### Env vars

| Var | Effect |
|---|---|
| `EZCORP_GREP_BACKEND` | Force `rg` or `grep` (debugging / tests); default auto-detects ripgrep. |
| `EZCORP_GREP_TIMEOUT_MS` | grep soft timeout (default 30 000, clamped 1 000–600 000). |

### Per-call tool args (the LLM-facing surface)

- `editFile`: `path`, `new_string`, optional `old_string`, `replace_all`, `lineRange{startLine,endLine}`.
- `shell`: `command`, optional `timeout` (default 120000, max 600000), `background`.
- `grep`: `pattern`, optional `path`, `include`, `caseSensitive`, `contextLines` (0–5), `maxResults`, `noIgnore`.
- `glob`: `pattern`, optional `path`, `maxResults` (default 200).
- `readFile` / `listFiles` / `readDirectory`: `path` (relative to project root), plus `pattern` (listFiles) / `depth` (readDirectory).

## Key files

- `src/runtime/tools/index.ts` — `getBuiltinToolDefs`: assembles the seven defs, stamps `maxOutputBytes`, appends the cap to each description.
- `src/runtime/tools/types.ts` — `BuiltinToolDef`, `ToolCategory` (`read`/`write`/`execute`/`ez`), `CardType`, `PermissionMode`, `callTimeoutMs`.
- `src/runtime/tools/read-file.ts` — `readFile` (`Bun.file().text()` + `truncateText`).
- `src/runtime/tools/list-files.ts` — `listFiles` (`readdir` + optional `Bun.Glob` basename filter).
- `src/runtime/tools/read-directory.ts` — `readDirectory` (ASCII tree, depth 1–3, skips dotfiles + `node_modules`).
- `src/runtime/tools/edit-file.ts` — `editFile`: create/overwrite, search-replace, and line-range modes; returns old/new content for the diff card.
- `src/runtime/tools/shell.ts` — `shell`: blocklist, `sanitizeEnv` secret stripping, `/bin/sh -c` spawn, streaming output cap, preview + per-run sandbox wiring.
- `src/runtime/tools/grep.ts` — `grep`: ripgrep/GNU backend resolution, pure `buildSearchArgs`, soft timeout, concurrent stream draining.
- `src/runtime/tools/glob.ts` — `glob` (`Bun.Glob.scan`, sorted, `maxResults` cap).
- `src/runtime/tools/validate.ts` — `validatePath` (lexical containment) + `validateTimeout`.
- `src/runtime/tools/output-limits.ts` — per-tool caps, `truncateText`, truncation markers, `describeOutputCap`.
- `src/runtime/tools/filter.ts` — `applyToolFilters` (restriction → allow → deny → force-deny) + `ORCHESTRATION_TOOLS`.
- `src/runtime/tools/permissions.ts` — `needsApproval` matrix, `DEFAULT_PERMISSION_MODE = "yolo"`, the async permission-gate map.
- `src/runtime/tools/mode-tool-scope.ts` — `computeModeToolScope`: compiles a mode + conversation `extensionTools` into `ToolFilterOptions`.
- `src/runtime/stream-chat/setup-tools.ts` — wires `getBuiltinToolDefs` into `ctx.agentTools` with the permission-gate wrapper + preview wiring.
- `web/src/routes/api/tools/+server.ts` — the scoped tool-listing endpoint that reuses the same filter pair.

## Features it touches

- [[streaming-runtime]] — the wrapped tools are pushed onto `ctx.agentTools` in `setup-tools.ts` and called during a streamed turn; `shell` streams stdout back via `onUpdate`.
- [[runs-lifecycle]] — each tool call registers an `AbortController` in `ctx.toolAbortControllers` so a cancelled run aborts in-flight tools; `callTimeoutMs` interacts with the executor watchdog.
- [[permissions-and-grants]] — `needsApproval` + the per-project permission mode gate `write`/`execute` tools before they run.
- [[rbac-and-permission-modes]] — `DEFAULT_PERMISSION_MODE = "yolo"` and the `ask`/`auto-edit`/`yolo` matrix live here.
- [[sandbox-and-isolation]] — `ShellSandboxWiring` jails `/bin/sh -c` to a per-run workspace excluding `.ezcorp/data` via `buildSandboxArgv`.
- [[preview-port-exposure]] — `ShellPreviewWiring` launches a recognized dev-server command under the conversation's preview uid.
- [[modes]] — `computeModeToolScope` translates a mode's `toolRestriction`/`allowedTools`/`extensionIds` into the filter options.
- [[teams]] — team/member-level allow/deny scopes feed `applyToolFilters` at invocation time, taking precedence over the mode filter.
- [[agents]] — orchestration tools (`invoke_agent`, `ask-user`, `task_*`) are preserved through filtering so agents can always delegate.
- [[mention-grammar]] — `@`-file mentions use the realpath-based FS scanner, the inverse of these tools' lexical containment (see gotchas).
- [[projects]] — `projectPath` is the containment root; every tool is bound to the active project's directory.
- [[daily-briefing]] — passes the web-search extension's tool names via `readOnlyAllowedTools` so its unattended read-only run can still research.

## Related docs

None yet — this is the primary reference. (See [permissions-and-grants](../extensions/permissions-and-grants.md) for the permission-mode UI and grant model, and [web-search](web-search.md) for an example of a non-built-in, extension-delivered tool.)

## Notes & gotchas

- **Path containment is lexical, not realpath.** `validatePath` only checks resolved-string prefixes — a symlink **inside** the project pointing at a target **outside** the root passes, because the resolved string still starts with `projectPath`. The `@`-mention FS scanner (`scan-fs.ts realpathInsideRoot`) does `realpath` and would reject the same symlink. Treat the built-in tools as project-confined **only to the extent the project tree contains no escaping symlinks**; for hard OS-level isolation, the optional `ShellSandboxWiring` jail (sandbox tier) is the real boundary.
- **The per-run shell sandbox is plumbed but not wired by the chat path.** `getBuiltinToolDefs` and `createShellTool` accept a `ShellSandboxWiring` third argument, but `setup-tools.ts:312` calls `getBuiltinToolDefs(project.path, previewWiring)` with **no** sandbox arg. So in a normal project chat the `shell` tool runs **unjailed** (`Bun.spawn` directly in the project dir) — secret-env stripping + the dangerous-command blocklist + lexical containment are the only guards. The jail path is exercised by per-run isolation tests (`sandbox-seam-a-b.test.ts`) and reserved for isolated-run contexts; don't assume `.ezcorp/data` is OS-isolated from a chat shell.
- **`DEFAULT_PERMISSION_MODE = "yolo"` is intentional and permanent.** A fresh project auto-approves `read`/`write`/`execute` (everything). This is a deliberate product decision, not a security finding — do not re-flag it.
- **Secret-env stripping is name-pattern-based.** `sanitizeEnv` drops env keys matching `/SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY/i`. A secret stored under a key that doesn't match the pattern (e.g. `DATABASE_URL` with an inline password) is **not** stripped from the child shell's environment.
- **The dangerous-command blocklist is a regex denylist, trivially bypassable.** It catches the obvious `rm -rf /` / `curl | sh` shapes but is not a real sandbox — e.g. `R=rm; $R -rf /` or a base64-decoded payload sails through. It is a guardrail against accidental footguns, not a security boundary against an adversarial LLM.
- **`callTimeoutMs` is pinned above the tool's own timeout on purpose.** Both `shell` (600 000 ms) and `grep` (`softTimeout + 15 000`) declare a watchdog-deferral above their internal timeout so the executor's idle watchdog can't preempt the tool's own clean return — the regression that previously turned a slow grep/build into a whole-run kill (`"Tool grep exceeded its 90000ms call timeout"`).
- **Output caps protect the conversation, not just the UI.** The 8 MiB default (1 MiB for shell) sits below OpenAI's 10 MiB single-input-string limit so a runaway tool result can't poison the replayed history on the next turn. Truncation is inline and marked, never silent.
- **The built-in file tools are absent from `/api/tools`.** That endpoint lists only extension tools + the `ez` concierge metadata (`getBuiltInToolMetadata()` is empty for the file tools post-Phase-5). The file tools are injected straight into `ctx.agentTools` in `setup-tools.ts`; the `/api/tools` header badge therefore does not enumerate `readFile`/`shell`/etc. They are still filtered identically at runtime via `ctx.builtinToolDefsMap`.
- **`editFile` search-replace fails loudly on ambiguity.** 0 matches → error; >1 match without `replace_all: true` → error asking for more context. This prevents a silent wrong-occurrence edit, but means the LLM must `readFile` first to construct a unique `old_string`.

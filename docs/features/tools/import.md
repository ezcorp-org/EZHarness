# Import (Skills & Commands)

> _A preview→commit wizard that ingests an uploaded archive or directory, discovers Claude skill bundles and project slash-commands inside it, and installs them — commands as DB user-commands, skills as disabled tool extensions wrapping a generic three-tool shim._

## Intent

EZCorp has no native "freeform Claude skill" runtime, and there is no built-in way to bulk-import the slash-commands a user already keeps in a coding-agent project (`.claude/`, `.codex/`, `agents/`). The import wizard closes both gaps: a user uploads a folder or `.zip`/`.tar.gz`, gets a checklist of every discovered command and skill, selects what to keep, and commits. Commands become first-party `user_commands` rows; each Claude skill bundle (`SKILL.md` + helper scripts) is synthesized into a runnable tool extension installed **disabled**, so it lands in the normal extensions review flow before it can act.

## How it works

The flow is two stateless HTTP calls (`preview` then `commit`) bridged by a short-lived, gitignored staging directory keyed by a `sessionId`.

### 1. Stage the upload (`preview`)

- The upload arrives as `multipart/form-data` — either a directory-picker (`files[]` parts paired with parallel `paths[]` `webkitRelativePath` strings) or a single `archive` file. `resolveProjectRoot` requires a concrete project (`"global"`/missing → **400**), since extensions install under `<projectRoot>/.ezcorp`.
- `src/runtime/import/staging.ts` materializes the bytes into `<projectRoot>/.ezcorp/import-staging/<sessionId>/` (a UUID dir; `.ezcorp/` is gitignored). `stageDirectoryUpload` rebuilds the tree, `stageArchiveUpload` extracts via `unzip`/`tar`.
- Everything is treated as untrusted. Path hardening is layered:
  - `sanitizeRelPath` rejects absolute paths, drive letters, `..` segments, and NUL bytes per directory-upload part.
  - For archives, `assertArchiveEntriesConfined` lists the manifest (`unzip -Z1` / `tar -tzf`) and **fails closed before extracting a single byte** if any member is absolute or contains `..` — the archive bytes are written to an OS tmp file (never under `projectRoot`), then extracted.
  - `assertConfinedAndCapped` walks the extracted tree post-hoc and rejects any entry whose **realpath** escapes the session dir (catches escaping symlink members, which never appear in a manifest listing). It re-enforces caps on the expanded result.
- Caps (`DEFAULT_LIMITS`): 50 MB total upload, 5 MB per file, 3000 files. The per-file cap is intentionally larger than the 64 KB command-body cap because skill scripts/assets legitimately exceed it.
- `resolveScanRoot` descends through single-directory wrappers (browser uploads / zips nest everything under one folder; `__MACOSX` ignored) until it reaches the dir containing a recognized config root (`.claude` / `.codex` / `agents`).
- Two scanners run over that root in parallel: `discoverProjectCommands` (`src/runtime/commands/discovery.ts` — only the **project** roots, never home; bodies re-capped at 64 KB) and `scanSkillBundles` (`src/runtime/import/skill-bundle.ts` — directories that directly contain a `SKILL.md`). Re-scanning at commit produces matching ids by different means: a command's id is content-keyed (`commandId` = `source|name`, order-independent), so command discovery need not sort; `scanSkillBundles` instead walks in sorted order and assigns order-dependent ids (the `-2`/`-3` dedup suffixes), so its determinism *does* rest on the sort.
- The response is `{ sessionId, fileCount, commands[], skills[] }` — a checklist. The staging dir is **kept** for commit; abandoned previews are swept opportunistically (`sweepStaleStaging`, 1h TTL) at the top of the next preview.

### 2. Commit the selection (`commit`)

`POST /api/import/commit` takes `{ sessionId, projectId, commands: string[], skills: string[] }` (ids from preview). It **re-resolves and re-scans** the same staging dir (`resolveStagingDir` → `null` ⇒ **410** "session expired"), so the commit never trusts client-supplied content — only the selected ids.

- **Commands** → `createUserCommand` (the DB helper directly — no self-HTTP). The filename stem is run through `slugifyCommandName` (DB rule `/^[a-z0-9][a-z0-9-_]{0,63}$/`, no dots); the helper de-dupes with its own `-2` suffixing. The original `source` is stamped into `frontmatter.imported`. On any success, the command registry is invalidated for the user.
- **Skills** → for each selected bundle, `synthesizeSkillExtension` writes a self-contained installable extension dir under `<projectRoot>/.ezcorp/extensions/<name>/`:
  - `ezcorp.config.ts` — synthesized manifest (`buildSkillManifestSource`): schemaVersion 2, the `name`/`description` from `SKILL.md`, `entrypoint: "./index.ts"`, the three `SKILL_TOOLS`, and `permissions: { shell: true, filesystem: ["."] }`.
  - `index.ts` — a **verbatim copy** of `skill-runner.template.ts` (kept as real type-checked code, not an escaped string blob).
  - `skill/` — a verbatim copy of the original Claude bundle.
  - Names collide-resolve against both the DB (`getExtensionByName`) and disk before install. The dir is handed to `installFromLocal(destDir, …, /* enabled */ false, …)` — **disabled**. On install failure the dest dir is `rm -rf`'d. On any success the `ExtensionRegistry` is reloaded (non-fatal if it throws).
- Per-item `ItemResult`s (`status: "ok" | "error"`, `finalName`, `extId`, `message`) are returned so auto-renames and failures are visible. The staging dir is **always** cleaned up in a `finally`.

### 3. The synthesized skill runtime

The generic shim (`skill-runner.template.ts`) speaks the same JSON-RPC 2.0 / stdio framing as every EZCorp tool extension and exposes exactly three tools:

- `skill_info` → returns the `SKILL.md` body (the instructions; "call this first").
- `list_scripts` → enumerates bundled files (excluding `SKILL.md`).
- `run_script` → executes one bundled script. The path is realpath-confined to `./skill/`; the interpreter is picked by extension (`commandFor`: `.py`→python3, `.js/.ts/.mjs`→bun, `.rb`→ruby, `.pl`→perl, `.sh/.bash`→bash, else direct exec). Runs are timeout-bounded (`EZCORP_SKILL_RUN_TIMEOUT_MS`, default 30 s) and sandboxed by the extension host.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `POST /api/import/preview` | `read` | Stage a `multipart/form-data` upload (`projectId` + either `files`+`paths` or `archive`), scan it, return `{ sessionId, fileCount, commands[], skills[] }`. |
| `POST /api/import/commit` | `extensions` | Re-scan the staged session and import selected ids: `{ sessionId, projectId, commands[], skills[] }` → `{ results[] }`. |

Both gate `requireScope` + `requireAuth`. Note the commit scope is `extensions` (it installs extensions), preview is `read`.

### UI entry point

- The wizard page is `web/src/routes/(app)/import/+page.svelte` (route `/import`), reached from the **Extensions** and **Commands** pages (`href="/import"`). It offers a directory picker (`webkitdirectory`) or an archive upload, renders the preview checklist, and commits the selection.
- Typed client wrappers: `importPreview(form)` / `importCommit(payload)` in `web/src/lib/api.ts`; `uninstallExtension(id)` backs the wizard's undo/remove of a just-installed skill.

### Accepted inputs

- Directory upload (browser folder picker) or a single `.zip` / `.tar.gz` / `.tgz` archive.
- Commands are discovered under `.claude/commands`, `.claude/agents`, `.codex/prompts`, `agents/` (project-relative to the scan root).
- Skills are any directory directly containing a `SKILL.md`.

### Env vars / settings

- `EZCORP_SKILL_RUN_TIMEOUT_MS` (default `30000`) — per-`run_script` timeout in the synthesized runner.
- `EZCORP_SKILL_DIR` — runner override for the bundle location (a testing/relocation seam; production uses `import.meta.dir`/`skill`).
- Limits in `staging.ts` (`MAX_TOTAL_UPLOAD_BYTES`, `MAX_FILE_BYTES`, `MAX_FILE_COUNT`) and `skill-bundle.ts` (`MAX_SKILL_BUNDLES` 200, `MAX_SCRIPTS_PER_BUNDLE` 500) are constants, parameterized only for tests.

## Key files

- `src/runtime/import/staging.ts` — upload staging: dir/archive materialization, zip-slip/`..`/symlink confinement (manifest pre-check + post-extraction realpath walk), caps, session-dir lifecycle (`resolveStagingDir`, `cleanupStagingDir`, `sweepStaleStaging`), `resolveScanRoot`.
- `src/runtime/import/skill-bundle.ts` — `scanSkillBundles` (SKILL.md discovery), `skillExtensionName` sanitizer, `buildSkillManifestSource`, `synthesizeSkillExtension`, the canonical `SKILL_TOOLS` descriptors.
- `src/runtime/import/skill-runner.template.ts` — the generic three-tool (`skill_info`/`list_scripts`/`run_script`) JSON-RPC runner copied verbatim as each imported skill's `index.ts`.
- `web/src/routes/api/import/preview/+server.ts` — `POST /api/import/preview`: stage + scan + checklist.
- `web/src/routes/api/import/commit/+server.ts` — `POST /api/import/commit`: re-scan + `createUserCommand` + `synthesizeSkillExtension` + `installFromLocal` (disabled).
- `web/src/routes/api/import/common.ts` — shared `resolveProjectRoot`, `slugifyCommandName`, `commandId`, `STALE_STAGING_MS`.
- `src/runtime/commands/discovery.ts` — `discoverProjectCommands`; the project-root list + 64 KB body cap reused by the wizard.
- `src/runtime/fs/scan-fs.ts` — `realpathInsideRoot` + `EXCLUDED_DIR_NAMES`, the realpath confinement helper the scanners share.
- `src/extensions/installer.ts` — `installFromLocal` (the existing install pipeline the commit endpoint reuses; default `enabled = false`).
- `web/src/routes/(app)/import/+page.svelte` — the wizard UI.
- `web/src/lib/api.ts` — `importPreview` / `importCommit` client wrappers + `Import*` result types.

## Features it touches

- [[slash-commands]] — imported commands land as `user_commands` rows; the command registry is invalidated so they appear in `/`-mention expansion.
- [[bundled-catalog]] — imported skills are installed (disabled) tool extensions via the same `installFromLocal` pipeline bundled extensions use.
- [[permissions-and-grants]] — skills install **disabled** so the user must review + grant their declared `shell`/`filesystem` permissions before enabling.
- [[runtime-and-rpc]] — the synthesized runner is a standard stdio/JSON-RPC tool extension exposing `tools/list` + `tools/call`.
- [[sandbox-and-isolation]] — `run_script` execution is gated by the extension host's sandbox; the runner only realpath-confines the script path.
- [[builtin-file-tools]] — both share `src/runtime/fs/scan-fs.ts`'s `realpathInsideRoot` confinement helper.
- [[mention-grammar]] — discovered commands feed the `/[cmd:name]` sigil; installed skill extensions surface as `!ext` tools.
- [[marketplace]] — a sibling install path (`/api/marketplace/import`) for published manifests, distinct from this upload wizard.
- [[projects]] — the wizard requires a concrete project; staging + extension installs live under that project's `.ezcorp/`.

## Related docs

- [docs/extensions/security.md](../../extensions/security.md) — the extension sandbox/permission model the imported skill extensions run under.
- [docs/extensions/manifest-schema.md](../../extensions/manifest-schema.md) — the `ezcorp.config.ts` schema the synthesized manifest targets.
- [docs/slash-commands.md](../../slash-commands.md) — the command grammar imported commands join.
- [docs/extensions/data-storage.md](../../extensions/data-storage.md) — the `.ezcorp/` convention staging + installed extensions live under.

## Notes & gotchas

- **Skills install disabled, by design.** `installFromLocal(..., /* enabled */ false, ...)` means a freshly imported skill cannot run until the user reviews and enables it (and grants its `shell` + `filesystem: ["."]` permissions) through the normal extensions modal. This is the security gate — do not "helpfully" flip it on.
- **Commit re-scans; it never trusts the client.** The commit body carries only `sessionId` + selected **ids**, never content. If the staging dir expired/was swept, commit returns **410**. The same scanners run on both ends and are deterministic so the ids line up.
- **Confinement is realpath-based and fail-closed.** Archives are manifest-checked before extraction; the post-extraction walk realpath-rejects escaping symlinks; an unreadable manifest is treated as unsafe. Confined symlinks are skipped (counted-as-skip), never followed. Session ids must be UUIDs — anything else is rejected as a traversal attempt.
- **Per-item, not all-or-nothing.** One bad command/skill yields a `status: "error"` `ItemResult` while the rest succeed; auto-renames surface as `finalName`. The staging dir is `rm -rf`'d in a `finally` regardless.
- **Name collisions auto-suffix.** Skill extension names de-dupe (`-2`, `-3`, …) against both the DB and `.ezcorp/extensions/` on disk; command names de-dupe inside `createUserCommand`. The slug rules differ: skill names allow dots, command slugs do not.
- **Scan limits silently truncate.** `MAX_SKILL_BUNDLES` (200), `MAX_SCRIPTS_PER_BUNDLE` (500), and the 3000-file staging cap mean a very large upload is capped rather than rejected for the skill slice; the file-count cap, however, is a hard **413** at staging time.
- **`run_script` interpreter inference is extension-based.** A script with no recognized extension is exec'd directly (relies on its exec bit/shebang); the host sandbox is the real containment, not the runner's path check.
- **Commands scan project roots only.** During import only `discoverProjectCommands` runs (`.claude`/`.codex`/`agents` under the scan root) — the home-dir command roots and the `EZCORP_SCAN_GLOBAL_COMMANDS` gate are not part of the upload path.

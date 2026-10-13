# Sandbox & Isolation

> _The OS-level confinement layer that wraps every untrusted HOST spawn — the per-run agent shell (extensions and MCP servers run in the extension runner instead) — behind a capability-probed tier (bwrap › landlock › advisory) whose one non-negotiable invariant is that `.ezcorp/data` (the PGlite DB + JWT secret) is never reachable._

## Intent

EZCorp runs arbitrary third-party code: extension entrypoints, the per-run agent shell, and external MCP server binaries. Extension and MCP code runs in the extension runner's isolated worker (§4, §7); the host-side layer below confines what still spawns on the host. None of it can be trusted with the host filesystem — most critically the encrypted SQLite/PGlite database and the JWT signing secret that both live under `<projectRoot>/.ezcorp/data`. This feature is the defense-in-depth wrapper that, at every spawn site, applies the strongest OS-isolation primitive the host actually supports (an `unshare`+Landlock `bwrap` jail, a per-process Landlock fs-jail, or — last resort — only the in-process SDK module-poisoning) plus a memory bound, while guaranteeing by construction that no granted path is, contains, or is contained by the data dir. It is the OS-level companion to the permission/grant system (which gates *what an extension may ask for*); this layer enforces *what its process can physically touch*.

## How it works

The design is one capability probe + one DRY argv builder applied at the host spawn seams.

### 1. Capability probe — pick the strongest tier (`sandbox/capability-probe.ts`)

`probeSandboxCapabilities()` runs each primitive probe and `selectTier()` resolves the strongest, memoized on first use via `getSandboxCapabilities()` / `getSandboxTier()` (one probe per process; `__resetSandboxCapabilitiesCache()` is the test seam). Probes:

- `probeLandlockAbi()` — Landlock ABI via FFI (`sandbox/landlock-ffi.ts`'s `landlockAbiVersion()`).
- `probeUserns()` — spawns `unshare -Ur true`.
- `bwrapIsSetuid()` — walks `$PATH` for a `bwrap` with the S_ISUID bit.
- plus informational `probeCgroupV2Delegation()` / `probeKvm()` (microVM upgrade path).

`selectTier()` is pure and exhaustively tested:

- **`bwrap`** — a verified x64 or arm64 syscall table, `landlockAbi >= 1`, working `userns`, and a non-setuid `bwrap`. Adds `/proc` + PID hiding on top of the Landlock-equivalent fs jail.
- **`landlock`** — usable Landlock (verified x64 or arm64 table and ABI ≥ 1) but no usable userns (or a setuid `bwrap`). fs-jail only, no PID/proc hiding. **This is the Docker app-container case** — Landlock needs zero namespaces/caps/setuid and its syscalls pass Docker's default seccomp, where the earlier bwrap/netns spike failed on unprivileged-userns restrictions.
- **`advisory`** — no usable Landlock. No OS isolation prefix; the inner command runs as-is.

A setuid-root `bwrap` is deliberately *refused* (it rejects `--size` on its private `/tmp`, and on such hosts the runtime lives behind `/run/...` symlinks the minimal bind-set misses), so the tier drops to `landlock`.

### 2. The DRY isolation seam (`sandbox/build-sandbox-argv.ts`)

`buildSandboxArgv({ tier, workspaceDir, projectRoot, command, args, roPaths, rwPaths, listPaths, seccompFd })` is a **pure** function returning `{ argv, env, landlockSpec, tier }` — it never spawns; the caller does. Per tier:

- **advisory** → returns the inner command unchanged (no binds, so nothing new to expose).
- **landlock** → builds a `LandlockJailSpec` (below) and returns `["bun", <landlock-shim>, "--", ...inner]` with the serialized spec in `EZCORP_LANDLOCK_SPEC`. Landlock is per-process, so a pre-exec shim applies the jail in-process then execs the inner command, which **inherits** the restrictions across `execve`.
- **bwrap** → delegates to `preview-jail.ts`'s `buildMcpJailBwrapArgs` (the minimal bind-set: ONE rw workspace, ro-bind system dirs, private `/tmp`, `/proc` + `/dev`, **no `--bind / /`**, nothing under `.ezcorp/data`), omitting `--size` when `bwrap` is setuid.

Every tier delegates the deny-by-default invariant to a shared assertion — fail-closed on any granted path that would expose the DB/secret dir.

### 3. The Landlock jail (`sandbox/landlock.ts` + `sandbox/landlock-shim.ts`)

`buildLandlockJailSpec()` resolves an allowlist into a serializable `{ ro, rw, list? }` spec:

- `rw` paths get a write-inclusive grant (read/exec/write/make/remove/truncate, masked to the kernel ABI); `ro` paths get read/exec only; everything else loses all access. Landlock *enforces* every access in the handled set, so the rw/ro split is load-bearing — a read-only workspace would EACCES every write.
- **The deny invariant is checked against the REAL (symlink-resolved) path** via `canonicalizeForJail()` → `realpathSync`. This closes the symlink leak: Landlock binds the *kernel inode*, so a grant that is a symlink whose target is `.ezcorp/data` would pass a purely-lexical check yet have the kernel grant the real data-dir inode (a read leak of the DB + JWT secret). A non-existent path falls back to lexical `resolve()` (the kernel can't grant a missing inode), keeping the tier's tolerance for distro-absent RO dirs like `/lib64`, `/nix`.
- `list` paths (optional) are granted read-only and are **exempt** from the data-dir-*ancestor* assertion — used to grant a git repo root that *contains* `.ezcorp/data` (git must scan the whole tree). They may be an ancestor of the data dir but must not BE it or live under it; since they are read-only, the ungranted `.ezcorp/data` subtree stays unreadable.

`landlock-shim.ts` is a separate `bun` entrypoint (never imported, only spawned). It parses the spec from `EZCORP_LANDLOCK_SPEC`, `chdir`s into `rw[0]` (the workspace) so the inner `bun` can read its cwd, calls `applyLandlockJailSpec()` (which throws if the kernel can't enforce), then spawns the inner command — fail-closed: a missing/invalid spec, unsupported kernel, or failed `restrict_self` aborts WITHOUT running the inner command.

### 4. Extension code runs in the extension runner, not on the host

Since #246 the host never spawns extension code. `ExtensionProcess` (`src/extensions/subprocess.ts`) is a contract with no spawn surface; its only production implementation is `ReleaseProcess`, which runs each call in an extension-runner worker (rootless Podman, `--network=none`, read-only root, deny-by-default seccomp, cgroup limits; see [[mcp-servers]] and `src/__tests__/runner-worker-isolation.proof.test.ts`). The old host path — `bun run --preload <sandbox-preload>` inside this layer's jail, with the in-process module poisoning and fetch wrapper — survives only as a TEST harness (`src/__tests__/helpers/host-extension-process.ts` + `host-sandbox/`) so example and behavior tests can drive a real extension process quickly. It proves nothing about production isolation, and the dependency-boundary gate stops production code from importing it.

### 5. Host spawn seams

- **Seam A — extension subprocess: retired.** Extension code no longer spawns on the host (§4).
- **Seam B — per-run agent shell** (`src/runtime/tools/shell.ts`): jails every `/bin/sh -c` spawn to the per-run `workspaceDir` (rw) on the same tier; `spawnCwd` is the workspace when jailed.
- **MCP servers are not a host spawn seam.** Since #246 they run in the extension runner's isolated worker; see §7.

### 7. MCP server isolation (extension runner)

The host no longer spawns MCP servers, so none of the tiers above apply to them. `registry.getMcpClient` returns a `ReleaseMcpClient` (`src/extensions/release-mcp-client.ts`):

- **stdio**: the call goes to the release worker of the approved v4 release, and the SDK bridge (`packages/@ezcorp/sdk/src/v4/mcp.ts`) starts the server inside it. The default Podman runner (`packages/@ezcorp/extension-runner/src/podman.ts`) starts that worker rootless with `--network=none`, a read-only root, `--cap-drop=ALL`, `no-new-privileges`, a deny-by-default seccomp profile, user `65534`, cgroup memory/CPU/PID limits and a sized `/tmp`. It refuses to start without rootless Podman, seccomp and cgroup v2 (`isolation_unavailable`). Egress leaves only through the invocation's native proxy and the host network brokers, which check the declared and granted destinations.
- **http / sse**: the host calls the server through `guardedStreamingFetch`. Each URL must match the approved origin, the exact network grant and the permission engine while the call runs.
- **Trusted-local mode** (`packages/@ezcorp/extension-runner/src/trusted-local.ts`) omits these controls. It needs typed operator consent and a per-digest approval, and its releases carry a `localhost/trusted-local@` image digest.

## Usage

This is infrastructure — there is no API route or UI page. It is exercised by configuration and at every untrusted spawn.

### Env vars (operator)

| Var | Effect |
|---|---|
| `EZCORP_PROJECT_ROOT` | Host-resolved project root; sole source for the `.ezcorp/data` exclusion (never from a manifest's `spec.env`). |

### Env vars (host→sandbox, set by the spawn sites — not operator-facing)

- `EZCORP_LANDLOCK_SPEC` — the serialized `LandlockJailSpec` consumed by the landlock shim.

### Manifest

- Extension resource limits and permissions are enforced by the extension runner and the host brokers, not by this layer.

## Key files

- `src/extensions/sandbox/capability-probe.ts` — `selectTier` + memoized `getSandboxTier` / `getSandboxCapabilities`; the bwrap › landlock › advisory decision.
- `src/extensions/sandbox/build-sandbox-argv.ts` — the single DRY `buildSandboxArgv` seam (pure; argv + env per tier).
- `src/extensions/sandbox/landlock.ts` — `buildLandlockJailSpec` / `applyLandlockJailSpec`; `canonicalizeForJail` (realpath, closes the symlink leak); rw/ro/list distinction.
- `src/extensions/sandbox/landlock-shim.ts` — pre-exec `bun` shim: parse spec → chdir → apply jail → exec inner (fail-closed).
- `src/extensions/sandbox/landlock-ffi.ts` — raw Landlock + prctl syscalls via FFI (`landlockAbiVersion`, `applyReadWriteJail`, ABI access masks; verified x64 and arm64 tables).
- `src/extensions/runtime/internal-host.ts` — shared internal-host regex (`INTERNAL_HOST_RE`) and `normalizeHostname`.
- `src/extensions/preview-jail.ts` — minimal bwrap bind-set builder (`buildMcpJailBwrapArgs`, `buildPreviewJailBwrapArgs`) + the shared `forbiddenDataDir` / `assertOutsideDataDir` / `canonicalizeJailPath` (realpath) data-dir invariant; `assertJailArgsSafe`.
- `src/extensions/release-mcp-client.ts` — MCP calls: release, grant and permission checks; stdio via the release worker, `http`/`sse` via the guarded fetch.
- `src/extensions/subprocess.ts` — the `ExtensionProcess` contract (no spawn surface); `ReleaseProcess` is its only production implementation.
- `src/__tests__/helpers/host-extension-process.ts` — TEST-ONLY host spawn harness (preload + jail) for fast example/behavior tests.
- `src/runtime/tools/shell.ts` — Seam B: per-run agent shell jailed to the run workspace.
- `src/extensions/registry.ts` — `getProcess` (returns a `ReleaseProcess`) and `getMcpClient` (returns a `ReleaseMcpClient`).
- `docs/extensions/security.md` — the bundled-extension trust model (ceiling + manifest lockfile), complementary to this OS layer.

## Features it touches

- [[mcp-servers]] — MCP servers run in the extension runner's isolated worker (stdio) or through the guarded host fetch (`http`/`sse`), not in a host tier.
- [[permissions-and-grants]] — grants decide *what may be asked for*; this layer (host spawns) and the extension runner (extension code) enforce *what a process can physically reach*.
- [[runtime-and-rpc]] — extension fs/network access routes through host-mediated reverse-RPC (`ezcorp/fs.*`, the network brokers).
- [[builtin-file-tools]] — note the asymmetry: those tools' `validatePath` containment is **lexical** (no realpath), whereas this layer's jail invariant resolves real paths; the `@`-mention FS scanner uses realpath too.
- [[preview-port-exposure]] — the bwrap minimal-bind builder is shared with the untrusted preview-process jail (same `.ezcorp/data` threat class).
- [[web-search]] — extension and MCP egress goes through the runner's brokered network.
- [[audit-and-observability]] — sandbox decisions emit audit rows.
- [[bundled-catalog]] — bundled extensions run in the extension runner like any other; their *grant* ceiling is the separate concern in `docs/extensions/security.md`.
- [[rbac-and-permission-modes]] — the permission mode (default `yolo`) governs tool-call approval; orthogonal to OS confinement, which is always on where a tier exists.

## Related docs

- [docs/extensions/security.md](../../extensions/security.md) — bundled-extension trust model: the capability ceiling (`bundled-ceiling.ts`) + manifest lockfile (`manifest.lock.json`). Complements (does not duplicate) this OS-isolation layer.
- [docs/extensions/data-storage.md](../../extensions/data-storage.md) — the `.ezcorp/extension-data/<name>/` convention that becomes the jail's writable workspace.
- `scripts/spikes/A1-FINDINGS.md` — in-repo evidence for the Landlock-primary thesis (why bwrap/netns failed in the container).

## Notes & gotchas

- **The probe is lazy, not boot-eager.** `getSandboxTier()` memoizes on FIRST spawn, not at server boot — there is no explicit boot-time wiring; the first untrusted spawn pays the probe cost once per process.
- **`landlock` is the production-container tier.** In the Docker app container userns is typically blocked, so the resolved tier is `landlock` (no PID/proc hiding) — not `bwrap`. `advisory` (SDK poisoning only) is the fallback on hosts with no usable Landlock or without a verified x64/arm64 syscall table; the probe does not guess numbers for other architectures.
- **Lexical vs realpath asymmetry across the codebase.** This layer's jail invariant (both `landlock.ts:canonicalizeForJail` and `preview-jail.ts:canonicalizeJailPath`) resolves REAL paths to close the symlink-into-`.ezcorp/data` leak. By contrast the built-in file-tool path containment (`src/runtime/tools/validate.ts:validatePath`) is **lexical** (no realpath); only the FS scanner / `@`-autocomplete (`src/runtime/fs/scan-fs.ts:realpathInsideRoot`) realpaths. Don't assume one containment model everywhere.
- **MCP fails CLOSED.** Without rootless Podman, seccomp and cgroup v2 the runner refuses to start an MCP worker. The only way to run without those controls is the explicit trusted-local mode.
- **The preload is test-only.** The in-process module poisoning (`host-sandbox/sandbox-preload.ts`) runs only under the test harness. Do not cite it as production isolation; the runner worker is the boundary for extension code.
- **`advisory` tier means a host spawn (the agent shell) runs without OS confinement** — the OS jail is the only containment on the host side.
- **Memory bound is `prlimit --rss`, not the tmpfs `--size`.** The private `/tmp` size cap is defense-in-depth and is dropped on setuid-bwrap hosts; the real RAM bound is always the `--rss` on the inner command.
- **The data-dir exclusion uses the HOST-resolved project root only.** `EZCORP_PROJECT_ROOT` computes `.ezcorp/data`; an untrusted caller can never steer it.
- **A HOST-side applier is outside this layer entirely — it must carry its own containment.** The `file-organizer` daemon and Hub events route touch watched host folders (Desktop/Downloads/…) with raw `node:fs` from the HOST process, by design: those folders are outside the subprocess `$CWD` jail, so no sandbox tier is in the path. Extension workers still cannot reach them, but the invariant above then rests entirely on `src/extensions/file-organizer-applier.ts`. It reproduces the jail's rules in software: every path canonicalized (parents realpath'd, leaves preserved) and contained on BOTH ends against a realpath'd anchor; symlink decisions from a live `lstat`, never from caller-supplied metadata; a fail-closed refusal when an anchor won't resolve; and a hard deny on `isReservedSensitivePath()` — the same reserved set this layer masks, which is what covers the container's `EZCORP_DB_PATH=/app/data/ezcorp` (no `.ezcorp/data` segment, so a path-shaped check alone misses it). A host-side executor that skips any of that re-opens the `.ezcorp/data` invariant with no sandbox behind it.
- **bwrap-tier integration tests are skipped where userns is unavailable** — the live FFI/jail behavior is proven by the `scripts/spikes/` evidence scripts and by tier-pinned unit tests (`_setSandboxTierOverrideForTests`), not by spawning a real jail in CI.

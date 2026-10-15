/**
 * TEST-ONLY host extension process.
 *
 * Production never spawns extension code on the host: since #246 every
 * extension runs in an extension-runner worker (`ReleaseProcess`). This
 * class keeps the old host spawn path — `bun run --preload <sandbox-preload>`
 * with the host's Seam B jail — ONLY so example and behavior tests can drive
 * a real extension process quickly, without Podman. It proves nothing about
 * production isolation; the runner's isolation is proven by
 * `src/__tests__/runner-worker-isolation.proof.test.ts`.
 *
 * Production code cannot import this file: the dependency-boundary gate
 * (`scripts/check-boundaries.ts`, rule `no-test-imports-outside-tests`)
 * rejects any non-test import of the test tree.
 */
import { JsonRpcTransport } from "../../extensions/json-rpc";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, ToolCallResult } from "../../extensions/types";
import { incrementFailures, disableExtension, resetFailures } from "../../db/queries/extensions";
import { logger } from "../../logger";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getSandboxTier } from "../../extensions/sandbox/capability-probe";
import { buildSandboxArgv, defaultShimPath } from "../../extensions/sandbox/build-sandbox-argv";
import { DEFAULT_RUNTIME_RO_DIRS, runtimeExecRoDirs } from "../../extensions/sandbox/landlock";
import { formatNpmDepError, verifyNpmDependencies } from "../../extensions/npm-deps";
import { DEFAULT_MEMORY_LIMIT_MB, ExtensionProcess, MIN_MEMORY_LIMIT_MB } from "../../extensions/subprocess";
import type { ExtensionManifestV2, ExtensionPermissions } from "../../extensions/types";
import { migrateManifestV2ToV3 } from "../../extensions/manifest";
import { getProjectRoot } from "../../extensions/bundled";
import { findProjectRoot } from "@ezcorp/sdk/runtime";
import { tmpdir } from "node:os";

const log = logger.child("extensions/subprocess");

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CALL_TIMEOUT_MS = 30 * 1000; // 30 seconds
const AUTO_DISABLE_THRESHOLD = 3;
// Bounded stderr retention — enough for a Bun preload error + stack,
// capped so a chatty child can't grow host memory.
const STDERR_TAIL_CAP = 16 * 1024;


/** Track all active processes for cleanup on exit */
const activeProcesses = new Set<HostExtensionProcess>();

/** Kill every still-active extension subprocess. Registered as the process
 *  'exit' handler so child processes don't leak when the host exits; exported
 *  so the cleanup contract is unit-testable without waiting on a real exit. */
export function killActiveExtensionProcesses(): void {
  for (const ep of activeProcesses) {
    ep.kill();
  }
}

// Register cleanup handler once
let cleanupRegistered = false;
function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on("exit", killActiveExtensionProcesses);
}

/** Test-only: seed the active-process set so `killActiveExtensionProcesses`
 *  can be exercised without spawning a real child. Returns a disposer. */
export function _addActiveProcessForTest(ep: Pick<HostExtensionProcess, "kill">): () => void {
  activeProcesses.add(ep as HostExtensionProcess);
  return () => {
    activeProcesses.delete(ep as HostExtensionProcess);
  };
}

export interface ExtensionProcessOptions {
  idleTimeoutMs?: number;
  callTimeoutMs?: number;
  persistent?: boolean;
  memoryLimitBytes?: number;
  /**
   * Whether the extension has been granted `network` permission. When false,
   * the sandbox preload blocks imports of http/https/net/tls/dns/dgram and
   * overrides the global `fetch`. Defaults to false (deny).
   */
  networkAllowed?: boolean;
  /**
   * Whether the extension has been granted `shell` permission. When false,
   * the sandbox preload blocks imports of child_process and overrides
   * Bun.spawn / Bun.spawnSync. Defaults to false (deny).
   */
  shellAllowed?: boolean;
  /**
   * The manifest's declared third-party npm dependencies (package name →
   * semver range). When provided, `ensureRunning` VERIFIES they resolve
   * from the extension's install dir BEFORE spawning — an unresolvable
   * dep throws an actionable error instead of letting the subprocess
   * crash at module-load and drive the auto-disable loop (live incident
   * 2026-07-11). Threaded from the registry's `getProcess` construction
   * site. See ./npm-deps.ts.
   */
  npmDependencies?: Record<string, string>;
  /**
   * The extension's manifest name, used in operator-facing pre-check
   * error messages (falls back to the extension id when absent —
   * a UUID is correct but far less actionable than the name).
   */
  extensionName?: string;
}

/** The sandbox preload the harness spawns extensions with (test-only copy). */
const SANDBOX_PRELOAD_PATH = join(dirname(fileURLToPath(import.meta.url)), "host-sandbox", "sandbox-preload.ts");
const INTERNAL_HOST_PATH = fileURLToPath(new URL("../../extensions/runtime/internal-host.ts", import.meta.url));

/** Max chars of the child's stderr tail surfaced in an enriched crash
 *  error. Kept to the LAST 2000 chars — enough for a module-load stack,
 *  bounded so a chatty child can't bloat the tool result. */
const CRASH_STDERR_TAIL_CHARS = 2000;

/**
 * Prepare a child's stderr tail for surfacing in a crash error or log:
 * keep the LAST {@link CRASH_STDERR_TAIL_CHARS} chars, then mask
 * credential-shaped values — `key=value` / `key: value` pairs (quoted
 * JSON forms included) and `Bearer <token>` header echoes — so a secret
 * accidentally echoed into stderr doesn't land in a tool result, an
 * audit row, or a log line. BEST-EFFORT only, not a security boundary:
 * the input is extension-controlled, and a hostile extension can print
 * any secret it holds in a shape no mask anticipates. Its job is
 * catching the common accidental shapes (HTTP client errors, JSON
 * dumps). Pure; exported for direct unit testing.
 */
export function redactStderrTail(tail: string): string {
  const capped =
    tail.length > CRASH_STDERR_TAIL_CHARS ? tail.slice(-CRASH_STDERR_TAIL_CHARS) : tail;
  return capped
    .replace(
      /(token|secret|password|api[-_]?key|bearer)("?\s*[=:]\s*"?)[^"\s]+/gi,
      "$1$2[redacted]",
    )
    .replace(/\b(bearer)\s+(?!\[redacted\])\S+/gi, "$1 [redacted]");
}


/**
 * Manages a subprocess for a single extension.
 * Handles spawning, JSON-RPC communication, idle timeout, and crash detection.
 */
export class HostExtensionProcess extends ExtensionProcess {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private transport: JsonRpcTransport | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bounded tail of the child's stderr — surfaced on unexpected exit
   *  so module-load / `--preload` crashes are diagnosable. */
  private stderrTail = "";
  /** Resolves when the stderr drain-loop finishes (child EOF/close). The
   *  `call()` crash-enrichment path awaits this (bounded by a 250ms race)
   *  so a "Transport closed" rejection can carry the child's stderr tail
   *  even when the drain hasn't flushed the final chunk yet. Reset on each
   *  `ensureRunning`. */
  private stderrDrained: Promise<void> = Promise.resolve();
  private nextId = 1;
  private killed = false;
  /** Host-initiated JSON-RPC calls currently awaiting a response. */
  private inFlightCalls = 0;
  /** Resolvers parked by {@link whenCallsSettled} until the count hits 0. */
  private callSettledWaiters: Array<() => void> = [];

  private readonly idleTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly persistent: boolean;
  public readonly memoryLimitBytes: number;
  private readonly networkAllowed: boolean;
  private readonly shellAllowed: boolean;
  private readonly npmDependencies?: Record<string, string>;
  private readonly extensionName?: string;
  private pendingRequestHandler?: (req: JsonRpcRequest) => Promise<JsonRpcResponse>;
  private pendingNotificationHandler?: (notification: JsonRpcNotification) => void;

  constructor(
    extensionId: string,
    private readonly extensionPath: string,
    private readonly allowedEnv: Record<string, string>,
    options?: ExtensionProcessOptions,
  ) {
    super(extensionId);
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.callTimeoutMs = options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.persistent = options?.persistent ?? false;
    this.networkAllowed = options?.networkAllowed ?? false;
    this.shellAllowed = options?.shellAllowed ?? false;
    this.npmDependencies = options?.npmDependencies;
    this.extensionName = options?.extensionName;

    const minBytes = MIN_MEMORY_LIMIT_MB * 1024 * 1024;
    const rawBytes = options?.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024;
    this.memoryLimitBytes = Math.max(rawBytes, minBytes);

    registerCleanup();
  }

  /**
   * Get the spawn command array (for testing/inspection).
   *
   * Always includes `bun run --preload <sandbox-preload>` so imports of
   * network / shell modules are blocked by default. Permission-based
   * overrides are communicated to the preload via env vars (see
   * `buildSpawnEnv`).
   *
   * NOTE: `--preload` MUST appear AFTER the `run` subcommand. Bun's CLI
   * parser treats `bun --preload <path> run <ext>` as an invalid invocation
   * of `bun run` (it prints the help and exits), which immediately closed
   * the subprocess transport and broke every extension-runtime test. The
   * canonical form is `bun run --preload <path> <ext>`.
   */
  getSpawnArgs(): string[] {
    const inner = [
      "prlimit",
      `--rss=${this.memoryLimitBytes}`,
      "bun",
      "run",
      "--preload",
      SANDBOX_PRELOAD_PATH,
      this.extensionPath,
    ];
    const wrap = this.resolveSandboxWrap();
    if (!wrap) return inner;
    // The builder returns the COMPLETE argv (isolation prefix + the inner
    // command we passed it). Phase A4 Seam A — the landlock-tier env
    // additions are threaded by buildSpawnEnv() via the same resolver.
    return wrap.argv;
  }

  /**
   * Phase A4 (Seam A) — resolve the OS-isolation wrap for the extension
   * subprocess. Returns null (no wrap) when no project root was injected or
   * no usable sandbox tier is present (back-compat: behaves exactly as
   * before). The jail's writable workspace is the per-extension TMPDIR +
   * the extension's `.ezcorp/extension-data/<id>` store; `.ezcorp/data`
   * (the PGlite DB + JWT secret) is NEVER granted (asserted by the builder).
   *
   * Memoized per process so getSpawnArgs() + buildSpawnEnv() agree.
   */
  private sandboxWrapCache:
    | { argv: string[]; env: Record<string, string> }
    | null
    | undefined;
  private resolveSandboxWrap():
    | { argv: string[]; env: Record<string, string> }
    | null {
    if (this.sandboxWrapCache !== undefined) return this.sandboxWrapCache;
    const projectRoot = this.allowedEnv.EZCORP_PROJECT_ROOT;
    const tier = getSandboxTier();
    if (!projectRoot || tier === "advisory") {
      this.sandboxWrapCache = null;
      return null;
    }
    try {
      const workspaceDir = join(
        projectRoot,
        ".ezcorp",
        "extension-data",
        this.extensionId,
      );
      mkdirSync(workspaceDir, { recursive: true });
      const rwPaths: string[] = [];
      if (this.allowedEnv.TMPDIR) rwPaths.push(this.allowedEnv.TMPDIR);
      // The DATA-DIR CONVENTION home (`extension-data/<manifest NAME>`,
      // docs/extensions/data-storage.md) — where extensions persist their
      // user-visible state (ez-code-factory's gate repos + kept worktrees
      // live here). The workspace grant above is keyed by INSTALL ID (a
      // UUID that changes on reinstall), so without this grant every
      // name-keyed write is landlock-denied and the convention silently
      // breaks on any non-advisory host. Sibling of `.ezcorp/data`, never
      // an ancestor — the builder still asserts the secret stays denied.
      if (this.extensionName) {
        const nameDir = join(projectRoot, ".ezcorp", "extension-data", this.extensionName);
        mkdirSync(nameDir, { recursive: true });
        rwPaths.push(nameDir);
      }
      // The jailed workspace is `.ezcorp/extension-data/<id>` (rw). But the
      // child runs `bun run --preload <preload> <entrypoint>`, and BOTH the
      // extension's CODE dir (where the entrypoint + its sibling files live)
      // and the sandbox preload's dir live OUTSIDE that workspace. Under a
      // deny-by-default tier (landlock/bwrap) they must be granted READ-ONLY
      // or `bun` can't even read its own entrypoint — the subprocess exits at
      // bringup and every tool call surfaces "Transport closed". Add them to
      // the RO set alongside the conventional system dirs. (The previous wrap
      // only granted system dirs + the workspace, so a real extension whose
      // code lives elsewhere never started under a non-advisory tier — it was
      // masked because the sandboxed-subprocess path only ever ran trivial
      // system binaries in tests.)
      const extDir = dirname(this.extensionPath);
      const preloadDir = dirname(SANDBOX_PRELOAD_PATH);
      // Include the Bun runtime's own bin-dir (runtimeExecRoDirs) so the jailed
      // `prlimit … bun` can execvp its interpreter even where `bun` lives
      // outside the conventional system dirs — e.g. GitHub hosted runners
      // install it under `~/.bun/bin` via setup-bun (#55).
      //
      // The SANDBOX dir (where the landlock shim + its import closure live)
      // is granted RO too: a NESTED jail spawn inside the subprocess (the
      // EZCORP_SANDBOX_SHIM handoff, e.g. ez-code-factory's mutating-git
      // shell) runs `bun <shim>` UNDER this jail, so the shim's own source
      // must be readable or the nested spawn dies at module-load. Code only —
      // same trust class as the already-granted preloadDir.
      const roPaths = [
        ...DEFAULT_RUNTIME_RO_DIRS,
        ...runtimeExecRoDirs(),
        extDir,
        preloadDir,
        // The preload's import closure reaches back into production code
        // (`src/extensions/runtime/internal-host.ts`); grant its dir RO too.
        dirname(INTERNAL_HOST_PATH),
        dirname(defaultShimPath()),
      ];
      // The child `bun run <entrypoint>` must also READ the extension's
      // DEPENDENCIES — above all `@ezcorp/sdk`, which every bundled extension
      // imports. Those resolve through `<projectRoot>/node_modules` (a
      // workspace symlink to `<projectRoot>/packages/@ezcorp/*` in dev).
      // Neither lives under the extension's own dir, so the extDir/preloadDir
      // grant above let the child read its OWN code but NOT the code it
      // imports — under a non-advisory tier (landlock/bwrap) `bun` then exits
      // at module-load ("Cannot find module '@ezcorp/sdk/runtime'") and every
      // tool call surfaces "Transport closed". (It bites any host where the
      // tier resolves to landlock — the production container AND GitHub hosted
      // runners, where the real-auth e2e now exercises this path.) Landlock
      // binds the REAL inode, so the workspace `packages/` symlink targets
      // need their own grant alongside
      // `node_modules/`. existsSync-guarded: a bundled prod deploy ships a
      // real `node_modules` and no `packages/` dir. Deny-by-default is
      // unaffected — both are SIBLINGS of `.ezcorp/data`, never ancestors
      // (buildLandlockJailSpec re-asserts this and still denies the secret
      // even via a symlink that points back into the data dir).
      for (const dep of [
        join(projectRoot, "node_modules"),
        join(projectRoot, "packages"),
      ]) {
        if (existsSync(dep)) roPaths.push(dep);
      }
      const inner = [
        "prlimit",
        `--rss=${this.memoryLimitBytes}`,
        "bun",
        "run",
        "--preload",
        SANDBOX_PRELOAD_PATH,
        this.extensionPath,
      ];
      const built = buildSandboxArgv({
        tier,
        workspaceDir,
        projectRoot,
        roPaths,
        rwPaths,
        // `bun run <entrypoint>` canonicalizes paths by OPENING each directory
        // component (`openat(dir, O_DIRECTORY)`) as it walks UP the tree to
        // resolve the entrypoint's `node_modules`/workspace imports. Under a
        // non-advisory tier those dir-opens need READ_DIR on the whole path —
        // not just the leaf code dirs — or `bun` can't reach `node_modules`
        // and exits at module-load ("Cannot find module '@ezcorp/sdk/runtime'"
        // → the JSON-RPC transport closes → every tool call surfaces
        // "Transport closed"). Grant the project root TRAVERSE-only (READ_DIR,
        // NO file-read): the child can walk the tree to the RO-granted
        // `node_modules`/`packages` above while the `.ezcorp/data` secret +
        // DB stay unreadable (enumerable, never read). (It bites any host where
        // the tier resolves to landlock — the prod container AND GitHub hosted
        // runners.)
        traversePaths: [projectRoot],
        command: inner[0]!,
        args: inner.slice(1),
      });
      this.sandboxWrapCache = {
        argv: built.argv,
        env: built.env,
      };
    } catch (err) {
      // Fail-SAFE: a jail-build error must not break extension spawn (the
      // SDK module-poisoning still applies). Log and run unjailed.
      log.warn("sandbox wrap skipped (jail build failed)", {
        extensionId: this.extensionId,
        error: (err as Error).message,
      });
      this.sandboxWrapCache = null;
    }
    return this.sandboxWrapCache;
  }

  /**
   * Resolve the working directory to PIN on the spawn (for testing/inspection).
   *
   * `ensureRunning()`'s `Bun.spawn` starts the OUTER, still-UNJAILED process —
   * the landlock shim's `bun` (landlock tier) or the bare `prlimit … bun`
   * (advisory tier). With NO `cwd` option that process INHERITS the host
   * server's current working directory. If the host's cwd is ever invalid —
   * e.g. a bundled preview/prod server whose launch directory was removed out
   * from under it (a git-worktree churn scenario) — the outer `bun` aborts at
   * startup reading `.` with "error loading current directory
   * (CouldntReadCurrentDirectory)" (exit 1) BEFORE any extension code runs, so
   * EVERY extension subprocess dies at bring-up (#61). This is the OUTER-process
   * analogue of the shim's own `chdir(workspace)` (which protects only the
   * jailed INNER process): the shim can't rescue the outer `bun` because that
   * `bun` must already be running to apply the jail.
   *
   * Pin the spawn to the canonical project root instead: it's the resolver's
   * stable anchor (set by the harness + prod entrypoint, and the tree the
   * extension entrypoint + its `node_modules` live under — if IT is gone the
   * spawn can't read the entrypoint anyway), so it's a known-good cwd that does
   * NOT depend on inherited host state. Mirrors the sandbox capability probe,
   * which already spawnSyncs with `cwd: PROJECT_ROOT`. Returns undefined when
   * no project root was injected (back-compat: inherit exactly as before) — the
   * landlock shim still chdirs into the rw workspace before applying the jail,
   * so the jailed inner process's cwd is unchanged either way.
   */
  getSpawnCwd(): string | undefined {
    return this.allowedEnv.EZCORP_PROJECT_ROOT || undefined;
  }

  /**
   * Build the env passed to the subprocess: the explicit allowlist plus sandbox
   * permission flags consumed by `sandbox-preload.ts`.
   */
  private buildSpawnEnv(): Record<string, string> {
    const env: Record<string, string> = { ...this.allowedEnv };
    if (this.networkAllowed) env.EZCORP_NETWORK_ALLOWED = "1";
    if (this.shellAllowed) env.EZCORP_SHELL_ALLOWED = "1";
    // Sandbox-tier handoff for NESTED jail spawns. The poisoned subprocess
    // cannot probe the tier (capability-probe needs node:fs/child_process)
    // nor resolve the shim path (needs fs), so the host bakes both into the
    // env. A spawn site inside the subprocess (ez-code-factory's mutating-
    // git shell) then assembles `bun <shim> -- <cmd>` + a RAW spec env
    // (LANDLOCK_RAW_SPEC_ENV) PURELY — the shim, a fresh unpoisoned
    // process, does the realpath + data-dir assertions + landlock apply.
    // Set even at "advisory" (an explicit "no OS jail available" signal).
    env.EZCORP_SANDBOX_TIER = getSandboxTier();
    env.EZCORP_SANDBOX_SHIM = defaultShimPath();
    // Phase A4 (Seam A) — thread the landlock-tier jail spec env
    // (EZCORP_LANDLOCK_SPEC) when the spawn argv is shim-wrapped. Set AFTER
    // allowedEnv so the data-dir exclusion can't be overridden.
    const wrap = this.resolveSandboxWrap();
    if (wrap) Object.assign(env, wrap.env);
    return env;
  }

  /**
   * Log-and-swallow net for the fire-and-forget stderr-drain loop. The loop
   * already swallows the expected "stream closed" throw internally; this final
   * `.catch` arm catches anything it couldn't (e.g. a `TextDecoder` blow-up) so
   * a drain failure surfaces in logs instead of becoming an unhandled
   * rejection. Bound arrow (not a plain method) so it can be passed by
   * reference to `.catch` — and named so the swallow path is unit-testable.
   */
  private readonly onDrainError = (err: unknown): void => {
    log.debug("Unexpected error draining stderr", {
      extensionId: this.extensionId,
      error: String(err),
    });
  };

  /**
   * Log-and-swallow net for the fire-and-forget unexpected-exit handler. The
   * handler's DB / registry work is already inner-try/caught; this arm catches
   * anything its remaining statements could throw so the `.then` chain never
   * becomes an unhandled rejection. Bound + named for the same reason as
   * {@link onDrainError}.
   */
  private readonly onExitHandlerError = (err: unknown): void => {
    log.error("Extension process exit handler failed", {
      extensionId: this.extensionId,
      error: String(err),
    });
  };

  /** Spawn the subprocess if not already running. */
  override ensureRunning(): void {
    if (this.proc && !this.killed) return;

    // Install-path pre-check (kills a DIFFERENT crash loop than the
    // npm-dependency one below). If the entrypoint file doesn't exist on
    // disk, that is an ENVIRONMENT problem — the DB row's install path
    // doesn't resolve from THIS process (a host-vs-container path
    // mismatch, a moved/deleted checkout, a stale `EZCORP_PROJECT_ROOT`)
    // — never a defect in the extension's own code. Left unchecked, Bun
    // fails to spawn the missing file ("Module not found" /
    // "Cannot find module"), which looks EXACTLY like a genuine crash to
    // the code below: `proc.exited` fires, `consecutive_failures`
    // increments, and three unlucky calls permanently disables an
    // extension whose code was never at fault (live incident: a host-side
    // process reading a database whose bundled `install_path` rows were
    // written by a container boot). THROW here instead, before
    // `Bun.spawn` ever runs — same shape as the npm-dependency pre-check
    // below, and for the same reason: no spawn, no `proc.exited`, no
    // failure increment, no auto-disable. A genuine repeated CODE crash
    // (the entrypoint exists and exits non-zero on its own) still reaches
    // `Bun.spawn` and still counts exactly as before.
    if (!existsSync(this.extensionPath)) {
      throw new Error(
        `Extension "${this.extensionName ?? this.extensionId}" install path could not be resolved: ` +
          `"${this.extensionPath}" does not exist. This looks like an environment problem — a ` +
          "host-vs-container path mismatch, a moved/deleted install directory, or a stale " +
          "EZCORP_PROJECT_ROOT — not a crash in the extension's code, so it does not count " +
          "toward the auto-disable threshold. Fix the path/environment and try again.",
      );
    }

    // npm-dependency pre-check (kills the crash-loop). Verify the
    // manifest's declared third-party npm deps resolve from the
    // extension's install dir BEFORE spawning. On failure THROW the
    // actionable message: no spawn happens, so `proc.exited` never runs,
    // no `consecutive_failures` increment fires, and the auto-disable
    // loop is never entered — every call surfaces the same operator
    // message in the tool result / preprocess card instead. (Live
    // incident 2026-07-11: `@zxing/library` missing from the image.)
    if (this.npmDependencies) {
      const check = verifyNpmDependencies(this.npmDependencies, dirname(this.extensionPath));
      if (!check.ok) {
        throw new Error(
          formatNpmDepError(this.extensionName ?? this.extensionId, check.issues),
        );
      }
    }

    this.killed = false;

    const spawnCwd = this.getSpawnCwd();
    this.proc = Bun.spawn(this.getSpawnArgs(), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.buildSpawnEnv(), // CRITICAL: explicit env, never process.env
      // Pin a known-good cwd so a spawn never depends on the host server's
      // (possibly-invalid) inherited working directory — see getSpawnCwd (#61).
      ...(spawnCwd ? { cwd: spawnCwd } : {}),
    });

    // Drain stderr so the kernel pipe buffer (~64KB on Linux) never
    // fills (a full pipe blocks the child's write and surfaces as a
    // spurious "Transport closed" crash). Previously the contents were
    // DISCARDED — which made a child that crashed/hung during
    // module-load or `--preload` resolution completely undiagnosable
    // (no stdout JSON-RPC ever, no error anywhere, just a 90s watchdog
    // hang). Now we keep a bounded tail and surface it on unexpected
    // exit so subprocess-bringup failures are visible.
    this.stderrTail = "";
    // Track the drain-loop promise so `call()`'s crash-enrichment path can
    // await the child's final stderr flush (bounded) before surfacing a
    // "Transport closed" rejection. Defaults resolved (no stream to drain);
    // reassigned to the live drain when the child exposes a stderr stream.
    this.stderrDrained = Promise.resolve();
    const stderrStream = this.proc.stderr as ReadableStream<Uint8Array> | null;
    if (stderrStream) {
      this.stderrDrained = (async () => {
        const decoder = new TextDecoder();
        try {
          const reader = stderrStream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
              this.stderrTail += decoder.decode(value, { stream: true });
              // Keep only the last STDERR_TAIL_CAP chars — enough for a
              // stack/preload error, bounded against a chatty child.
              if (this.stderrTail.length > STDERR_TAIL_CAP) {
                this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_CAP);
              }
            }
          }
        } catch { /* stream closed — nothing to drain */ }
      })().catch(this.onDrainError);
    }

    this.transport = new JsonRpcTransport(
      this.proc.stdin as { write(data: string | Uint8Array): number; flush?(): void },
      this.proc.stdout as ReadableStream<Uint8Array>,
    );
    this.transport.startReading();
    this.wireRequestHandler();
    this.wireNotificationHandler();

    activeProcesses.add(this);
    this.resetIdleTimer();

    // Monitor for unexpected exit. The handler's DB / registry work is wrapped
    // in inner try/catch and the remaining statements are not expected to
    // throw, but a final `.catch` net (log-and-swallow) guards the
    // fire-and-forget chain against ANY escaping rejection so it can never
    // surface as an unhandled rejection; `void` marks the intent.
    void this.proc.exited
      .then(async (exitCode) => {
        if (this.killed) return; // Expected kill, not a crash
        activeProcesses.delete(this);
        this.proc = null;
        this.transport = null;

        // Surface the child's stderr tail. A subprocess that crashes
        // during module-load / `--preload` resolution writes its error
        // ONLY to stderr and never emits stdout JSON-RPC — without this
        // the failure is invisible (just a downstream watchdog hang).
        const tail = this.stderrTail.trim();
        log.error("Extension subprocess exited unexpectedly (crash)", {
          extensionId: this.extensionId,
          exitCode,
          ...(tail ? { stderrTail: tail } : {}),
        });

        // Crash detected -- increment failures
        try {
          const count = await incrementFailures(this.extensionId);
          if (count >= AUTO_DISABLE_THRESHOLD) {
            await disableExtension(this.extensionId);
            // Make the auto-disable VISIBLE + actionable, and reconcile
            // the in-memory registry so a disabled extension stops being
            // re-spawned on the next tool call (closes the DB-vs-in-memory
            // divergence where a disabled ext kept crashing until an
            // unrelated reload). The stderr tail is redacted so no token
            // echoed to stderr lands in the log.
            log.error("Extension auto-disabled after repeated crashes", {
              extensionId: this.extensionId,
              threshold: AUTO_DISABLE_THRESHOLD,
              consecutiveFailures: count,
              ...(tail ? { stderrTail: redactStderrTail(tail) } : {}),
              remedy:
                "Fix the crash cause (e.g. missing npm dependency), then re-enable from the Extensions page.",
            });
            try {
              // Dynamic import breaks the registry→subprocess module cycle;
              // wrapped because the DB/registry may be absent in tests.
              const { ExtensionRegistry } = await import("../../extensions/registry");
              await ExtensionRegistry.getInstance().reload();
            } catch {
              // Registry/DB unavailable (tests) — best-effort reconcile.
            }
          }
        } catch {
          // DB may not be available in tests
        }
      })
      .catch(this.onExitHandlerError);
  }

  /** Send a JSON-RPC call and wait for the response.
   *
   *  `options.skipTimeout` opts out of the per-call timeout race — the
   *  host awaits the subprocess response indefinitely, cancelled only
   *  by the caller's AbortSignal (or a subprocess crash). Used for
   *  human-in-the-loop tools (`ToolDefinition.requiresUserInput`) where
   *  the wait is bounded by user behavior, not server budget. */
  override async call(
    method: string,
    params?: Record<string, unknown>,
    options?: { skipTimeout?: boolean },
  ): Promise<JsonRpcResponse> {
    this.ensureRunning();

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };

    this.resetIdleTimer();

    const responsePromise = this.transport!.send(request);
    this.inFlightCalls++;

    try {
      const response = options?.skipTimeout
        ? await responsePromise
        : await Promise.race([
            responsePromise,
            new Promise<never>((_, reject) => {
              setTimeout(
                () => reject(new Error(`Tool call timed out after ${this.callTimeoutMs}ms`)),
                this.callTimeoutMs,
              );
            }),
          ]);
      // Success -- reset failure count
      try { await resetFailures(this.extensionId); } catch { /* DB may not be available in tests */ }
      return response;
    } catch (error) {
      // On timeout, kill the process
      if (error instanceof Error && error.message.includes("timed out")) {
        this.kill();
        throw error;
      }
      // A dead child rejects the pending JSON-RPC request with the opaque
      // "Transport closed" (json-rpc.ts) — no cause. Wait (bounded) for
      // the stderr drain to flush the child's real error, then surface it
      // so the tool result / preprocess card shows WHY the subprocess died
      // (e.g. "Cannot find module '@zxing/library'") rather than the
      // useless transport string. The 250ms cap keeps a call from hanging
      // if the drain never completes; the tail is redacted for secrets.
      if (error instanceof Error && error.message.includes("Transport closed")) {
        await Promise.race([this.stderrDrained, Bun.sleep(250)]);
        const tail = this.stderrTail.trim();
        if (tail.length > 0) {
          throw new Error(`Extension subprocess crashed: ${redactStderrTail(tail)}`);
        }
      }
      throw error;
    } finally {
      this.inFlightCalls--;
      if (this.inFlightCalls === 0) {
        const waiters = this.callSettledWaiters;
        this.callSettledWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  /** How many host-initiated calls are awaiting a response right now.
   *
   *  `ExtensionRegistry.reload()` reads this so an upgrade never kills a
   *  subprocess mid-call. The install path reloads the registry from INSIDE
   *  a reverse-RPC handler (`ezcorp/drafts.install`) — i.e. while the host
   *  is still awaiting the `install_draft` tool call that triggered it — so
   *  a naive kill would strand that call forever and wedge the chat. */
  override get inFlightCallCount(): number {
    return this.inFlightCalls;
  }

  /** Resolves once no host-initiated call is in flight; resolves
   *  immediately when the process is already idle. Never rejects — a
   *  crashed or killed child rejects its pending call, which still settles
   *  the counter. */
  override whenCallsSettled(): Promise<void> {
    if (this.inFlightCalls === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.callSettledWaiters.push(resolve);
    });
  }

  /** Call a tool by name with arguments. Convenience wrapper around call().
   *
   *  `meta` rides in the JSON-RPC `_meta` field of the request (MCP's
   *  standard metadata channel — see modelcontextprotocol/sdk types).
   *  Used by the tool executor to thread server-side context (invoking
   *  user id, conversation id) that must NOT be visible to the LLM. The
   *  subprocess receives it via `RequestHandlerExtra._meta` on each tool
   *  callback. Omitted entirely when `meta` is not supplied — keeps the
   *  wire format backward compatible with extensions written before the
   *  _meta side-channel existed. */
  override async callTool(
    toolName: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
    options?: { skipTimeout?: boolean },
  ): Promise<ToolCallResult> {
    const params: Record<string, unknown> = { name: toolName, arguments: args };
    if (meta && Object.keys(meta).length > 0) params._meta = meta;
    const response = await this.call("tools/call", params, options);
    if (response.error) {
      return {
        content: [{ type: "text", text: response.error.message }],
        isError: true,
      };
    }
    return response.result as ToolCallResult;
  }

  /** Kill the subprocess and clean up. */
  override kill(): void {
    this.killed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
    activeProcesses.delete(this);
  }

  /**
   * Set a handler for incoming JSON-RPC requests from the subprocess (reverse RPC).
   * The handler is re-wired on process restart via ensureRunning().
   */
  override setRequestHandler(handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>): void {
    this.pendingRequestHandler = handler;
    if (this.transport) {
      this.wireRequestHandler();
    }
  }

  private wireRequestHandler(): void {
    if (!this.transport || !this.pendingRequestHandler) return;
    const handler = this.pendingRequestHandler;
    this.transport.onRequest = (req) => {
      handler(req)
        .then((response) => {
          if (!this.proc?.stdin) return;
          const stdin = this.proc.stdin as { write(d: string): number };
          // Phase 3: handlers may opt into chunked-frame streaming by
          // returning a `{streamed: true, frames}` envelope. Each frame
          // is a fully-formed line (announce / chunk / cancel) that
          // we write verbatim — the host's outbound side does NOT
          // re-encode them as JSON. Small responses keep using the
          // single-line legacy format.
          const maybeStreamed = response as unknown as {
            streamed?: boolean;
            frames?: readonly string[];
          };
          if (maybeStreamed.streamed === true && Array.isArray(maybeStreamed.frames)) {
            for (const frame of maybeStreamed.frames) {
              stdin.write(frame);
            }
            return;
          }
          const data = JSON.stringify(response) + "\n";
          stdin.write(data);
        })
        .catch((err) => {
          log.error("Reverse-RPC request handler failed", { extensionId: this.extensionId, error: String(err) });
          if (this.proc?.stdin) {
            const errorResp = JSON.stringify({
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32603, message: String(err) },
            }) + "\n";
            try {
              (this.proc.stdin as { write(d: string): number }).write(errorResp);
            } catch (writeErr) {
              log.debug("Failed to write error response to subprocess stdin", { extensionId: this.extensionId, error: String(writeErr) });
            }
          }
        });
    };
  }

  /**
   * Set a handler for incoming JSON-RPC notifications from the subprocess.
   * Notifications are fire-and-forget (no response sent back).
   */
  override setNotificationHandler(handler: (notification: JsonRpcNotification) => void): void {
    this.pendingNotificationHandler = handler;
    if (this.transport) {
      this.wireNotificationHandler();
    }
  }

  private wireNotificationHandler(): void {
    if (!this.transport || !this.pendingNotificationHandler) return;
    this.transport.onNotification = this.pendingNotificationHandler;
  }

  /**
   * Send a fire-and-forget JSON-RPC notification to the subprocess stdin.
   *
   * SPAWNS THE SUBPROCESS IF IT IS NOT RUNNING, exactly as {@link call}
   * does. It used to begin `if (!this.proc || this.killed) return;` and
   * document itself as "will NOT start it", which made every notification
   * to a COLD extension vanish without a trace:
   *
   *   - `ExtensionRegistry.getProcess()` only CONSTRUCTS an
   *     `ExtensionProcess`; it does not spawn.
   *   - `ToolExecutor.ensureSubprocessRpcWired()` only installs handlers
   *     on that object; it does not spawn either.
   *   - so the first Hub page action after a server restart hit this
   *     early return, the events route still answered `{ok:true}` with
   *     HTTP 200, and the operator's save was gone. Any prior render or
   *     tool call made it work, because `call()` warms the process —
   *     which is exactly what made it look intermittent.
   *
   * The events route's own comment already asserted "sendNotification
   * no-ops on a dead process, so a failed spawn here must surface". That
   * was the intent; nothing implemented it. This does.
   *
   * NEVER THROWS, so every existing fire-and-forget caller (the schedule
   * daemon, the lifecycle and event dispatchers, the webhook daemon) is
   * unaffected — `ensureRunning()` can throw on the npm-dependency
   * pre-check, and a background fire must not take its caller down.
   *
   * @returns whether the frame was handed to stdin. A `false` is the
   *   drop this method used to hide; callers that can tell a human
   *   (the events route) MUST surface it rather than reporting success.
   */
  override sendNotification(method: string, params?: Record<string, unknown>): boolean | Promise<void> {
    try {
      this.ensureRunning();
    } catch (err) {
      log.warn("notification dropped — subprocess could not be started", {
        extensionId: this.extensionId,
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (!this.proc || this.killed) {
      log.warn("notification dropped — no subprocess after ensureRunning", {
        extensionId: this.extensionId,
        method,
      });
      return false;
    }
    try {
      const data = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
      (this.proc.stdin as { write(d: string): number }).write(data);
      // A notification is real traffic — without this an idle-timeout
      // extension could be reaped between the write and the read.
      this.resetIdleTimer();
      return true;
    } catch (err) {
      log.warn("notification dropped — stdin write failed", {
        extensionId: this.extensionId,
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Whether the subprocess is currently running. */
  override get isRunning(): boolean {
    return this.proc !== null && !this.killed;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.persistent) {
      this.idleTimer = null;
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.kill();
    }, this.idleTimeoutMs);
  }
}

// ── Env building for the host harness ─────────────────────────────
// Moved from registry.ts: production never builds a host spawn env.

/**
 * Build the environment variables passed to an extension subprocess.
 * Only PATH, HOME, NODE_ENV, and a per-extension TMPDIR are included by default.
 * Manifest env vars are only added if they also appear in grantedPermissions.env.
 *
 * `injectedEnv` lets the caller (typically the web layer at startup) pass
 * bundled-extension credentials that were provisioned in-process — e.g. an
 * auto-minted loopback-only internal API key for ai-kit. Injected keys are
 * STILL gated by the manifest + granted-permissions check: an extension
 * that did not declare `EZCORP_API_KEY` in its manifest.permissions.env or
 * was not granted that env cannot receive it, even if the caller attempts
 * to inject. This preserves the manifest-declared trust boundary.
 */
export function buildAllowedEnv(
  manifest: ExtensionManifestV2,
  grantedPerms: ExtensionPermissions,
  extensionId: string,
  injectedEnv?: Readonly<Record<string, string>>,
): Record<string, string> {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  mkdirSync(extTmpDir, { recursive: true });

  const allowedEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "production",
    TMPDIR: extTmpDir,
  };

  // Only add env vars present in BOTH manifest.permissions.env AND
  // grantedPermissions.env. Injected values (internal creds) take precedence
  // over process.env — otherwise an operator accidentally setting
  // EZCORP_API_KEY on the host process could override a freshly minted,
  // properly scoped internal key with a long-lived admin key. Still subject
  // to the manifest+granted gate; we never add an env var that the manifest
  // didn't declare.
  if (manifest.permissions.env && grantedPerms.env) {
    for (const key of manifest.permissions.env) {
      if (!grantedPerms.env.includes(key)) continue;
      const injected = injectedEnv?.[key];
      if (injected !== undefined && injected !== "") {
        allowedEnv[key] = injected;
      } else if (process.env[key]) {
        allowedEnv[key] = process.env[key]!;
      }
    }
  }

  // EZCORP_PERMITTED_HOSTS — comma-joined granted network hostnames.
  // Consumed by `@ezcorp/sdk/runtime` fetchPermitted as the pre-network
  // allowlist. Only emitted when the manifest declared network permission
  // AND the user granted at least one hostname at install time.
  if (grantedPerms.network && grantedPerms.network.length > 0) {
    allowedEnv.EZCORP_PERMITTED_HOSTS = grantedPerms.network.join(",");
  }

  // Phase 3: EZCORP_FS_ALLOWED is informational ONLY — the SDK's
  // fs helpers (`@ezcorp/sdk/runtime/fs.fsRead/...`) read it to
  // fast-fail with a clean "no filesystem grant" error before
  // round-tripping to the host's `ezcorp/fs.*` reverse-RPC. The
  // sandbox-preload deniers fire regardless of this flag — granted
  // access does NOT unblock raw `Bun.file` / `node:fs` (see
  // sandbox-preload.ts FS_MODULES block + plan pillar 6). Mirrors
  // the existing `EZCORP_NETWORK_ALLOWED` / `EZCORP_SHELL_ALLOWED`
  // pattern at `subprocess.ts:168-169`, but emitted here so the
  // grant test (`grantedPerms.filesystem.length > 0`) lives next to
  // the granted-network test for symmetry.
  if (grantedPerms.filesystem && grantedPerms.filesystem.length > 0) {
    allowedEnv.EZCORP_FS_ALLOWED = "1";
  }

  // Phase post-perm-cleanup: EZCORP_PROJECT_ROOT — the project root
  // the host resolved at spawn time. Bundled extensions like
  // `task-stack` need to compute their `.ezcorp/extension-data/<name>/`
  // store path at module-load, but they run inside the Phase 3 sandbox
  // where `node:fs` is poisoned — they cannot do their own `.git` walk.
  // The host walks once and injects the answer. `findProjectRoot()`
  // throws if no `.git` ancestor is found; we swallow that so test
  // harnesses running outside a git tree don't crash on every spawn.
  // Subprocesses missing this var fall back to a lazy
  // `require("node:fs")` walk (only relevant outside the sandbox).
  try {
    allowedEnv.EZCORP_PROJECT_ROOT = findProjectRoot();
  } catch {
    // no .git ancestor — leave EZCORP_PROJECT_ROOT unset; the extension's
    // fallback path (or test harness) handles it. (Single-line comment: a
    // multi-line block comment here makes bun emit a phantom, never-hit DA
    // record on the continuation line, which the per-file gate can't clear.)
  }

  // EZCORP_EXTENSION_DATA_ROOT — dedicated data-dir root for bundled
  // extensions to compute their `.ezcorp/extension-data/<name>/` store
  // path. DELIBERATELY separate from EZCORP_PROJECT_ROOT: the latter is
  // consumed by `subprocess.ts`'s landlock-jail builder, and setting it
  // when it's currently unset would mismatch the jail root against the
  // subprocess cwd and crash every spawn with CouldntReadCurrentDirectory.
  // `getProjectRoot()` never throws (env → import-meta → git-walk →
  // cwd-fallback) and resolves the container root (`/app`) in dev and
  // prod alike — unlike `process.cwd()`, which is `/app/web` under the
  // vite-SSR dev server. This aligns the extension's data-dir reader with
  // where the host events route writes config; the `$CWD` fs grant now
  // also resolves to the project root (see `permissions.ts:grantCwdBase`)
  // so the read of that dir is covered by the grant. Extensions that
  // don't read this var ignore it; the sandbox never consults it.
  allowedEnv.EZCORP_EXTENSION_DATA_ROOT = getProjectRoot();

  // Phase 2: EZCORP_TOOL_NETWORK_CAPS — JSON-serialized
  // `{toolName: string[]}` mapping, parsed by the in-sandbox fetch
  // wrapper to enforce per-tool host allowlists narrower than the
  // extension-wide ceiling. The active tool name is read via the SDK's
  // `getToolContext()` (ALS).
  //
  // The wrapper uses this to intersect the request hostname against
  // BOTH the extension-wide grant (PERMITTED_HOSTS) AND the per-tool
  // declaration. A tool with no entry inherits the extension-wide
  // ceiling without further narrowing.
  //
  // Migration: `buildAllowedEnv` is called on every spawn. v3 manifests
  // pass through with their authored per-tool caps verbatim; v2 inputs
  // need `migrateManifestV2ToV3` to synthesize per-tool caps from the
  // extension-wide `permissions`. The migrator is idempotent on v3, but
  // re-running it allocates a new `tools[]` array on each spawn — N1
  // perf nit (validator nice-to-have). Short-circuit when the input is
  // already v3 AND every tool already has an authored `capabilities`
  // declaration: in that case the migration produces identical output.
  // The registry's hot path (live spawns) hits this short-circuit;
  // `test-helpers.ts` callers with raw v2 inputs
  // still pay the migration cost.
  const isFullyV3 =
    manifest.schemaVersion === 3 &&
    (manifest.tools ?? []).every((t) => t.capabilities !== undefined);
  const migrated = isFullyV3 ? manifest : migrateManifestV2ToV3(manifest);
  const toolCaps: Record<string, string[]> = {};
  for (const tool of migrated.tools ?? []) {
    const hosts = tool.capabilities?.network?.hosts;
    if (hosts && hosts.length > 0) {
      toolCaps[tool.name] = hosts.map((h) => h.toLowerCase());
    }
  }
  if (Object.keys(toolCaps).length > 0) {
    allowedEnv.EZCORP_TOOL_NETWORK_CAPS = JSON.stringify(toolCaps);
  }

  return allowedEnv;
}

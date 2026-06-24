import { JsonRpcTransport } from "./json-rpc";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, ToolCallResult } from "./types";
import { incrementFailures, disableExtension, resetFailures } from "../db/queries/extensions";
import { logger } from "../logger";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getSandboxTier } from "./sandbox/capability-probe";
import { buildSandboxArgv } from "./sandbox/build-sandbox-argv";
import { DEFAULT_RUNTIME_RO_DIRS } from "./sandbox/landlock";

const log = logger.child("extensions/subprocess");

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CALL_TIMEOUT_MS = 30 * 1000; // 30 seconds
const AUTO_DISABLE_THRESHOLD = 3;
// Bounded stderr retention — enough for a Bun preload error + stack,
// capped so a chatty child can't grow host memory.
const STDERR_TAIL_CAP = 16 * 1024;

export const DEFAULT_MEMORY_LIMIT_MB = 512;
export const MIN_MEMORY_LIMIT_MB = 512;

/** Track all active processes for cleanup on exit */
const activeProcesses = new Set<ExtensionProcess>();

// Register cleanup handler once
let cleanupRegistered = false;
function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on("exit", () => {
    for (const ep of activeProcesses) {
      ep.kill();
    }
  });
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
}

/**
 * Absolute path to the subprocess sandbox preload script.
 *
 * Resolution must work in two very different load contexts:
 *   1. Source — running directly under Bun: `import.meta.url` points at this
 *      file, so `dirname(...)/runtime/sandbox-preload.ts` resolves correctly.
 *   2. Bundled (svelte-adapter-bun production) — Vite collapses this module
 *      into `web/build/server/chunks/registry2-*.js`, so `import.meta.url`
 *      points at the chunk's directory, and the sibling `runtime/` folder
 *      doesn't exist there. The source is still on disk at
 *      `<projectRoot>/src/extensions/runtime/sandbox-preload.ts`, so we fall
 *      back to a cwd-anchored path.
 *
 * Same failure mode in either context: a wrong path makes Bun's
 * `--preload` fail, the subprocess exits immediately, the JSON-RPC transport
 * closes mid-call, and every extension tool surfaces "Transport closed" in
 * the UI. (`import.meta.dir` had a related "undefined" bug on Vite SSR.)
 */
function resolveSandboxPreloadPath(): string {
  // The preload is a real `.ts` file spawned as `bun --preload <path>`; it is
  // never imported, so it must exist on disk at spawn time. The colocated
  // path is correct when running from `src/` (the production container). When
  // the server is BUNDLED (the SvelteKit/Vite web preview the real-auth e2e
  // harness builds), `import.meta.url` points into
  // `.svelte-kit/output/server/chunks/…` and the `.ts` source was tree-shaken
  // away — so fall back to the source under `EZCORP_PROJECT_ROOT` (the
  // resolver's canonical anchor, set by the harness + prod entrypoint), then
  // a cwd-relative guess. Same fix as the landlock-shim path resolution.
  const root = process.env.EZCORP_PROJECT_ROOT;
  const candidates = [
    `${dirname(fileURLToPath(import.meta.url))}/runtime/sandbox-preload.ts`,
    ...(root ? [`${root}/src/extensions/runtime/sandbox-preload.ts`] : []),
    `${process.cwd()}/src/extensions/runtime/sandbox-preload.ts`,
  ];
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch { /* continue */ }
  }
  return candidates[0]!;
}
const SANDBOX_PRELOAD_PATH = resolveSandboxPreloadPath();

/**
 * Parse a memory limit string (e.g. "256MB", "1GB") to bytes.
 * Returns default if string is invalid.
 */
export function parseMemoryLimit(str: string): number {
  const match = str.match(/^(\d+)\s*(MB|GB)$/i);
  if (!match) return DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024;

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!.toUpperCase();

  if (unit === "GB") return value * 1024 * 1024 * 1024;
  return value * 1024 * 1024; // MB
}

/**
 * Manages a subprocess for a single extension.
 * Handles spawning, JSON-RPC communication, idle timeout, and crash detection.
 */
export class ExtensionProcess {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private transport: JsonRpcTransport | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bounded tail of the child's stderr — surfaced on unexpected exit
   *  so module-load / `--preload` crashes are diagnosable. */
  private stderrTail = "";
  private nextId = 1;
  private killed = false;

  private readonly idleTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly persistent: boolean;
  public readonly memoryLimitBytes: number;
  private readonly networkAllowed: boolean;
  private readonly shellAllowed: boolean;
  private pendingRequestHandler?: (req: JsonRpcRequest) => Promise<JsonRpcResponse>;
  private pendingNotificationHandler?: (notification: JsonRpcNotification) => void;

  constructor(
    public readonly extensionId: string,
    private readonly extensionPath: string,
    private readonly allowedEnv: Record<string, string>,
    options?: ExtensionProcessOptions,
  ) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.callTimeoutMs = options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.persistent = options?.persistent ?? false;
    this.networkAllowed = options?.networkAllowed ?? false;
    this.shellAllowed = options?.shellAllowed ?? false;

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
      const roPaths = [...DEFAULT_RUNTIME_RO_DIRS, extDir, preloadDir];
      // The child `bun run <entrypoint>` must also READ the extension's
      // DEPENDENCIES — above all `@ezcorp/sdk`, which every bundled extension
      // imports. Those resolve through `<projectRoot>/node_modules` (a
      // workspace symlink to `<projectRoot>/packages/@ezcorp/*` in dev).
      // Neither lives under the extension's own dir, so the extDir/preloadDir
      // grant above let the child read its OWN code but NOT the code it
      // imports — under a non-advisory tier (landlock/bwrap) `bun` then exits
      // at module-load ("Cannot find module '@ezcorp/sdk/runtime'") and every
      // tool call surfaces "Transport closed". (CI never caught this: GitHub
      // runners lack unprivileged userns → the tier probes `advisory` → no
      // jail. It bites any host where landlock is usable — the production
      // container tier.) Landlock binds the REAL inode, so the workspace
      // `packages/` symlink targets need their own grant alongside
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
        // DB stay unreadable (enumerable, never read). (CI never caught this:
        // GitHub runners lack unprivileged userns → tier probes `advisory` →
        // no jail. It bites any host where landlock is usable — the prod
        // container tier.)
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
   * Build the env passed to the subprocess: the explicit allowlist plus sandbox
   * permission flags consumed by `sandbox-preload.ts`.
   */
  private buildSpawnEnv(): Record<string, string> {
    const env: Record<string, string> = { ...this.allowedEnv };
    if (this.networkAllowed) env.EZCORP_NETWORK_ALLOWED = "1";
    if (this.shellAllowed) env.EZCORP_SHELL_ALLOWED = "1";
    // Phase A4 (Seam A) — thread the landlock-tier jail spec env
    // (EZCORP_LANDLOCK_SPEC) when the spawn argv is shim-wrapped. Set AFTER
    // allowedEnv so the data-dir exclusion can't be overridden.
    const wrap = this.resolveSandboxWrap();
    if (wrap) Object.assign(env, wrap.env);
    return env;
  }

  /** Spawn the subprocess if not already running. */
  ensureRunning(): void {
    if (this.proc && !this.killed) return;
    this.killed = false;

    this.proc = Bun.spawn(this.getSpawnArgs(), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.buildSpawnEnv(), // CRITICAL: explicit env, never process.env
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
    const stderrStream = this.proc.stderr as ReadableStream<Uint8Array> | null;
    if (stderrStream) {
      (async () => {
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
      })().catch((err) => {
        log.debug("Unexpected error draining stderr", { extensionId: this.extensionId, error: String(err) });
      });
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

    // Monitor for unexpected exit
    this.proc.exited
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
          }
        } catch {
          // DB may not be available in tests
        }
      })
      .catch((err) => {
        log.error("Extension process exit handler failed", { extensionId: this.extensionId, error: String(err) });
      });
  }

  /** Send a JSON-RPC call and wait for the response.
   *
   *  `options.skipTimeout` opts out of the per-call timeout race — the
   *  host awaits the subprocess response indefinitely, cancelled only
   *  by the caller's AbortSignal (or a subprocess crash). Used for
   *  human-in-the-loop tools (`ToolDefinition.requiresUserInput`) where
   *  the wait is bounded by user behavior, not server budget. */
  async call(
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
      }
      throw error;
    }
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
  async callTool(
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
  kill(): void {
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
  setRequestHandler(handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>): void {
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
  setNotificationHandler(handler: (notification: JsonRpcNotification) => void): void {
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
   * No-ops if the process isn't running (will NOT start it).
   */
  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.proc || this.killed) return;
    try {
      const data = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
      (this.proc.stdin as { write(d: string): number }).write(data);
    } catch {
      // Process stdin may be closed — silently ignore
    }
  }

  /** Whether the subprocess is currently running. */
  get isRunning(): boolean {
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

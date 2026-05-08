import { ExtensionProcess, type ExtensionProcessOptions, parseMemoryLimit } from "./subprocess";
import type { ToolDefinition, ExtensionManifestV2, ExtensionPermissions } from "./types";
import { migrateManifestV2ToV3, satisfiesRange } from "./manifest";
import { verifyPackageChecksums } from "./checksum";
import { denyAndDisable } from "./security";
import { listExtensions, updateExtension } from "../db/queries/extensions";
import { getDb } from "../db/connection";
import { agentConfigs } from "../db/schema";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { McpClient } from "../mcp/client";
import { buildSandboxedMcpSpec } from "./mcp-sandbox";
import type { McpProxyHandle } from "./mcp-proxy";
import { getPermissionEngine } from "./permission-engine";

/** Async resolver that produces a fresh env map on each spawn — exported
 *  so callers can type their resolver fns consistently without pulling in
 *  the registry class shape. */
export type InjectedEnvResolver = () => Promise<Readonly<Record<string, string>>>;

// ── Env Building (exported for testability) ─────────────────────

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
  // `mcp-sandbox.ts` / `test-helpers.ts` callers with raw v2 inputs
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

/**
 * Remove the per-extension TMPDIR. Call during extension removal.
 *
 * N2 (validator nit #5): also clears the per-extension deprecation
 * warning tracker in `tool-executor.ts` so a reinstalled extension
 * warns afresh on its first legacy `ezcorp/fs` shim call. Lazy
 * `require` keeps the registry → tool-executor edge dynamic so no
 * cyclic dependency materializes at module-load.
 */
export function cleanupExtTmpDir(extensionId: string): void {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  rmSync(extTmpDir, { recursive: true, force: true });
  try {
    const teModule = require("./tool-executor") as {
      clearFsDeprecationForExtension?: (id: string) => void;
    };
    teModule.clearFsDeprecationForExtension?.(extensionId);
  } catch {
    /* tool-executor unavailable (rare in tests); nothing to clear. */
  }
}

export interface RegisteredTool extends ToolDefinition {
  extensionId: string;
  extensionName: string;
  /** Original (unnamespaced) tool name for RPC calls to subprocess */
  originalName: string;
}

/**
 * In-memory registry mapping tool names to extensions.
 * Loads from DB and manages ExtensionProcess instances.
 */
export class ExtensionRegistry {
  private static instance: ExtensionRegistry | null = null;

  /** tool name -> registered tool info */
  private toolMap = new Map<string, RegisteredTool>();
  /** extension id -> tool definitions */
  private extensionTools = new Map<string, RegisteredTool[]>();
  /** extension id -> ExtensionProcess */
  private processes = new Map<string, ExtensionProcess>();
  /** extension id -> McpClient (for kind:"mcp" extensions) */
  private mcpClients = new Map<string, McpClient>();
  /** Phase 7: extension id -> per-MCP forward-proxy handle. Populated
   *  in `getMcpClient` after `buildSandboxedMcpSpec` starts the proxy;
   *  torn down in `killAll` and on `getMcpClient`'s connect-failure
   *  branch. The proxy listens on the per-MCP UDS (Linux netns) or
   *  loopback port (fallback) and gates outbound HTTPS via PDP. */
  private mcpProxies = new Map<string, McpProxyHandle>();
  /** extension id -> manifest */
  private manifests = new Map<string, ExtensionManifestV2>();
  /** extension id -> install path */
  private installPaths = new Map<string, string>();
  /** extension id -> granted permissions */
  private grantedPerms = new Map<string, ExtensionPermissions>();
  /** extension id -> provenance flag from DB (true = installed by
   *  bundled.ts's ensureBundledExtensions, which authorizes the
   *  integrity-check skip). Replaces the old name-based lookup — see
   *  finding #2 / tasks/ext-audit-fixes/requirements.md. */
  private bundledFlags = new Map<string, boolean>();
  /** callerExtId -> depPackageName -> resolvedExtId */
  private depRoutes = new Map<string, Map<string, string>>();
  /** Extensions verified this session (cleared on reload) */
  private verifiedSessions = new Set<string>();
  /** extension-NAME (not id) -> env map to inject at spawn time. Populated
   *  by the web layer for bundled extensions that need loopback-only
   *  internal credentials (e.g. ai-kit's ezkint_ API key + EZCORP_BASE_URL).
   *  Keyed by name because the id is DB-generated but the provisioning
   *  layer only knows the well-known name. */
  private injectedEnvByName = new Map<string, Readonly<Record<string, string>>>();
  /** extension-NAME -> async resolver, invoked on each spawn to produce a
   *  fresh env map. Used for credentials that can expire (OAuth tokens) —
   *  the resolver is responsible for refreshing upstream and returning
   *  the current token. Overrides the static map for the same name. */
  private envResolversByName: Map<string, InjectedEnvResolver> = new Map();

  private constructor() {}

  /** Register a set of env vars to inject into the named extension's
   *  subprocess at spawn time. Intended for bundled-extension credentials
   *  that are provisioned in the parent process and should never land in
   *  the top-level process.env (which would leak them to every spawned
   *  subprocess rather than just the target). Each key is still gated by
   *  the manifest's declared env permissions — see buildAllowedEnv. */
  setInjectedEnv(extensionName: string, env: Readonly<Record<string, string>>): void {
    this.injectedEnvByName.set(extensionName, { ...env });
  }

  /** Register an async resolver that produces the env map on each spawn.
   *  Use for credentials with short lifetimes (OAuth access tokens): the
   *  resolver can hit the credentials layer to refresh before returning.
   *  A resolver takes precedence over any static entry for the same name.
   *  Resolver errors are swallowed — the extension is spawned with no
   *  injected env and reports its own clean error. */
  setInjectedEnvResolver(extensionName: string, resolver: InjectedEnvResolver): void {
    this.envResolversByName.set(extensionName, resolver);
  }

  /** Clear any injected env for the named extension. Use on uninstall so a
   *  stale credential isn't available to a re-registered extension. */
  clearInjectedEnv(extensionName: string): boolean {
    const a = this.injectedEnvByName.delete(extensionName);
    const b = this.envResolversByName.delete(extensionName);
    return a || b;
  }

  /** Test-only: wipe the injected-env registry. */
  resetInjectedEnvForTests(): void {
    this.injectedEnvByName.clear();
    this.envResolversByName.clear();
  }

  static getInstance(): ExtensionRegistry {
    if (!ExtensionRegistry.instance) {
      ExtensionRegistry.instance = new ExtensionRegistry();
    }
    return ExtensionRegistry.instance;
  }

  /** Reset singleton (for testing). */
  static resetInstance(): void {
    if (ExtensionRegistry.instance) {
      ExtensionRegistry.instance.killAll();
      ExtensionRegistry.instance = null;
    }
  }

  /** Load all enabled extensions from DB and rebuild maps. */
  async loadFromDb(): Promise<void> {
    this.toolMap.clear();
    this.extensionTools.clear();
    this.manifests.clear();
    this.installPaths.clear();
    this.grantedPerms.clear();
    this.bundledFlags.clear();

    const exts = await listExtensions(true);

    for (const ext of exts) {
      const manifest = ext.manifest as ExtensionManifestV2;
      this.manifests.set(ext.id, manifest);
      if (ext.installPath) this.installPaths.set(ext.id, ext.installPath);
      this.grantedPerms.set(ext.id, ext.grantedPermissions);
      this.bundledFlags.set(ext.id, (ext as { isBundled?: boolean }).isBundled === true);

      // Namespace separator: use `__` (double underscore), NOT `.`.
      // Anthropic's tool-name pattern is `^[a-zA-Z0-9_-]+$` which rejects dots;
      // passing `ext.name` to the LLM threw `Invalid 'tools[N].name'` errors
      // every time an agent was handed an extension tool.
      const tools: RegisteredTool[] = (manifest.tools ?? []).map((t) => ({
        ...t,
        name: `${manifest.name}__${t.name}`,
        originalName: t.name,
        extensionId: ext.id,
        extensionName: ext.name,
      }));

      this.extensionTools.set(ext.id, tools);
      for (const tool of tools) {
        this.toolMap.set(tool.name, tool);
      }
    }

    this.buildDepRoutes();
  }

  /** Get the extension ID that provides a given tool name. */
  getToolExtension(toolName: string): string | null {
    return this.toolMap.get(toolName)?.extensionId ?? null;
  }

  /** Get the full RegisteredTool for a given namespaced tool name. */
  getRegisteredTool(toolName: string): RegisteredTool | null {
    return this.toolMap.get(toolName) ?? null;
  }

  /** Get granted permissions for an extension (used by ezcorp/fs handler). */
  getGrantedPermissions(extensionId: string): ExtensionPermissions | null {
    return this.grantedPerms.get(extensionId) ?? null;
  }

  /** Get the install path for an extension (used by ezcorp/fs handler). */
  getInstallPath(extensionId: string): string | null {
    return this.installPaths.get(extensionId) ?? null;
  }

  /** Get all tools assigned to an agent config via its extensions field. */
  async getToolsForAgent(agentConfigId: string): Promise<ToolDefinition[]> {
    const rows = await getDb()
      .select({ extensions: agentConfigs.extensions })
      .from(agentConfigs)
      .where(eq(agentConfigs.id, agentConfigId));

    if (!rows[0]) return [];

    const extensionIds = (rows[0].extensions as string[] | null) ?? [];
    const tools: ToolDefinition[] = [];

    for (const extId of extensionIds) {
      const extTools = this.extensionTools.get(extId);
      if (extTools) {
        tools.push(...extTools.map(({ extensionId, extensionName, originalName, ...t }) => t));
      }
    }

    return tools;
  }

  /** Get all RegisteredTools for a given extension ID. */
  getToolsForExtension(extensionId: string): RegisteredTool[] {
    return this.extensionTools.get(extensionId) ?? [];
  }

  /** Get an existing process ONLY if it is already running. Never starts a new process. */
  getProcessIfRunning(extensionId: string): ExtensionProcess | null {
    const proc = this.processes.get(extensionId);
    return proc?.isRunning ? proc : null;
  }

  /** Get the manifest for an extension by ID. */
  getManifest(extensionId: string): ExtensionManifestV2 | undefined {
    return this.manifests.get(extensionId);
  }

  /**
   * Get the manifest for an extension by NAME. Used by the composer's
   * pending-extension MIME lookup, where we know the name from a
   * `!ext:NAME` mention but not yet the DB id.
   */
  getManifestByName(name: string): ExtensionManifestV2 | undefined {
    for (const m of this.manifests.values()) {
      if (m.name === name) return m;
    }
    return undefined;
  }

  /** Iterate over all registered extension manifests. */
  getAllManifests(): IterableIterator<[string, ExtensionManifestV2]> {
    return this.manifests.entries();
  }

  /** Get or create an ExtensionProcess for the given extension ID. */
  async getProcess(extensionId: string, options?: ExtensionProcessOptions): Promise<ExtensionProcess> {
    let proc = this.processes.get(extensionId);
    if (proc?.isRunning) {
      return proc;
    }

    const manifest = this.manifests.get(extensionId);
    const installPath = this.installPaths.get(extensionId);
    if (!manifest || !installPath) {
      throw new Error(`Extension ${extensionId} not found in registry`);
    }

    // Verify package integrity on first load per session. Bundled
    // extensions (those in src/extensions/bundled.ts) are skipped: their
    // source lives in this repo and changes legitimately with every pull,
    // so a file-level integrity check against install-time checksums
    // would wedge the whole server after any commit that touched the
    // extension's directory. Trust is rooted elsewhere for bundled
    // extensions (code review on the repo, signed commits, etc.).
    // Audit finding #2 fix: bundled trust comes from the DB row's
    // `isBundled` flag, not from matching `manifest.name` against the
    // hardcoded list. Prevents an attacker-installed extension named
    // "ai-kit" (or any other bundled name) from inheriting the
    // integrity-check skip.
    const isBundled = this.bundledFlags.get(extensionId) === true;
    if (
      !isBundled &&
      !this.verifiedSessions.has(extensionId) &&
      manifest.packageChecksums
    ) {
      const result = await verifyPackageChecksums(installPath, manifest.packageChecksums);
      if (!result.valid) {
        await denyAndDisable(extensionId, "Integrity check failed: files modified since install", installPath);
        this.processes.delete(extensionId);
        this.manifests.delete(extensionId);
        this.installPaths.delete(extensionId);
        this.grantedPerms.delete(extensionId);
        throw new Error(`Extension ${extensionId} failed integrity check: ${result.mismatched.join(", ")}`);
      }
      this.verifiedSessions.add(extensionId);
    }

    if (!manifest.entrypoint) {
      throw new Error(`Extension ${extensionId} has no entrypoint defined`);
    }
    const entrypoint = `${installPath}/${manifest.entrypoint.replace(/^\.\//, "")}`;
    const granted = this.grantedPerms.get(extensionId) ?? { grantedAt: {} };
    const resolver = this.envResolversByName.get(manifest.name);
    let injected = this.injectedEnvByName.get(manifest.name);
    if (resolver) {
      try {
        injected = await resolver();
      } catch {
        // Resolver failed (upstream unreachable, no configured credential).
        // Spawn with no injected env — the extension surfaces a clean
        // error to the caller rather than stalling the whole run.
        injected = undefined;
      }
    }
    const allowedEnv = buildAllowedEnv(manifest, granted, extensionId, injected);

    const memOpt = manifest.resources?.memory;
    const memoryLimitBytes = memOpt ? parseMemoryLimit(memOpt) : undefined;
    // Manifest-declared per-call timeout. Extensions that make slow
    // upstream calls (e.g. image generation) declare a higher value so
    // the subprocess dispatcher doesn't cut them off at the 30s default.
    const callTimeoutMs =
      typeof manifest.resources?.callTimeoutMs === "number" && manifest.resources.callTimeoutMs > 0
        ? manifest.resources.callTimeoutMs
        : undefined;

    proc = new ExtensionProcess(extensionId, entrypoint, allowedEnv, {
      persistent: manifest.persistent,
      memoryLimitBytes,
      callTimeoutMs,
      networkAllowed: (granted.network?.length ?? 0) > 0,
      shellAllowed: granted.shell === true,
      ...options,
    });

    this.processes.set(extensionId, proc);
    return proc;
  }

  /** Get all registered tool definitions. */
  getAllTools(): ToolDefinition[] {
    return Array.from(this.toolMap.values()).map(({ extensionId, extensionName, originalName, ...t }) => t);
  }

  /** Derive extension type from manifest: "mcp", "agent", or "extension". */
  getExtensionType(extensionName: string): string {
    for (const [, manifest] of this.manifests) {
      if (manifest.name === extensionName) {
        if ((manifest.mcpServers?.length ?? 0) > 0) return "mcp";
        if (manifest.agent && !(manifest.tools?.length) && !(manifest.skills?.length)) return "agent";
        return "extension";
      }
    }
    return "extension";
  }

  /**
   * Resolve a dependency tool for a caller extension.
   * Returns the RegisteredTool if the caller has declared this dependency, null otherwise.
   */
  resolveDepTool(callerExtId: string, namespacedTool: string): RegisteredTool | null {
    const sepIdx = namespacedTool.indexOf("__");
    if (sepIdx === -1) return null;

    const pkgName = namespacedTool.slice(0, sepIdx);
    const callerDeps = this.depRoutes.get(callerExtId);
    if (!callerDeps) return null;

    const targetExtId = callerDeps.get(pkgName);
    if (!targetExtId) return null;

    return this.toolMap.get(namespacedTool) ?? null;
  }

  /**
   * Build dependency routing table from installed extensions' manifests.
   * Maps each extension's declared dependencies to the installed extension IDs.
   */
  buildDepRoutes(): void {
    this.depRoutes.clear();

    for (const [extId, manifest] of this.manifests) {
      if (!manifest.dependencies) continue;

      const routes = new Map<string, string>();
      for (const [depName, depSpec] of Object.entries(manifest.dependencies)) {
        // Find installed extension with matching name and version
        for (const [candidateId, candidateManifest] of this.manifests) {
          if (candidateManifest.name === depName && satisfiesRange(candidateManifest.version, depSpec.version)) {
            routes.set(depName, candidateId);
            break;
          }
        }

        // Check for multi-version installs (name@version)
        if (!routes.has(depName)) {
          const rangeVersion = depSpec.version.replace(/^\^/, "");
          const scopedName = `${depName}@${rangeVersion}`;
          for (const [candidateId, candidateManifest] of this.manifests) {
            if (candidateManifest.name === scopedName) {
              routes.set(depName, candidateId);
              break;
            }
            // Check if the install path contains the scoped name
            const installPath = this.installPaths.get(candidateId);
            if (installPath && candidateManifest.name === depName && installPath.includes(scopedName)) {
              routes.set(depName, candidateId);
              break;
            }
          }
        }
      }

      if (routes.size > 0) {
        this.depRoutes.set(extId, routes);
      }
    }
  }

  // ── Test helpers ──────────────────────────────────────────────────

  /** Set dep routes directly (for testing). */
  setDepRoutes(routes: Map<string, Map<string, string>>): void {
    this.depRoutes = routes;
  }

  /** Register a single tool in the toolMap (for testing). */
  registerToolForTest(name: string, tool: RegisteredTool): void {
    this.toolMap.set(name, tool);
  }

  /** Set a manifest for an extension (for testing). */
  setManifestForTest(extId: string, manifest: ExtensionManifestV2): void {
    this.manifests.set(extId, manifest);
  }

  /** Set granted permissions for an extension (for testing). */
  setGrantedPermsForTest(extId: string, perms: ExtensionPermissions): void {
    this.grantedPerms.set(extId, perms);
  }

  /** Set the install path for an extension (for testing). */
  setInstallPathForTest(extId: string, path: string): void {
    this.installPaths.set(extId, path);
  }

  /** Re-read DB and rebuild maps. Call after install/uninstall.
   *
   *  Phase 7 fix-pass C3: a previous version leaked the per-MCP forward
   *  proxy on uninstall — `mcpProxies.clear()` only ran in `killAll()`,
   *  so an uninstalled MCP extension kept a listener (and its bearer
   *  token in memory) until process exit. We now snapshot the
   *  pre-reload extension-id set, run the reload, and stop+drop any
   *  proxy / mcp-client whose extensionId is no longer in the DB.
   */
  async reload(): Promise<void> {
    this.verifiedSessions.clear();
    await this.loadFromDb();

    // After loadFromDb, `this.manifests` reflects the post-reload set
    // of extension ids. Compare against the maps that hold live
    // resources.
    const liveIds = new Set(this.manifests.keys());

    for (const [extId, proxy] of this.mcpProxies) {
      if (!liveIds.has(extId)) {
        void proxy.stop().catch(() => {});
        this.mcpProxies.delete(extId);
      }
    }
    for (const [extId, client] of this.mcpClients) {
      if (!liveIds.has(extId)) {
        void client.close().catch(() => {});
        this.mcpClients.delete(extId);
      }
    }
  }

  /** Kill all managed processes and close MCP clients. */
  killAll(): void {
    for (const proc of this.processes.values()) {
      proc.kill();
    }
    this.processes.clear();
    for (const client of this.mcpClients.values()) {
      void client.close().catch(() => {});
    }
    this.mcpClients.clear();
    // Phase 7: tear down every per-MCP forward proxy. Stopping the
    // proxy unlinks its UDS (when applicable) so a subsequent boot or
    // re-load doesn't trip EADDRINUSE.
    for (const proxy of this.mcpProxies.values()) {
      void proxy.stop().catch(() => {});
    }
    this.mcpProxies.clear();
  }

  /**
   * Get or create an `McpClient` for an MCP-kind extension.
   * Lazily constructs and connects on first call.
   */
  async getMcpClient(extensionId: string): Promise<McpClient> {
    const existing = this.mcpClients.get(extensionId);
    if (existing?.isConnected) return existing;

    const manifest = this.manifests.get(extensionId);
    if (!manifest) throw new Error(`Extension ${extensionId} not found in registry`);
    if (manifest.kind !== "mcp") throw new Error(`Extension ${extensionId} is not an MCP extension`);
    const server = manifest.mcpServers?.[0];
    if (!server) throw new Error(`Extension ${extensionId} has no mcpServers entry`);

    // Audit finding #1: route stdio spawns through the sandbox envelope
    // (prlimit + bounded env). http/sse are pass-through — nothing to wrap.
    //
    // Phase 7: when the PDP singleton is wired (production boot), pass
    // a `ctx` so `buildSandboxedMcpSpec` starts the per-MCP forward
    // proxy and (on Linux) wraps the spawn in `unshare`. The PDP being
    // unavailable is a test-time signal; we degrade to the pre-Phase-7
    // prlimit-only spec rather than fail-closed because many existing
    // unit tests construct registries without going through full boot.
    let phase7Ctx: { engine: ReturnType<typeof getPermissionEngine>; conversationId: null; userId: null } | undefined;
    try {
      phase7Ctx = {
        engine: getPermissionEngine(),
        conversationId: null,
        userId: null,
      };
    } catch {
      // Engine not initialized (test path) — fall through to pre-P7 wrap.
      phase7Ctx = undefined;
    }
    const granted = this.grantedPerms.get(extensionId) ?? { grantedAt: {} };
    const { spec: sandboxedSpec, proxyHandle } = await buildSandboxedMcpSpec(
      server,
      manifest,
      granted,
      extensionId,
      phase7Ctx,
    );

    if (proxyHandle) {
      // Stop any prior proxy for this extension (re-load path) before
      // recording the new handle.
      const prior = this.mcpProxies.get(extensionId);
      if (prior) {
        void prior.stop().catch(() => {});
      }
      this.mcpProxies.set(extensionId, proxyHandle);
    }

    const client = existing ?? new McpClient(sandboxedSpec);
    try {
      await client.connect();
    } catch (err) {
      this.mcpClients.delete(extensionId);
      // Tear down the proxy we just started — its child process never
      // came up, so the listener is leaked otherwise.
      const failedProxy = this.mcpProxies.get(extensionId);
      if (failedProxy) {
        void failedProxy.stop().catch(() => {});
        this.mcpProxies.delete(extensionId);
      }
      throw err;
    }
    this.mcpClients.set(extensionId, client);
    return client;
  }

  /**
   * Connect to the MCP server, re-list its tools, and write the fresh
   * list back into the extension row's manifest and in-memory maps.
   */
  async refreshMcpTools(extensionId: string): Promise<ToolDefinition[]> {
    const manifest = this.manifests.get(extensionId);
    if (!manifest || manifest.kind !== "mcp") {
      throw new Error(`Extension ${extensionId} is not an MCP extension`);
    }
    const client = await this.getMcpClient(extensionId);
    const tools = await client.listTools();

    const updatedManifest: ExtensionManifestV2 = { ...manifest, tools };
    this.manifests.set(extensionId, updatedManifest);

    const ext = (await listExtensions(false)).find((e) => e.id === extensionId);
    const extName = ext?.name ?? manifest.name;

    const registered: RegisteredTool[] = tools.map((t) => ({
      ...t,
      name: `${manifest.name}__${t.name}`,
      originalName: t.name,
      extensionId,
      extensionName: extName,
    }));
    const prev = this.extensionTools.get(extensionId) ?? [];
    for (const old of prev) this.toolMap.delete(old.name);
    this.extensionTools.set(extensionId, registered);
    for (const tool of registered) this.toolMap.set(tool.name, tool);

    await updateExtension(extensionId, { manifest: updatedManifest });
    return tools;
  }
}

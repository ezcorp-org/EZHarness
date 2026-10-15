import type { ExtensionProcess } from "./subprocess";
import { ReleaseProcess } from "./release-process";
import { ReleaseMcpClient } from "./release-mcp-client";
import { validateManifest as validateReleaseManifest } from "@ezcorp/extension-contract";
import type { ToolDefinition, ExtensionManifestV2, ExtensionPermissions } from "./types";
import { satisfiesRange } from "./manifest";
import { normalizeMcpManifest } from "./mcp-capabilities";
import { formatNpmDepError, verifyNpmDependencies } from "./npm-deps";
import { logger } from "../logger";
import { listExtensions } from "../db/queries/extensions";
import { getDb } from "../db/connection";
import { agentConfigs } from "../db/schema";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveInstallPath } from "./install-roots";
import type { McpClient } from "../mcp/client";
import {
  buildEntityToolDefinitions,
  entityToolNames,
  type EntityDeclaration,
} from "@ezcorp/sdk/entities";

const log = logger.child("extensions/registry");

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
  /**
   * SDK-served tool branch (Phase 3). When `entityKind` is one of
   * "list"|"get"|"create"|"update"|"delete", the dispatcher routes
   * the call to the SDK's auto-generated handler against the named
   * entity type instead of the extension's subprocess. The entity
   * type is the `EntityDeclaration.type` slug, which the dispatcher
   * uses to look up the declaration on the manifest at call time.
   *
   * Hand-rolled tools leave both fields undefined and route to the
   * subprocess as before.
   */
  entityKind?: "list" | "get" | "create" | "update" | "delete";
  entityType?: string;
}

/**
 * One extension's `tools/list_changed` refresh, and the AT MOST ONE re-run
 * coalesced behind it. `queued` is a flag rather than a count on purpose: a
 * catalog refresh is idempotent, so notifications 3..N of a burst ask for the
 * same work notification 2 already asked for. See
 * `ExtensionRegistry.onMcpToolListChanged`.
 */
interface McpToolRefresh {
  /** Settles when the in-flight refresh AND its coalesced re-run are done. */
  promise: Promise<void>;
  /** A notification arrived while the refresh was in flight. */
  queued: boolean;
}

/**
 * Build the 5 `RegisteredTool` entries for each declared entity. The
 * returned tools route to the SDK's auto-generated handler via the
 * `entityKind` + `entityType` discriminators — `tool-executor` reads
 * them and short-circuits the subprocess dispatch.
 *
 * Tool-name shape: `<extName>__<auto-name>` (mirrors hand-rolled tools).
 * Manifest validation (`entities/clamp.ts`) already verified no
 * collision against hand-rolled `tools[].name`, so this loop can
 * blindly emit the names without re-checking.
 */
export function buildEntityRegisteredTools(
  entities: readonly EntityDeclaration[] | undefined,
  extensionId: string,
  extensionDbName: string,
  manifestName: string,
): RegisteredTool[] {
  if (!entities || entities.length === 0) return [];
  const out: RegisteredTool[] = [];
  for (const decl of entities) {
    let defs: ReturnType<typeof buildEntityToolDefinitions>;
    let names: ReturnType<typeof entityToolNames>;
    try {
      defs = buildEntityToolDefinitions(decl);
      names = entityToolNames(decl);
    } catch (err) {
      // Should not happen — manifest validation rejects malformed
      // entities. Log + skip so a single broken declaration can't
      // wedge the registry boot.
      console.warn(
        `[registry] failed to build entity tools for ${manifestName}#${decl.type}: ${(err as Error).message}`,
      );
      continue;
    }
    const kindByName: Record<string, RegisteredTool["entityKind"]> = {
      [names.list]: "list",
      [names.get]: "get",
      [names.create]: "create",
      [names.update]: "update",
      [names.delete]: "delete",
    };
    for (const def of defs) {
      const kind = kindByName[def.name];
      if (!kind) continue;
      out.push({
        ...def,
        name: `${manifestName}__${def.name}`,
        originalName: def.name,
        extensionId,
        extensionName: extensionDbName,
        entityKind: kind,
        entityType: decl.type,
      });
    }
  }
  return out;
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
  /** extension id -> the extension's ONE in-flight `tools/list_changed`
   *  refresh, plus its single coalesced re-run. See
   *  {@link onMcpToolListChanged}; entries clear themselves when the drain
   *  settles, and `killAll()` / a stale `reload()` drop them to abandon a
   *  queued re-run. */
  private mcpToolRefreshes = new Map<string, McpToolRefresh>();
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
  private constructor() {}

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

  /** Bumped by every {@link loadFromDb}. Consumers that snapshot the tool
   *  surface — the per-run toolset assembled in
   *  `runtime/stream-chat/setup-tools.ts` — compare it against a stashed
   *  value to detect that an install / uninstall / upgrade happened under
   *  them, without re-querying the DB on every check. */
  private loadGeneration = 0;
  private readonly reloadListeners = new Set<() => void | Promise<void>>();

  onReload(listener: () => void | Promise<void>): () => void {
    this.reloadListeners.add(listener);
    return () => { this.reloadListeners.delete(listener); };
  }

  /** @see loadGeneration */
  get generation(): number {
    return this.loadGeneration;
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
      // MCP rows are synthesized by `installMcpExtension`, never by the disk
      // loader, so they NEVER pass through `migrateManifestV2ToV3` — the one
      // place a v2 manifest normally acquires its per-tool `capabilities`.
      // Normalizing here is what gives an MCP tool a non-empty needed-cap set
      // at the PDP, and it is deliberately read-time: `refreshMcpTools`
      // rewrites `manifest.tools` from a live `tools/list` that carries no
      // declaration, so an install-time-only derivation would be erased by the
      // first "Refresh tools" click. Non-MCP manifests are returned by
      // reference, untouched.
      const manifest = (ext.manifest as { schemaVersion?: number }).schemaVersion === 4
        ? validateReleaseManifest(ext.manifest) as unknown as ExtensionManifestV2
        : normalizeMcpManifest(ext.manifest as ExtensionManifestV2);
      this.manifests.set(ext.id, manifest);
      const isBundled = (ext as { isBundled?: boolean }).isBundled === true;
      // Bundled rows store `install_path` PROJECT-ROOT-RELATIVE (portability
      // fix — see `./install-roots.ts` `resolveInstallPath` +
      // `../db/migrations/relativize-bundled-install-paths.ts`), so it must
      // be reconstructed against THIS process's root before anything reads
      // the filesystem with it. Every other row's `install_path` is left
      // exactly as stored — `resolveInstallPath` is a no-op for an already-
      // absolute path, which is every genuinely external install.
      const resolvedInstallPath = isBundled
        ? resolveInstallPath(ext.installPath)
        : ext.installPath;
      if (resolvedInstallPath) this.installPaths.set(ext.id, resolvedInstallPath);
      this.grantedPerms.set(ext.id, ext.grantedPermissions);
      this.bundledFlags.set(ext.id, isBundled);
      this.reportUnhealedMcpRow(ext, manifest);

      // Boot visibility: surface an unresolvable npm-dependency declaration
      // at load so an operator sees it in the logs. VISIBILITY ONLY — do
      // NOT disable or throw: config drift must not nuke state at boot, and
      // the per-call spawn pre-check (subprocess.ts) already refuses the
      // spawn with the same actionable message. Applies to bundled AND
      // non-bundled; resolution is anchored at the extension's (resolved)
      // install dir.
      if ((manifest.schemaVersion as number) !== 4 && manifest.npmDependencies && resolvedInstallPath) {
        const check = verifyNpmDependencies(manifest.npmDependencies, resolvedInstallPath);
        if (!check.ok) {
          log.error("extension npm dependencies unresolvable", {
            extension: manifest.name,
            extensionId: ext.id,
            issues: check.issues,
            remedy: formatNpmDepError(manifest.name, check.issues),
          });
        }
      }

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

      // Phase 3: auto-generated entity tools. Each EntityDeclaration on
      // the manifest produces 5 CRUD tools (list/get/create/update/
      // delete) the host serves directly — see
      // `tool-executor.ts:executeToolCall` for the dispatch branch.
      // The auto-tools share the same `<ext-name>__<tool-name>`
      // namespace and tool-map shape as hand-rolled tools so the LLM
      // and chat composer don't need to know about the difference.
      // Manifest validation (clamp.ts) ensures the auto names don't
      // collide with hand-rolled tools[].name entries.
      const entityTools = buildEntityRegisteredTools(
        manifest.entities,
        ext.id,
        ext.name,
        manifest.name,
      );

      const merged = [...tools, ...entityTools];
      this.extensionTools.set(ext.id, merged);
      for (const tool of merged) {
        this.toolMap.set(tool.name, tool);
      }
    }

    this.buildDepRoutes();
    for (const listener of this.reloadListeners) await listener();
    this.loadGeneration++;
  }

  /**
   * Boot visibility for an MCP row the capability backfill never healed.
   *
   * The two paths that give an MCP row its capabilities can diverge:
   * `normalizeMcpManifest` derives the NEEDED set on every read, but the
   * GRANT is only written by `installMcpExtension` or by the one-shot
   * `backfillMcpManifestCapabilities`. If that backfill never ran — a boot
   * where the migrate circuit breaker is open (`db/connection.ts`), or a row
   * whose UPDATE threw and was caught — the row ends up NEEDING
   * `ezcorp:mcp:invoke` while GRANTING nothing, and every one of its tools
   * denies.
   *
   * That direction is deliberate. The alternative — deriving the grant at read
   * time too — cannot distinguish "never consented" from "consented, then
   * revoked": a revocation through `PUT /api/extensions/[id]/permissions`
   * writes only `grantedPermissions` and leaves `installedPermissions` alone,
   * so a read-time grant would silently re-grant a revoked row on every boot.
   * That is the inert-PDP defect this whole change exists to close, so the
   * divergence fails CLOSED — and is reported here instead of being silent.
   *
   * `installedPermissions === null` is the marker for "never consented":
   * every install and every healed row writes it, and a revocation never
   * clears it. So an intentionally-revoked row is silent and only an unhealed
   * one is reported.
   */
  private reportUnhealedMcpRow(
    ext: { id: string; name: string; installedPermissions?: unknown },
    manifest: ExtensionManifestV2,
  ): void {
    if (manifest.kind !== "mcp") return;
    if (ext.installedPermissions != null) return;
    log.error("MCP extension has no capability grant — every tool call will be denied", {
      extension: manifest.name,
      extensionId: ext.id,
      reason:
        "the one-shot MCP capability backfill has not run for this row (migrate skipped, or its row update failed)",
      remedy:
        "resolve the failed migration and restart, or re-save the server from the MCP edit form to re-issue the grant",
    });
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

  /**
   * True iff this extension was installed from `src/extensions/bundled.ts`
   * (first-party code). Sourced from the DB row's `isBundled` flag — NOT
   * from matching `manifest.name` against the hardcoded list — so an
   * attacker-installed extension can't impersonate a bundled name (same
   * trust root the integrity-check skip uses, see `ensureProcess`).
   */
  isBundled(extensionId: string): boolean {
    return this.bundledFlags.get(extensionId) === true;
  }

  /** Get all tools assigned to an agent config via its extensions field.
   *  Honors the per-extension tool subset (agentConfigs.extensionTools): an
   *  attached extension absent from the map (or mapped to an empty array)
   *  contributes ALL its tools; a non-empty array narrows it to just those.
   *  Matched defensively against both the namespaced name and the original
   *  (unnamespaced) name, mirroring the mode filter. */
  async getToolsForAgent(
    agentConfigId: string,
    opts?: {
      /**
       * Per-extension authorization hook, applied BEFORE an extension's
       * tools join the returned set (sec: F3).
       *
       * `agent_configs.extensions` holds RAW extension ids that the author
       * supplies through `POST /api/agent-configs` (scope `chat`, any
       * authenticated member) and that this method has always trusted
       * verbatim — no wiring, no ownership, no per-extension check. That
       * made "create an agent config naming an admin-installed MCP
       * extension id, then chat with it" a complete bypass of the wire
       * gate. The caller passes `canWireExtension` here; a rejected id is
       * skipped exactly as an unloaded one is.
       *
       * Async because the decision reads the extension row and, for a
       * member, the grants table. Returning false (or throwing, which the
       * caller's try/catch turns into an empty tool set) is fail-closed.
       */
      allowExtension?: (extensionId: string) => Promise<boolean>;
    },
  ): Promise<ToolDefinition[]> {
    const rows = await getDb()
      .select({ extensions: agentConfigs.extensions, extensionTools: agentConfigs.extensionTools })
      .from(agentConfigs)
      .where(eq(agentConfigs.id, agentConfigId));

    if (!rows[0]) return [];

    const extensionIds = (rows[0].extensions as string[] | null) ?? [];
    const perTool = (rows[0].extensionTools as Record<string, string[]> | null) ?? {};
    const tools: ToolDefinition[] = [];

    for (const extId of extensionIds) {
      const extTools = this.extensionTools.get(extId);
      if (!extTools) continue;
      if (opts?.allowExtension && !(await opts.allowExtension(extId))) continue;
      const subset = perTool[extId];
      for (const rt of extTools) {
        if (subset && subset.length > 0
          && !subset.includes(rt.name) && !subset.includes(rt.originalName)) {
          continue;
        }
        const { extensionId, extensionName, originalName, ...t } = rt;
        tools.push(t);
      }
    }

    return tools;
  }

  /** Get all RegisteredTools for a given extension ID. */
  getToolsForExtension(extensionId: string): RegisteredTool[] {
    return this.extensionTools.get(extensionId) ?? [];
  }

  /** Resolve a lazy release adapter. This does not start an execution worker. */
  getProcessIfRunning(extensionId: string): ExtensionProcess | null {
    const proc = this.processes.get(extensionId);
    if (proc?.isRunning) return proc;
    if ((this.manifests.get(extensionId)?.schemaVersion as number | undefined) !== 4) return null;
    const process = new ReleaseProcess(extensionId);
    process.ensureRunning();
    this.processes.set(extensionId, process);
    return process;
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
  async getProcess(extensionId: string): Promise<ExtensionProcess> {
    const manifest = this.manifests.get(extensionId);
    if (!manifest) throw new Error(`Extension ${extensionId} not found in registry`);
    if ((manifest?.schemaVersion as number | undefined) !== 4) {
      throw new Error("Extension requires migration to an approved v4 release");
    }
    return this.getProcessIfRunning(extensionId)!;
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

  /** Manifest description for an extension, looked up by manifest NAME
   *  (the `/api/tools` listing groups by name, not id). Undefined when
   *  the extension is unknown or has no description. */
  getExtensionDescription(extensionName: string): string | undefined {
    for (const [, manifest] of this.manifests) {
      if (manifest.name === extensionName) return manifest.description || undefined;
    }
    return undefined;
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

  /** Set the registered tools for an extension id (for testing). Populates the
   *  per-extension map that getToolsForAgent / getToolsForExtension read. */
  setExtensionToolsForTest(extId: string, tools: RegisteredTool[]): void {
    this.extensionTools.set(extId, tools);
  }

  /**
   * Everything a live subprocess / MCP connection was built from. Two
   * signatures being equal means the running thing is still serving the
   * current version of the extension; any difference invalidates it.
   *
   * `manifest` carries the entrypoint + package checksums that every
   * install and refresh path stamps (`computeManifestChecksums`), which is
   * what makes a pure CODE edit — no `ezcorp.config.ts` change — visible
   * here.
   */
  private runtimeSignature(extId: string): string {
    return JSON.stringify({
      manifest: this.manifests.get(extId) ?? null,
      installPath: this.installPaths.get(extId) ?? null,
      grantedPermissions: this.grantedPerms.get(extId) ?? null,
      isBundled: this.bundledFlags.get(extId) ?? false,
    });
  }

  /**
   * Retire an invalidated subprocess.
   *
   * The kill is DEFERRED while a host-initiated call is still awaiting its
   * response. `installAuthoredDraft` reloads the registry from inside the
   * `ezcorp/drafts.install` reverse-RPC — i.e. while the host is awaiting
   * the very `install_draft` tool call that triggered it — and that install
   * changes `extension-author`'s own signature (the bundled grant self-heal
   * rewrites `grantedPermissions`). Killing there strands the call and
   * wedges the chat. The caller has already dropped this process from
   * `this.processes`, so the invalidation is complete either way: the next
   * `getProcess` spawns a fresh subprocess against the new code, and this
   * handle dies as soon as its last call settles.
   */
  private retireProcess(extId: string, proc: ExtensionProcess): void {
    // `typeof` guard: test fixtures stub ExtensionProcess with bare
    // `{ isRunning, kill }` objects.
    const busy = typeof proc.inFlightCallCount === "number" && proc.inFlightCallCount > 0;
    if (!busy) {
      proc.kill();
      return;
    }
    log.info("extension subprocess invalidated mid-call — kill deferred until it settles", {
      extensionId: extId,
      inFlightCalls: proc.inFlightCallCount,
    });
    // `whenCallsSettled()` never rejects — a crashed or killed child still
    // settles the counter through `call()`'s finally.
    void proc.whenCallsSettled().then(() => proc.kill());
  }

  /** Re-read DB and rebuild maps. Call after install/uninstall.
   *
   *  A reload can refresh an extension in place while its old subprocess /
   *  MCP connection is still live, so every one of those is compared
   *  against its pre-reload {@link runtimeSignature} and dropped when the
   *  extension was removed OR its runtime inputs moved. Without this an
   *  upgraded extension keeps serving the pre-upgrade code (the
   *  time-now-ui incident) and an upgraded MCP extension keeps a connected
   *  client built from the pre-upgrade transport config.
   */
  async reload(): Promise<void> {
    const priorRuntimeSignatures = new Map<string, string>();
    const trackSignature = (extId: string): void => {
      if (!priorRuntimeSignatures.has(extId)) {
        priorRuntimeSignatures.set(extId, this.runtimeSignature(extId));
      }
    };
    for (const extId of this.processes.keys()) trackSignature(extId);
    for (const extId of this.mcpClients.keys()) trackSignature(extId);

    await this.loadFromDb();

    // After loadFromDb, `this.manifests` reflects the post-reload set.
    const liveIds = new Set(this.manifests.keys());
    const isStale = (extId: string): boolean =>
      !liveIds.has(extId) || priorRuntimeSignatures.get(extId) !== this.runtimeSignature(extId);

    // Drop only removed or runtime-changed extensions. Unchanged ones stay
    // live, so an unrelated install cannot interrupt them.
    for (const [extId, proc] of this.processes) {
      if (!isStale(extId)) continue;
      this.processes.delete(extId);
      this.retireProcess(extId, proc);
    }
    for (const [extId, client] of this.mcpClients) {
      if (!isStale(extId)) continue;
      void client.close().catch(() => {});
      this.mcpClients.delete(extId);
    }
    // A queued `tools/list_changed` refresh for an extension whose client was
    // just closed would reconnect it (`getMcpClient` rebuilds from scratch on
    // a cache miss) and write a catalog for the PRE-reload transport. Dropping
    // the entry is what cancels it — see `drainMcpToolRefreshes`.
    for (const extId of [...this.mcpToolRefreshes.keys()]) {
      if (isStale(extId)) this.mcpToolRefreshes.delete(extId);
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
    // Cancel every queued catalog refresh. Without this a notification that
    // arrived during shutdown outlives it: the drain calls `getMcpClient`,
    // misses the cache we just cleared, and respawns the stdio child of a
    // server we deliberately closed.
    this.mcpToolRefreshes.clear();
  }

  /**
   * Get or create an `McpClient` for an MCP-kind extension.
   * Lazily constructs and connects on first call.
   */
  async getMcpClient(extensionId: string): Promise<McpClient> {
    const manifest = this.manifests.get(extensionId);
    if (manifest?.schemaVersion !== 4 || manifest.kind !== "mcp") throw new Error("MCP requires an approved v4 release");
    const existing = this.mcpClients.get(extensionId);
    if (existing?.isConnected) return existing;
    const client = new ReleaseMcpClient(extensionId, () => this.getProcess(extensionId));
    await client.connect();
    this.mcpClients.set(extensionId, client);
    return client;
  }
  async refreshMcpTools(extensionId: string): Promise<ToolDefinition[]> {
    return (await this.getMcpClient(extensionId)).listTools();
  }
}

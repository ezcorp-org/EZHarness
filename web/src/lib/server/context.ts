import { loadAgents } from "$server/runtime/loader";
import { EventBus } from "$server/runtime/events";
import { AgentExecutor } from "$server/runtime/executor";
import { PipelineExecutor } from "$server/runtime/pipeline-executor";
import { loadYamlPipelines } from "$server/runtime/pipeline-loader";
import { initDb, closeDb } from "$server/db/connection";
import { validateEnv } from "$server/env-validation";
import { loadDbPipelines } from "$server/db/queries/pipelines";
import { startBackups, stopBackups } from "$server/db/backup";
import {
  installShutdownHandlers,
  registerTeardown,
} from "$lib/server/shutdown";
import {
  bootSpawnFlaggedBundledExtensions,
  ensureBundledExtensions,
} from "$server/extensions/bundled";
import { ExtensionRegistry } from "$server/extensions/registry";
import { ToolExecutor } from "$server/extensions/tool-executor";
import { getPermissionEngine } from "$server/extensions/permission-engine";
import { bootstrapBundledCredentials } from "$lib/server/security/bundled-creds";
import { wireOpenAIExtensionCredentials } from "$lib/server/security/openai-extension-creds";
import { ExtensionStateMediator } from "$server/extensions/state-mediator";
import {
  LifecycleHookDispatcher,
  type LifecycleHookName,
} from "$server/extensions/lifecycle-dispatcher";
import { EventSubscriptionDispatcher } from "$server/extensions/event-subscription-dispatcher";
import { getConversationExtensionIds } from "$server/db/queries/conversation-extensions";
import {
  createCommandRegistry,
  type CommandRegistry,
} from "$server/runtime/commands/registry";
import { listUserCommands } from "$server/db/queries/user-commands";
import type { AgentEvents, PipelineDefinition } from "$server/types";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const __dirname = typeof import.meta.dir === "string"
  ? import.meta.dir
  : dirname(fileURLToPath(import.meta.url));

/**
 * Locate `<repoRoot>/src/agents` by walking up from this module's compiled
 * location. The compiled depth differs between the adapter-bun production
 * build (`web/build/server/chunks/` → 4 levels up = repo root) and SvelteKit's
 * `vite preview` output (`web/.svelte-kit/output/server/chunks/` → 5 levels up
 * = repo root). A hardcoded `"../../../../src/agents"` only resolves under one
 * of those layouts; the other yields `web/src/agents` (does not exist) and
 * `loadAgents()`'s `Bun.Glob.scan()` throws ENOENT during top-level-await
 * `ensureInitialized()`, which a TLA-aware ESM evaluator surfaces as a thrown
 * `undefined` to the caller — masking the real cause and crashing `vite
 * preview` with `error when starting preview server: undefined`.
 *
 * Resolver order:
 *   1. `EZCORP_AGENTS_DIR` env override (tests + multi-tenant deploys).
 *   2. Walk up from `__dirname` to the first ancestor containing
 *      `src/agents/` and `web/` — i.e. the repo root.
 *   3. Fall back to the legacy 4-up relative path so unforeseen layouts
 *      still produce a stable string (loaders treat a missing dir as
 *      "no agents"; an exception only happens for the empty-byte-path
 *      pathology we just fixed).
 */
function resolveAgentsDir(): string {
  const override = process.env.EZCORP_AGENTS_DIR;
  if (override) return override;
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(cur, "src/agents")) && existsSync(resolve(cur, "web"))) {
      return resolve(cur, "src/agents");
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return resolve(__dirname, "../../../../src/agents");
}

const agentsDir = resolveAgentsDir();

let executor: AgentExecutor | null = null;
let pipelineExecutor: PipelineExecutor | null = null;
let bus: EventBus<AgentEvents> | null = null;
let stateMediator: ExtensionStateMediator | null = null;
let lifecycleDispatcher: LifecycleHookDispatcher | null = null;
let eventSubscriptionDispatcher: EventSubscriptionDispatcher | null = null;
let commandRegistry: CommandRegistry | null = null;
let pipelines: PipelineDefinition[] = [];
let initialized = false;

export async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  initialized = true;

  validateEnv();
  await initDb();
  // Install signal handlers immediately after the DB opens. The first
  // teardown we register is `closeDb` — and because shutdown runs the
  // list in LIFO order, that means PGlite is always the LAST thing
  // closed, after every dependent (executor, dispatchers, daemons) has
  // already let go of its DB handle. This is the central invariant the
  // 2026-05-10 stale-postmaster.pid incident demanded.
  installShutdownHandlers();
  registerTeardown("pglite-close", async () => {
    await closeDb();
  });
  startBackups();
  registerTeardown("backups", () => {
    stopBackups();
  });
  const registry = ExtensionRegistry.getInstance();
  // Provision internal (loopback-only) credentials for allowlisted bundled
  // extensions BEFORE they install + spawn. The registry injects these at
  // subprocess spawn time; the extension uses them to call back into this
  // same server without ever touching process.env or the DB. See
  // lib/server/security/bundled-creds.ts for the security contract.
  await bootstrapBundledCredentials(registry);
  // Wire a per-spawn resolver so the `openai-image-gen-2` extension gets
  // the user's configured OpenAI credential (BYOK key or OAuth token,
  // refreshed on the fly) injected into its subprocess. No host env var
  // required — it reads whatever the user has already set via admin
  // settings or the OpenAI OAuth sign-in flow.
  wireOpenAIExtensionCredentials(registry);
  await ensureBundledExtensions();
  await registry.loadFromDb();
  const agents = await loadAgents(agentsDir, { includeDb: true });
  bus = new EventBus<AgentEvents>();
  executor = new AgentExecutor(agents, bus, { persist: true });
  pipelineExecutor = new PipelineExecutor(executor, bus);
  // Teardown order matters here: the executor owns the watchdog interval
  // + in-flight tool runs; it must stop BEFORE the dispatchers it can
  // emit events on, and BEFORE the registry that owns its extension
  // subprocesses. Registered LIFO so the call order at shutdown is
  // executor.destroy() → dispatchers.stop() → registry.killAll() →
  // backups → pglite.
  registerTeardown("executor-destroy", () => {
    executor?.destroy();
  });
  registerTeardown("extension-registry-kill-all", () => {
    // killAll() is sync but it fires-and-forgets async client.close() /
    // proxy.stop() calls — we don't await those individually. The MCP
    // proxies and clients run as best-effort cleanup; what matters for
    // the data-loss guarantee is that subprocesses get SIGKILL via
    // proc.kill() (sync) so they release their PGlite handles before
    // our own closeDb() runs.
    registry.killAll();
  });

  // Wire extension state mediator (validates extension UI state updates)
  stateMediator = new ExtensionStateMediator(bus, (extId) => {
    const manifest = registry.getManifest(extId);
    if (!manifest) return undefined;
    return { name: manifest.name, panel: manifest.panel };
  });
  executor.setStateMediator(stateMediator);

  // Wire lifecycle hook dispatcher (sends sanitized events to subscribed extensions)
  lifecycleDispatcher = new LifecycleHookDispatcher(bus, registry);
  for (const [extId, manifest] of registry.getAllManifests()) {
    if (manifest.lifecycleHooks?.length) {
      // manifest.lifecycleHooks is declared as string[] on the manifest
      // type; the dispatcher validates each entry against ALLOWED_LIFECYCLE_HOOKS
      // at registration time, so the structural assertion here is narrower
      // than `any` and preserves runtime behavior.
      lifecycleDispatcher.registerExtension(extId, manifest.lifecycleHooks as LifecycleHookName[]);
    }
  }
  lifecycleDispatcher.start();
  registerTeardown("lifecycle-dispatcher", () => {
    lifecycleDispatcher?.stop();
  });

  // Phase 2c — server→extension bus-event notifications. Mirrors the
  // lifecycle dispatcher's boot shape but reads `eventSubscriptions`
  // from the runtime GRANT (not the manifest) so revoking in the admin
  // UI drops delivery on the next reload. Disabled wholesale when
  // EZCORP_DISABLE_CAPABILITY_TOOLS=1 (gate lives in the dispatcher's
  // start()). Must run AFTER every registerExtension so the event→ext
  // map is complete before bus.on wiring — same ordering requirement
  // as LifecycleHookDispatcher.
  eventSubscriptionDispatcher = new EventSubscriptionDispatcher(
    bus,
    registry,
    getConversationExtensionIds,
  );
  for (const [extId] of registry.getAllManifests()) {
    const granted = registry.getGrantedPermissions(extId);
    const subs = granted?.eventSubscriptions;
    if (Array.isArray(subs) && subs.length > 0) {
      eventSubscriptionDispatcher.registerExtension(extId, subs);
    }
  }
  eventSubscriptionDispatcher.start();
  registerTeardown("event-subscription-dispatcher", () => {
    eventSubscriptionDispatcher?.stop();
  });

  // Phase 53 fix — boot-spawn bundled extensions whose ONLY entrypoint
  // is event subscription. `EventSubscriptionDispatcher.dispatch` calls
  // `registry.getProcessIfRunning(extId)` and silently drops the event
  // when the process isn't already running (it's documented "Never
  // starts a new process"). Event-only bundled extensions
  // (lessons-distiller post-Phase-53.3, memory-extractor since
  // Phase-53.4) therefore need an explicit boot-time spawn — without
  // it, every `run:complete` hand-off goes nowhere. UAT for Phase 53.5
  // caught this; see `bundled.ts:bootSpawnFlaggedBundledExtensions` for
  // the full rationale.
  //
  // Construct a boot-only ToolExecutor solely to expose
  // `ensureSubprocessRpcWired` — the per-turn ToolExecutor instances
  // built in `setup-tools.ts` use the same wiring path, so the
  // subprocess gets identical handlers either way. The boot-only
  // engine deps (`db: {_token: "boot-spawn"}`) match the lazy-cold-
  // start pattern at `web/src/routes/api/ez-actions/[name]/+server.ts`.
  try {
    const bootEngine = getPermissionEngine({
      registry,
      bus,
      db: { _token: "boot-spawn" },
    });
    // Phase 53.7 — `eventDriven: true` switches the runtime-invoke
    // conversation-scope gate from the strict `currentConversationId`
    // match (always fails here — no per-turn conversation context) to a
    // `conversation_extensions` wiring lookup. The dispatcher already
    // consulted that same source to decide which extensions receive the
    // run:complete event, so the read is bounded by the same trust
    // boundary. Per-turn ToolExecutor instances in setup-tools.ts leave
    // the flag false so cross-extension manual calls keep the strict
    // gate.
    const bootExecutor = new ToolExecutor(registry, bootEngine, {
      bus,
      eventDriven: true,
    });
    await bootSpawnFlaggedBundledExtensions(
      registry,
      (extId, proc) => bootExecutor.ensureSubprocessRpcWired(extId, proc),
    );
  } catch (bootSpawnErr) {
    // Boot-spawn failures are individually logged inside the helper.
    // Anything escaping here is a wiring-bootstrap failure (engine /
    // executor construction) — log + continue so the host still boots
    // (event-only extensions are degraded but the rest of the system
    // is functional).
    console.warn(
      "boot-spawn bootstrap failed; event-only bundled extensions degraded",
      bootSpawnErr,
    );
  }

  // Memory extraction runs as a bundled extension as of Phase 53 Stage 2
  // (this commit) — see `extensions/memory-extractor/index.ts`'s
  // `registerEventHandler("run:complete", …)`. The boot-spawn block
  // above ensures the subprocess is alive so the
  // EventSubscriptionDispatcher can hand off `run:complete`. Lessons
  // distillation works the same way (Phase 53.3,
  // `extensions/lessons-distiller/index.ts`). Conversation→extension
  // wiring is auto-populated by `autoWireBundledExtensions` (new convs)
  // and one-time backfills (existing convs:
  // `migrateLessonsDistillerConversationWiring` for distiller +
  // `migrateMemoryExtractorConversationWiring` for memory-extractor).

  // Command registry: bridges filesystem roots + userCommands DB rows.
  // Home-dir scanning is gated via env flag so multi-tenant deploys can
  // opt out (scanning ~/.claude/ under a shared server process would leak
  // command templates across users).
  const scanHome = (process.env.EZCORP_SCAN_GLOBAL_COMMANDS ?? "1") !== "0";
  commandRegistry = createCommandRegistry({
    homePath: homedir(),
    scanHome,
    dbLister: async (userId) => {
      const rows = await listUserCommands(userId);
      return rows.map((r) => ({
        name: r.name,
        description: r.description,
        body: r.body,
        frontmatter: (r.frontmatter ?? {}) as Record<string, string>,
      }));
    },
  });

  // Load pipelines from YAML + DB
  const yamlPipelines = await loadYamlPipelines(agentsDir);
  const dbPipelines = await loadDbPipelines();
  pipelines = [...yamlPipelines, ...dbPipelines];

  // Signal-driven teardown lives in `$lib/server/shutdown.ts`. The
  // adapter (svelte-adapter-bun) emits `sveltekit:shutdown` BEFORE
  // its `await server.stop(true)`, so HTTP connection drain runs in
  // parallel with our teardown chain — and PGlite always closes
  // before the process exits. The pre-2026-05-10 SIGTERM handler
  // (synchronous `stopBackups(); process.exit(0)`) skipped PGlite
  // close entirely, which is the root cause `e304cf8`'s lock-file
  // safety-net papered over and what this commit fixes properly.
}

export function getExecutor(): AgentExecutor {
  if (!executor) throw new Error("Server not initialized — call ensureInitialized() first");
  return executor;
}

export function getPipelineExecutor(): PipelineExecutor {
  if (!pipelineExecutor) throw new Error("Server not initialized — call ensureInitialized() first");
  return pipelineExecutor;
}

export function getBus(): EventBus<AgentEvents> {
  if (!bus) throw new Error("Server not initialized — call ensureInitialized() first");
  return bus;
}

export function getCommandRegistry(): CommandRegistry {
  if (!commandRegistry) {
    throw new Error("Server not initialized — call ensureInitialized() first");
  }
  return commandRegistry;
}

function getStateMediator(): ExtensionStateMediator | null {
  return stateMediator;
}

export function getPipelines(): PipelineDefinition[] {
  return pipelines;
}

export async function reloadPipelines(): Promise<void> {
  const yamlPipelines = await loadYamlPipelines(agentsDir);
  const dbPipelines = await loadDbPipelines();
  pipelines = [...yamlPipelines, ...dbPipelines];
}

function reset(): void {
  // Tear down executor-owned timers + in-flight runs before dropping
  // the reference; otherwise the orphan-cleanup interval keeps the
  // singleton (and its closures) alive for the lifetime of the process.
  if (executor) executor.destroy();
  executor = null;
  pipelineExecutor = null;
  bus = null;
  commandRegistry = null;
  pipelines = [];
  initialized = false;
}

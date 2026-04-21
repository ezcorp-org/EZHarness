import { loadAgents } from "$server/runtime/loader";
import { EventBus } from "$server/runtime/events";
import { AgentExecutor } from "$server/runtime/executor";
import { PipelineExecutor } from "$server/runtime/pipeline-executor";
import { loadYamlPipelines } from "$server/runtime/pipeline-loader";
import { initDb } from "$server/db/connection";
import { loadDbPipelines } from "$server/db/queries/pipelines";
import { startBackups, stopBackups } from "$server/db/backup";
import { ensureBundledExtensions } from "$server/extensions/bundled";
import { ExtensionRegistry } from "$server/extensions/registry";
import { bootstrapBundledCredentials } from "$lib/server/security/bundled-creds";
import { ExtensionStateMediator } from "$server/extensions/state-mediator";
import { LifecycleHookDispatcher } from "$server/extensions/lifecycle-dispatcher";
import { EventSubscriptionDispatcher } from "$server/extensions/event-subscription-dispatcher";
import { getConversationExtensionIds } from "$server/db/queries/conversation-extensions";
import { registerExtractionListener } from "$server/memory/extraction";
import {
  createCommandRegistry,
  type CommandRegistry,
} from "$server/runtime/commands/registry";
import { listUserCommands } from "$server/db/queries/user-commands";
import type { AgentEvents, PipelineDefinition } from "$server/types";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = typeof import.meta.dir === "string"
  ? import.meta.dir
  : dirname(fileURLToPath(import.meta.url));
const agentsDir = resolve(__dirname, "../../../../src/agents");

let executor: AgentExecutor | null = null;
let pipelineExecutor: PipelineExecutor | null = null;
let bus: EventBus<AgentEvents> | null = null;
let stateMediator: ExtensionStateMediator | null = null;
let lifecycleDispatcher: LifecycleHookDispatcher | null = null;
let eventSubscriptionDispatcher: EventSubscriptionDispatcher | null = null;
let commandRegistry: CommandRegistry | null = null;
let pipelines: PipelineDefinition[] = [];
let extractionUnsub: (() => void) | null = null;
let initialized = false;

export async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await initDb();
  startBackups();
  const registry = ExtensionRegistry.getInstance();
  // Provision internal (loopback-only) credentials for allowlisted bundled
  // extensions BEFORE they install + spawn. The registry injects these at
  // subprocess spawn time; the extension uses them to call back into this
  // same server without ever touching process.env or the DB. See
  // lib/server/security/bundled-creds.ts for the security contract.
  await bootstrapBundledCredentials(registry);
  await ensureBundledExtensions();
  await registry.loadFromDb();
  const agents = await loadAgents(agentsDir, { includeDb: true });
  bus = new EventBus<AgentEvents>();
  executor = new AgentExecutor(agents, bus, { persist: true });
  pipelineExecutor = new PipelineExecutor(executor, bus);

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
      lifecycleDispatcher.registerExtension(extId, manifest.lifecycleHooks as any);
    }
  }
  lifecycleDispatcher.start();

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

  // Register memory extraction listener (fire-and-forget on run:complete)
  extractionUnsub = registerExtractionListener(bus);

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

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      stopBackups();
      process.exit(0);
    });
  }
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

export function getStateMediator(): ExtensionStateMediator | null {
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

export function reset(): void {
  if (extractionUnsub) extractionUnsub();
  extractionUnsub = null;
  executor = null;
  pipelineExecutor = null;
  bus = null;
  commandRegistry = null;
  pipelines = [];
  initialized = false;
}

/**
 * Wiring test for ensureInitialized() → registerPreviewBus (context.ts:135),
 * Secure User-Site Preview / Port Exposure, Phase 3a — audit gap #3.
 *
 * The preview port-watcher in the backend
 * (src/startup/background-timers.ts) pushes the requester-scoped consent
 * card onto the LIVE conversation SSE bus via the bus REGISTRY — the
 * backend can't import the web bus directly (import direction), so the web
 * layer must register `getBus()` at init. Nothing asserted that this wiring
 * actually fires with a non-null bus; a refactor dropping the
 * `registerPreviewBus(bus)` line would silently break every live preview
 * push (it would degrade to the fail-safe "no bus registered" no-op).
 *
 * Strategy: `ensureInitialized()` touches the whole boot graph (DB,
 * extensions, agents, daemons), so every heavy dependency is mocked to an
 * inert stub. The ONE collaborator we observe is `registerPreviewBus` — we
 * assert it was called exactly once with a non-null bus, and that the same
 * bus is what `getBus()` returns (proving the registered handle is the live
 * conversation bus, not a throwaway). The real `EventBus` is left unmocked
 * so the assertion exercises a genuine bus instance.
 */

import { test, expect, describe, vi } from "vitest";

// The one collaborator under observation.
const registerPreviewBus = vi.fn();
const reloadFixture = vi.hoisted(() => ({
  listeners: [] as Array<() => void | Promise<void>>,
  teardowns: new Map<string, () => void | Promise<void>>(),
  events: vi.fn(),
  lifecycle: vi.fn(),
  workflows: vi.fn(async () => []),
}));
const bootWiring = vi.hoisted(() => ({
  githubEmitter: null as unknown,
  workflowRuntime: null as unknown,
  commandOptions: null as unknown,
}));
const degradedBoot = vi.hoisted(() => ({
  lifecycle: new Error("lifecycle unavailable"),
  bundled: new Error("bundled staging unavailable"),
  briefing: new Error("briefing configuration unavailable"),
  terminalize: new Error("workflow sweep unavailable"),
  recovery: new Error("runner recovery unavailable"),
  bootSpawn: new Error("boot spawn unavailable"),
  goal: new Error("goal start unavailable"),
}));
vi.mock("$server/runtime/preview/preview-bus-registry", () => ({
  registerPreviewBus: (...a: unknown[]) => registerPreviewBus(...a),
  getRegisteredPreviewBus: () => null,
}));
vi.mock("$server/integrations/github-projects/bus-registry", () => ({
  registerGithubProjectsEmit: vi.fn((emit: unknown) => { bootWiring.githubEmitter = emit; }),
}));
vi.mock("$server/runtime/workflow/runtime-registry", () => ({
  registerWorkflowRuntime: vi.fn((runtime: unknown) => { bootWiring.workflowRuntime = runtime; }),
}));

// ── Inert stubs for the rest of the boot graph ──────────────────────

vi.mock("$server/env-validation", () => ({ validateEnv: vi.fn() }));
vi.mock("$server/db/connection", () => ({
  initDb: vi.fn(async () => undefined),
  closeDb: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/shutdown", () => ({
  installShutdownHandlers: vi.fn(),
  registerTeardown: vi.fn((name: string, callback: () => void | Promise<void>) => {
    reloadFixture.teardowns.set(name, callback);
  }),
}));
vi.mock("$server/db/backup", () => ({
  startBackups: vi.fn(),
  stopBackups: vi.fn(),
}));
vi.mock("$server/extensions/bundled", () => ({
  ensureBundledExtensions: vi.fn(async () => { throw degradedBoot.bundled; }),
  bootSpawnFlaggedBundledExtensions: vi.fn(async () => undefined),
}));
vi.mock("$server/extensions/extension-lifecycle-service", () => ({
  reconcileExtensionLifecycle: vi.fn(async () => { throw degradedBoot.lifecycle; }),
  recoverExtensionLifecycle: vi.fn(async () => { throw degradedBoot.recovery; }),
}));
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      loadFromDb: vi.fn(async () => undefined),
      getManifest: () => undefined,
      getAllManifests: () => new Map(),
      getGrantedPermissions: () => undefined,
      getProcessIfRunning: () => undefined,
      killAll: vi.fn(),
      onReload: (listener: () => void | Promise<void>) => { reloadFixture.listeners.push(listener); return vi.fn(); },
    }),
  },
}));
vi.mock("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    constructor() { throw degradedBoot.bootSpawn; }
  },
}));
vi.mock("$server/extensions/permission-engine", () => ({
  getPermissionEngine: vi.fn(() => ({})),
}));
vi.mock("$lib/server/security/bundled-creds", () => ({
  bootstrapBundledCredentials: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/security/openai-extension-creds", () => ({
  wireOpenAIExtensionCredentials: vi.fn(),
}));
vi.mock("$server/extensions/state-mediator", () => ({
  ExtensionStateMediator: class {},
  // ensureInitialized registers the mediator as the process-wide
  // singleton (dashboard live-refresh fix); the export must exist or the
  // boot under test throws.
  setStateMediator: vi.fn(),
}));
vi.mock("$server/extensions/lifecycle-dispatcher", () => ({
  LifecycleHookDispatcher: class {
    registerExtension = vi.fn();
    reconcileFromRegistry = reloadFixture.lifecycle;
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock("$server/extensions/event-subscription-dispatcher", () => ({
  EventSubscriptionDispatcher: class {
    registerExtension = vi.fn();
    reconcileFromRegistry = reloadFixture.events;
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock("$server/db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: vi.fn(async () => []),
}));
vi.mock("$server/runtime/commands/registry", () => ({
  createCommandRegistry: vi.fn((options: unknown) => {
    bootWiring.commandOptions = options;
    return {};
  }),
}));
vi.mock("$server/db/queries/user-commands", () => ({
  listUserCommands: vi.fn(async () => [{
    name: "review",
    description: "Review a change",
    body: "git diff",
    frontmatter: null,
  }]),
}));
vi.mock("$server/runtime/goal-host", () => ({
  initGoalHost: vi.fn(() => ({ start: vi.fn(async () => { throw degradedBoot.goal; }), stop: vi.fn() })),
  parseGoalEnabled: vi.fn(() => false),
}));
vi.mock("$server/runtime/briefing/agent-config", () => ({
  ensureBriefingAgentConfig: vi.fn(async () => { throw degradedBoot.briefing; }),
}));
vi.mock("$server/providers/kilo", () => ({ warmKiloCatalog: vi.fn(async () => "failed") }));
vi.mock("$server/db/queries/workflow-runs", () => ({
  terminalizeOrphanedWorkflowRuns: vi.fn(async () => { throw degradedBoot.terminalize; }),
}));
vi.mock("$server/runtime/loader", () => ({
  loadAgents: vi.fn(async () => []),
}));
vi.mock("$server/runtime/workflow-loader", () => ({
  loadYamlWorkflows: vi.fn(async () => [{ name: "yaml-check", description: "fixture", steps: [] }]),
}));
vi.mock("$server/runtime/workflow-release-assets", () => ({ loadReleaseWorkflowEntries: reloadFixture.workflows }));
vi.mock("$server/db/queries/workflows", () => ({
  loadDbCachedWorkflows: vi.fn(async () => []),
}));
vi.mock("$server/runtime/executor", () => ({
  AgentExecutor: class {
    listAgents() { return []; }
    setStateMediator = vi.fn();
    destroy = vi.fn();
  },
}));
vi.mock("$server/runtime/workflow-executor", () => ({
  WorkflowExecutor: class {},
}));
// NB: $server/runtime/events (EventBus) is deliberately NOT mocked — we
// want a real bus instance so the non-null assertion is meaningful.

// Imported at module scope, NOT with `await import()` inside the test.
// `context.ts` statically pulls the entire server boot graph, so loading it is
// the single most expensive thing this file does — and it is FIXTURE cost, not
// behaviour under test. Inside the test body it was billed to vitest's 5000ms
// per-test budget: 0.51s when this file runs alone, but 4.45s inside the
// 169-file coverage leg, where the fork pool saturates the CPU (v8
// instrumentation itself costs ~8%; the 8x is contention). At 89% of budget it
// timed out on any loaded machine. At module scope the cost lands in the
// collection phase, which carries no per-test timeout, leaving the 5s budget to
// cover what it is meant to cover: ensureInitialized() plus the assertions.
// vi.mock() is hoisted above imports, so every stub above is already installed
// when this evaluates.
import * as ctx from "$lib/server/context";

// The former beforeEach (vi.clearAllMocks + vi.resetModules) is gone with the
// dynamic import: a module-scope binding cannot be re-resolved by
// resetModules(), and clearAllMocks() before the only test that populates the
// spy was a no-op. ensureInitialized() is a once-only singleton, so this file
// deliberately holds exactly ONE test — a second one would observe
// `initialized === true` and see no fresh wiring. Add further cases as their
// own file (see context-state-mediator-wiring.server.test.ts), not here.
describe("ensureInitialized — registers the live preview bus (gap #3)", () => {
  test("keeps core boot live while optional extension, workflow, briefing, goal, and boot-spawn work degrades", async () => {
    // The public server boundary fails closed before boot; only goal state is
    // intentionally nullable so messages can render its disabled card.
    expect(() => ctx.getExecutor()).toThrow("Server not initialized");
    expect(() => ctx.getWorkflowExecutor()).toThrow("Server not initialized");
    expect(() => ctx.getBus()).toThrow("Server not initialized");
    expect(() => ctx.getCommandRegistry()).toThrow("Server not initialized");
    expect(ctx.getGoalHost()).toBeNull();
    expect(ctx.getWorkflows()).toEqual([]);
    expect(ctx.getCachedWorkflows()).toEqual([]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await ctx.ensureInitialized();
    // Flush the two explicitly fire-and-forget recovery paths.
    await Promise.resolve();
    await Promise.resolve();

    // Wiring fired exactly once.
    expect(registerPreviewBus).toHaveBeenCalledTimes(1);
    const registeredBus = registerPreviewBus.mock.calls[0]![0];
    // The registered bus is a real, non-null object.
    expect(registeredBus).toBeTruthy();
    expect(typeof registeredBus).toBe("object");
    // And it is the SAME instance the rest of the app reaches via getBus()
    // — i.e. the live conversation SSE bus, not a throwaway.
    expect(registeredBus).toBe(ctx.getBus());
    expect(ctx.getWorkflowExecutor()).toBeTruthy();
    expect(ctx.getCommandRegistry()).toEqual({});
    expect(reloadFixture.events).toHaveBeenCalledTimes(1);
    expect(reloadFixture.lifecycle).toHaveBeenCalledTimes(1);
    expect(reloadFixture.workflows).toHaveBeenCalledTimes(1);
    expect(reloadFixture.listeners).toHaveLength(2);
    for (const listener of reloadFixture.listeners) await listener();
    expect(reloadFixture.events).toHaveBeenCalledTimes(2);
    expect(reloadFixture.lifecycle).toHaveBeenCalledTimes(2);
    expect(reloadFixture.workflows).toHaveBeenCalledTimes(2);
    await ctx.reloadWorkflows();

    const workflowRuntime = bootWiring.workflowRuntime as { listAgents: () => unknown[] };
    expect(workflowRuntime.listAgents()).toEqual([]);
    const githubEmitter = bootWiring.githubEmitter as (event: never, payload: never) => void;
    expect(() => githubEmitter("briefing:updated" as never, {} as never)).not.toThrow();
    const commandOptions = bootWiring.commandOptions as {
      dbLister: (userId: string) => Promise<Array<{ name: string; frontmatter: Record<string, string> }>>;
    };
    await expect(commandOptions.dbLister("user-1")).resolves.toEqual([
      { name: "review", description: "Review a change", body: "git diff", frontmatter: {} },
    ]);

    // Execute representative shutdown callbacks. This verifies the closures
    // operate on the booted singletons, rather than only being registered.
    for (const name of ["pglite-close", "backups", "executor-destroy", "extension-registry-kill-all", "lifecycle-dispatcher", "event-subscription-dispatcher", "goal-host"] as const) {
      const teardown = reloadFixture.teardowns.get(name);
      expect(teardown).toBeDefined();
      await teardown!();
    }

    // Optional capability failure must be visible, but never turn into a
    // server boot failure. Each controlled collaborator has its own signal;
    // deleting one catch/failure boundary makes this assertion fail.
    expect(warn).toHaveBeenCalledWith(
      "briefing agent bootstrap failed; daily briefing degraded",
      degradedBoot.briefing,
    );
    expect(warn).toHaveBeenCalledWith(
      "boot-spawn bootstrap failed; event-only bundled extensions degraded",
      degradedBoot.bootSpawn,
    );
    expect(warn).toHaveBeenCalledWith(
      "goal-host start failed; goal feature degraded",
      degradedBoot.goal,
    );
    expect(warn).toHaveBeenCalledWith("[kilo] catalog warm failed — free models limited to the built-in seed");
    expect(error).toHaveBeenCalledWith(
      "Extension runner recovery unavailable; extension execution remains disabled",
      { error: String(degradedBoot.lifecycle) },
    );
    expect(error).toHaveBeenCalledWith(
      "Extension runner recovery unavailable; extension execution remains disabled",
      { error: String(degradedBoot.recovery) },
    );
    expect(error).toHaveBeenCalledWith(
      "Bundled source staging unavailable; configure the runner and retry",
      { error: String(degradedBoot.bundled) },
    );
    expect(error).toHaveBeenCalledWith(
      "[workflow] terminalizeOrphanedWorkflowRuns on startup failed",
      degradedBoot.terminalize,
    );
    warn.mockRestore();
    error.mockRestore();
  });
});

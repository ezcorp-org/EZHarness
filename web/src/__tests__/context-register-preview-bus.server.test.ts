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

import { test, expect, describe, vi, beforeEach } from "vitest";

// The one collaborator under observation.
const registerPreviewBus = vi.fn();
vi.mock("$server/runtime/preview/preview-bus-registry", () => ({
  registerPreviewBus: (...a: unknown[]) => registerPreviewBus(...a),
  getRegisteredPreviewBus: () => null,
}));

// ── Inert stubs for the rest of the boot graph ──────────────────────

vi.mock("$server/env-validation", () => ({ validateEnv: vi.fn() }));
vi.mock("$server/db/connection", () => ({
  initDb: vi.fn(async () => undefined),
  closeDb: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/shutdown", () => ({
  installShutdownHandlers: vi.fn(),
  registerTeardown: vi.fn(),
}));
vi.mock("$server/db/backup", () => ({
  startBackups: vi.fn(),
  stopBackups: vi.fn(),
}));
vi.mock("$server/extensions/bundled", () => ({
  ensureBundledExtensions: vi.fn(async () => undefined),
  bootSpawnFlaggedBundledExtensions: vi.fn(async () => undefined),
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
    }),
  },
}));
vi.mock("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    ensureSubprocessRpcWired = vi.fn();
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
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock("$server/extensions/event-subscription-dispatcher", () => ({
  EventSubscriptionDispatcher: class {
    registerExtension = vi.fn();
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock("$server/db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: vi.fn(async () => []),
}));
vi.mock("$server/runtime/commands/registry", () => ({
  createCommandRegistry: vi.fn(() => ({})),
}));
vi.mock("$server/db/queries/user-commands", () => ({
  listUserCommands: vi.fn(async () => []),
}));
vi.mock("$server/runtime/goal-host", () => ({
  initGoalHost: vi.fn(() => ({ start: vi.fn(async () => undefined), stop: vi.fn() })),
  parseGoalEnabled: vi.fn(() => false),
}));
vi.mock("$server/runtime/loader", () => ({
  loadAgents: vi.fn(async () => []),
}));
vi.mock("$server/runtime/workflow-loader", () => ({
  loadYamlWorkflows: vi.fn(async () => []),
}));
vi.mock("$server/db/queries/workflows", () => ({
  loadDbWorkflows: vi.fn(async () => []),
}));
vi.mock("$server/runtime/executor", () => ({
  AgentExecutor: class {
    setStateMediator = vi.fn();
    destroy = vi.fn();
  },
}));
vi.mock("$server/runtime/workflow-executor", () => ({
  WorkflowExecutor: class {},
}));
// NB: $server/runtime/events (EventBus) is deliberately NOT mocked — we
// want a real bus instance so the non-null assertion is meaningful.

describe("ensureInitialized — registers the live preview bus (gap #3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ensureInitialized is a once-only singleton guarded by an internal
    // `initialized` flag; reset the module between tests so it re-runs.
    vi.resetModules();
  });

  test("calls registerPreviewBus exactly once with a non-null bus === getBus()", async () => {
    const ctx = await import("$lib/server/context");
    await ctx.ensureInitialized();

    // Wiring fired exactly once.
    expect(registerPreviewBus).toHaveBeenCalledTimes(1);
    const registeredBus = registerPreviewBus.mock.calls[0]![0];
    // The registered bus is a real, non-null object.
    expect(registeredBus).toBeTruthy();
    expect(typeof registeredBus).toBe("object");
    // And it is the SAME instance the rest of the app reaches via getBus()
    // — i.e. the live conversation SSE bus, not a throwaway.
    expect(registeredBus).toBe(ctx.getBus());
  });
});

/**
 * Boundary 3 (`forceDenyOrchestration`) against the REAL per-turn tool
 * surface.
 *
 * WHY THIS SUITE REFUSES TO USE BARE FIXTURE NAMES. The defect this layer
 * exists to prevent is a NAMING one: `forceDeniedTools` is exact-match, and
 * every spawn primitive except the orchestration trio runs NAMESPACED
 * (`ExtensionRegistry.loadFromDb` stamps `<manifest.name>__<tool>` at
 * registry.ts:459). A suite that asserts `applyToolFilters` removes a
 * hand-typed `"task_add"` passes against a filter that would let
 * `task-tracking__task_add` straight through — it green-lights the exact bug.
 *
 * So the surface here is BUILT, not written down:
 *
 *   • the three extension rows carry their REAL `ezcorp.config.ts` manifests,
 *     imported from the tree, so the tool names are the shipped ones;
 *   • `ExtensionRegistry.loadFromDb()` does the namespacing;
 *   • `ensureTaskTrackingWired()` — the real one, not a mock — is what puts
 *     task-tracking on the conversation, exactly as every turn does;
 *   • the turn runs through `streamChat`, and the assertions read the array
 *     pi-agent-core is actually handed.
 *
 * The only strings this file spells out are the ones being asserted about,
 * and each is checked to be PRESENT without the policy before it is checked
 * to be ABSENT with it — a name that never existed cannot prove a filter
 * works.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mockDbConnection();

// ── Capture what pi-agent-core's Agent receives ──────────────────────
let capturedAgentOpts: { initialState: { tools: Array<{ name: string }> } } | null = null;

mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: undefined };
    constructor(opts: { initialState: { tools: Array<{ name: string }> } }) {
      capturedAgentOpts = opts;
    }
    prompt = mock(async () => {});
    subscribe = mock((fn: (e: { type: string; messages: unknown[] }) => void) => {
      queueMicrotask(() => fn({ type: "agent_end", messages: [] }));
      return () => {};
    });
  },
}));

// ── Provider / observability mocks (nothing tool-surface related) ────
mock.module("../providers/router", () => ({
  resolveModel: mock(async () => ({
    provider: "anthropic",
    model: "claude-sonnet-4",
    piModel: { provider: "anthropic", id: "claude-sonnet-4" },
  })),
  ProviderUnavailableError: class extends Error {
    failedProvider = "";
    failedModel = "";
    suggestion = "";
  },
}));
mock.module("../providers/registry", () => ({ resolveOAuthModel: mock(() => null) }));
mock.module("../providers/credentials", () => ({
  getCredential: mock(async () => ({ type: "apikey", token: "test-key" })),
}));
mock.module("../providers/shell", () => ({
  createShellProvider: () => ({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
}));
mock.module("../providers/file", () => ({
  createFileProvider: () => ({
    read: async () => "",
    write: async () => {},
    exists: async () => false,
  }),
}));
mock.module("../observability/collector", () => ({ startCollector: () => {} }));
mock.module("../db/queries/runs", () => ({ insertRun: async () => {}, updateRun: async () => {} }));
mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => {},
  deleteActiveRun: async () => {},
  cleanupOrphanedRuns: async () => {},
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
}));
mock.module("../memory/embeddings", () => ({
  generateEmbedding: async () => new Float32Array(384),
}));
mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async (sys: string | undefined) => ({
    systemPrompt: sys ?? "",
    memoriesUsed: [],
  }),
}));

// NOTE what is DELIBERATELY NOT mocked: `../runtime/task-tracking-host`,
// `../extensions/registry`, `../extensions/tool-executor`. Those three are
// the namespacing path, and stubbing any of them is what turns this suite
// back into a bare-name fixture.

// ── Import after the mocks ───────────────────────────────────────────
const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { ExtensionRegistry } = await import("../extensions/registry");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { createUser } = await import("../db/queries/users");
const { createAgentConfig } = await import("../db/queries/agent-configs");
const { mergeConversationMetadata } = await import("../db/queries/conversation-metadata");
const { extensions, conversationExtensions } = await import("../db/schema");
const { buildFullGrantFromManifest } = await import("../extensions/install-grant");
const { POLICY_LEAF_SPAWN_DENY } = await import("../runtime/tools/filter");

// The SHIPPED manifests. Imported rather than transcribed, so a tool renamed
// in the tree is a renamed tool here too.
const taskTrackingManifest = (
  await import("../../docs/extensions/examples/task-tracking/ezcorp.config")
).default;
const ezCodeManifest = (await import("../../docs/extensions/examples/ez-code/ezcorp.config"))
  .default;
const orchestrationManifest = (
  await import("../../docs/extensions/examples/orchestration/ezcorp.config")
).default;

type AgentEvents = import("../types").AgentEvents;

const OPEN_APP = {
  name: "open_app",
  description: "Open a native application",
  parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
};

let projectId: string;
let userId: string;

/** @mentioned in every turn, so the orchestration trio wires. */
const MENTIONED_AGENT = "policydeputy";

type InstalledManifest = import("../extensions/types").ExtensionManifestV2;

async function installExtension(manifest: InstalledManifest): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(extensions)
    .values({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? "",
      manifest,
      source: "local",
      enabled: true,
      installPath: `/tmp/ext-${manifest.name}`,
      // The product's own manifest→grant converter, not a hand-built blob:
      // it clamps to the manifest ceiling and stamps `grantedAt` exactly as a
      // real "grant all" local install does. So the fixture carries the
      // `spawnAgents` grant that makes these three the spawn surface, in the
      // shape the host actually writes.
      grantedPermissions: buildFullGrantFromManifest(manifest),
    })
    .returning();
  if (!row) throw new Error(`failed to install ${manifest.name}`);
  return row.id;
}

let ezCodeExtId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Policy Deny", path: "/tmp/policy-deny" });
  projectId = project.id;
  const user = await createUser({
    email: `policy-deny-${Date.now()}@x`,
    name: "Policy Owner",
    passwordHash: "x",
  });
  userId = user.id;

  // The orchestration trio wires only for a turn that @mentions an agent
  // (setup-tools §2d gates on `allAvailableAgents.length > 0`), so the turn
  // below carries a real mention and this is the agent it resolves to.
  await createAgentConfig({
    name: MENTIONED_AGENT,
    description: "A sub-agent to delegate to",
    prompt: "You do the thing.",
    model: "claude-sonnet-4",
    provider: "anthropic",
    userId,
  });

  await installExtension(taskTrackingManifest);
  ezCodeExtId = await installExtension(ezCodeManifest);
  await installExtension(orchestrationManifest);
  // The registry is the thing that namespaces. Load AFTER the rows exist.
  await ExtensionRegistry.getInstance().loadFromDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(() => {
  capturedAgentOpts = null;
});

/**
 * A conversation with caller tools declared and ez-code wired.
 *
 * ez-code is attached by inserting the `conversation_extensions` row —
 * the same state `![ext:ez-code]` mention-wiring produces, reached without
 * driving the mention parser (which is a different subsystem's test).
 * task-tracking is NOT wired here: the executor's own
 * `ensureTaskTrackingWired` does that on every turn, which is the property
 * that makes the namespaced task tools a REAL per-turn surface.
 */
async function policyConversation(): Promise<string> {
  const conv = await createConversation(projectId, { userId });
  await mergeConversationMetadata(conv.id, { callerTools: [OPEN_APP] });
  await getTestDb()
    .insert(conversationExtensions)
    .values({ conversationId: conv.id, extensionId: ezCodeExtId })
    .onConflictDoNothing();
  return conv.id;
}

async function toolNames(
  convId: string,
  policy: { forceDenyOrchestration?: boolean; callerToolAllowlist?: string[] } = {},
): Promise<string[]> {
  const executor = new AgentExecutor(new Map(), new EventBus<AgentEvents>(), { persist: false });
  // The STRUCTURED mention form — `![agent:name]`, not `@name`. `@` is the
  // path popover's sigil (`mention-logic.ts:230`), so a bare `@name` resolves
  // to no agent and the orchestration trio silently never wires.
  await executor.streamChat(
    convId,
    `![agent:${MENTIONED_AGENT}] plan this out and delegate it`,
    { projectId, ...policy },
  );
  if (!capturedAgentOpts) throw new Error("the mock Agent was never constructed");
  return capturedAgentOpts.initialState.tools.map((t) => t.name);
}

/** Names asserted on. Every one is proved PRESENT unpolicied before it is
 *  asserted ABSENT under the policy. */
const NAMESPACED_SPAWN_TOOLS = [
  "task-tracking__task_assign",
  "task-tracking__task_add",
  "task-tracking__task_resume",
  "task-tracking__task_plan",
  "ez-code__dispatch_run",
  "ez-code__steer_run",
  "ez-code__cancel_run",
] as const;

const BARE_SPAWN_TOOLS = [
  "invoke_agent",
  "send_to_agent",
  "collect_agent_result",
  "run_workflow",
] as const;

describe("the unpolicied surface really carries the spawn primitives", () => {
  test("namespaced task-tracking + ez-code tools are wired for an ordinary turn", async () => {
    const names = await toolNames(await policyConversation());
    // If this fails, every "removed" assertion below is vacuous — so it is
    // asserted first, and it is asserted on the NAMESPACED form, which is
    // the whole point of driving the real registry.
    for (const name of NAMESPACED_SPAWN_TOOLS) {
      expect({ name, wired: names.includes(name) }).toEqual({ name, wired: true });
    }
    for (const name of BARE_SPAWN_TOOLS) {
      expect({ name, wired: names.includes(name) }).toEqual({ name, wired: true });
    }
    expect(names).toContain("_caller__open_app");
  });

  test("no policy ⇒ the filter is untouched (back-compat)", async () => {
    // Both options default undefined. A cookie session and an unpolicied key
    // take this path, and it must be the pre-policy surface exactly.
    const names = await toolNames(await policyConversation());
    expect(names).toContain("task-tracking__task_assign");
    expect(names).toContain("ez-code__dispatch_run");
    expect(names).toContain("_caller__open_app");
    expect(names).toContain("shell");
  });
});

describe("forceDenyOrchestration strips the spawn surface", () => {
  test("every namespaced spawn tool is removed — the exact-match bug", async () => {
    const names = await toolNames(await policyConversation(), {
      forceDenyOrchestration: true,
    });
    for (const name of NAMESPACED_SPAWN_TOOLS) {
      expect({ name, wired: names.includes(name) }).toEqual({ name, wired: false });
    }
  });

  test("the bare orchestration + workflow tools are removed too", async () => {
    const names = await toolNames(await policyConversation(), {
      forceDenyOrchestration: true,
    });
    for (const name of BARE_SPAWN_TOOLS) {
      expect({ name, wired: names.includes(name) }).toEqual({ name, wired: false });
    }
  });

  test("the caller's own declared tool SURVIVES", async () => {
    // `_caller__open_app` strips to `open_app`, which is not in the deny set.
    // This is the composition the layer is designed for: the policy denies
    // spawning, not the key's own tools.
    const names = await toolNames(await policyConversation(), {
      forceDenyOrchestration: true,
    });
    expect(names).toContain("_caller__open_app");
  });

  test("the deliberately-KEPT task tools survive", async () => {
    const names = await toolNames(await policyConversation(), {
      forceDenyOrchestration: true,
    });
    // A leaf key keeps solo bookkeeping. `task_complete` can still cancel the
    // owner's in-flight runs via terminateRunningAssignments — an owner-DoS
    // the route allowlist covers, not a spawn escalation.
    expect(names).toContain("task-tracking__task_start");
    expect(names).toContain("task-tracking__task_complete");
    expect(names).toContain("task-tracking__task_list");
    // And the ordinary project tools are untouched — this layer is targeted.
    expect(names).toContain("shell");
    expect(names).toContain("readFile");
  });

  test("nothing outside POLICY_LEAF_SPAWN_DENY was removed", async () => {
    const convId = await policyConversation();
    const before = await toolNames(convId);
    const after = await toolNames(convId, { forceDenyOrchestration: true });
    const removed = before.filter((n) => !after.includes(n)).sort();
    const { stripToolNamespace } = await import("../runtime/tools/filter");
    const unexpected = removed.filter((n) => !POLICY_LEAF_SPAWN_DENY.has(stripToolNamespace(n)));
    // Over-removal is as much a defect as under-removal: it would silently
    // break a policied key's ordinary work and get the layer switched off.
    expect(unexpected).toEqual([]);
    expect(removed.length).toBeGreaterThan(0);
  });
});

describe("callerToolAllowlist caps what is wired", () => {
  test("a name outside the allowlist is not wired at all", async () => {
    const names = await toolNames(await policyConversation(), {
      callerToolAllowlist: ["something_else"],
    });
    expect(names).not.toContain("_caller__open_app");
  });

  test("a name inside the allowlist is wired", async () => {
    const names = await toolNames(await policyConversation(), {
      callerToolAllowlist: ["open_app"],
    });
    expect(names).toContain("_caller__open_app");
  });

  test("an EMPTY allowlist means none, not all", async () => {
    // The falsy-vs-nullish trap: `if (allowlist?.length)` would read `[]` as
    // "no constraint" and hand the key every declared tool — inverting the
    // policy at exactly the value an operator uses to lock a key down hardest.
    const names = await toolNames(await policyConversation(), { callerToolAllowlist: [] });
    expect(names.some((n) => n.startsWith("_caller__"))).toBe(false);
  });

  test("both layers compose", async () => {
    const names = await toolNames(await policyConversation(), {
      forceDenyOrchestration: true,
      callerToolAllowlist: ["open_app"],
    });
    expect(names).toContain("_caller__open_app");
    expect(names).not.toContain("ez-code__dispatch_run");
    expect(names).not.toContain("task-tracking__task_assign");
  });
});

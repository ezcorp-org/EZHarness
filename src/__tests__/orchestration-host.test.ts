/**
 * Unit tests for src/runtime/orchestration-host.ts (Phase 4 commit-4a).
 *
 * Two surfaces:
 *   1. `ensureOrchestrationWired` — happy-path insert, idempotent
 *      re-call, and concurrent first-use race (UNIQUE-constraint
 *      swallow). Real PGlite — mirrors task-tracking-host.test.ts.
 *   2. `wireOrchestrationToolsForTurn` — per-turn tool wiring. The
 *      DB-facing calls (`getExtensionByName` for the ext-id) are
 *      stubbed out, and the 6-arg `extensionToAgentTool` call is
 *      intercepted via a module mock so we can assert the exact args
 *      passed through (schema-override enum contents, invocationMetadata
 *      shape, messageId == runId, etc.).
 */

import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
  spyOn,
} from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// ── Module mocks ───────────────────────────────────────────────────

// Real PGlite behind getDb so the `ensureOrchestrationWired` insert
// lands in a real drizzle-backed conversation_extensions table.
mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

// Intercept the 6-arg extensionToAgentTool so we can inspect its args
// without exercising the real ToolExecutor → subprocess path. The
// ToolExecutor class is still exported for the host module's `new
// ToolExecutor(...)` call site; we simply swap the function.
interface CapturedExtToolCall {
  extTool: { name: string; description: string; inputSchema: Record<string, unknown> };
  toolExecutor: unknown;
  conversationId: string;
  messageId: string;
  schemaOverride?: Record<string, unknown>;
  invocationMetadata?: Record<string, unknown>;
}
const captured: CapturedExtToolCall[] = [];

class StubToolExecutor {
  public seenStateMediator?: unknown;
  public seenExecutor?: unknown;
  public seenSpawnQuota?: unknown;
  public seenUserId?: string;
  public seenModel?: string | null | undefined;
  public seenProvider?: string | null | undefined;
  constructor(public readonly registry: unknown) {}
  setStateMediator(m: unknown) { this.seenStateMediator = m; }
  setExecutor(e: unknown) { this.seenExecutor = e; }
  setSpawnQuota(q: unknown) { this.seenSpawnQuota = q; }
  setCurrentUserId(u: string) { this.seenUserId = u; }
  setCurrentModel(m: string | null | undefined) { this.seenModel = m; }
  setCurrentProvider(p: string | null | undefined) { this.seenProvider = p; }
}

mock.module("../extensions/tool-executor", () => ({
  ToolExecutor: StubToolExecutor,
  extensionToAgentTool: (
    extTool: CapturedExtToolCall["extTool"],
    toolExecutor: unknown,
    conversationId: string,
    messageId: string,
    schemaOverride?: Record<string, unknown>,
    invocationMetadata?: Record<string, unknown>,
  ): AgentTool => {
    captured.push({
      extTool,
      toolExecutor,
      conversationId,
      messageId,
      ...(schemaOverride !== undefined ? { schemaOverride } : {}),
      ...(invocationMetadata !== undefined ? { invocationMetadata } : {}),
    });
    // Return a minimal AgentTool-shaped object for the host to push.
    return {
      name: extTool.name,
      label: extTool.name,
      description: extTool.description,
      parameters: (schemaOverride ?? extTool.inputSchema) as unknown as AgentTool["parameters"],
      execute: async () => ({ content: [], details: { isError: false } }),
    };
  },
}));

const {
  ensureOrchestrationWired,
  wireOrchestrationToolsForTurn,
  _resetOrchestrationExtensionIdCache,
} = await import("../runtime/orchestration-host");
// Phase 1 fail-closed contract: every wireOrchestrationToolsForTurn
// call routes through `getPermissionEngine()` which throws if not
// pre-initialized. Install an allow-all stub as the singleton so the
// test exercises the wiring path without wiring a real bus / registry /
// audit log.
const {
  _setPermissionEngineForTests,
  _resetPermissionEngineForTests,
} = await import("../extensions/permission-engine");
const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
const { getDb } = await import("../db/connection");
const {
  extensions: extensionsTable,
  conversations,
  conversationExtensions,
  projects,
  users,
} = await import("../db/schema");

// ── Test fixtures ──────────────────────────────────────────────────

const ORCH_EXT_ID = "ext-orch-real";

async function seedFixtures(): Promise<void> {
  await getDb().insert(users).values({
    id: "user-orch-t",
    email: "orch-test@t.local",
    passwordHash: "x",
    name: "OrchTest",
  } as never).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: "proj-orch-t",
    name: "proj-orch-t",
    path: "/tmp/proj-orch-t",
  } as never).onConflictDoNothing();
}

async function seedOrchestrationExtension(): Promise<string> {
  await getDb().insert(extensionsTable).values({
    id: ORCH_EXT_ID,
    name: "orchestration",
    version: "1.0.0",
    description: "o",
    manifest: {
      schemaVersion: 2,
      name: "orchestration",
      version: "1.0.0",
      description: "o",
      author: { name: "t" },
      permissions: {},
    },
    source: "test:orch",
    installPath: "/tmp/orch",
    enabled: true,
  } as never).onConflictDoNothing();
  return ORCH_EXT_ID;
}

async function seedConversation(id: string): Promise<void> {
  await getDb().insert(conversations).values({
    id,
    projectId: "proj-orch-t",
    title: id,
  } as never).onConflictDoNothing();
}

beforeAll(async () => {
  await setupTestDb();
  await seedFixtures();
  // Pre-init PDP singleton via the test-only setter so
  // wireOrchestrationToolsForTurn's bare getPermissionEngine() call
  // resolves to an allow-all stub. StubToolExecutor short-circuits the
  // execute path so the engine's authorize() is never actually invoked.
  _resetPermissionEngineForTests();
  _setPermissionEngineForTests(createStubPermissionEngine("allow-all"));
});

afterAll(async () => {
  _resetPermissionEngineForTests();
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(() => {
  captured.length = 0;
  _resetOrchestrationExtensionIdCache();
});

// ── ensureOrchestrationWired ───────────────────────────────────────

describe("ensureOrchestrationWired", () => {
  test("returns false when the orchestration extension is not installed", async () => {
    // No seeded row yet (first test) — must return false non-throwing.
    const result = await ensureOrchestrationWired("conv-no-ext");
    expect(result).toBe(false);
  });

  test("inserts a conversation_extensions row on first call and returns true", async () => {
    const extId = await seedOrchestrationExtension();
    await seedConversation("conv-wire-1");

    const result = await ensureOrchestrationWired("conv-wire-1");
    expect(result).toBe(true);

    const { eq, and } = await import("drizzle-orm");
    const rows = await getDb()
      .select()
      .from(conversationExtensions)
      .where(
        and(
          eq(conversationExtensions.conversationId, "conv-wire-1"),
          eq(conversationExtensions.extensionId, extId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  test("second call is a no-op — UNIQUE(conv, ext) is respected and returns true", async () => {
    const extId = await seedOrchestrationExtension();
    await seedConversation("conv-wire-2");
    expect(await ensureOrchestrationWired("conv-wire-2")).toBe(true);
    expect(await ensureOrchestrationWired("conv-wire-2")).toBe(true);

    const { eq, and } = await import("drizzle-orm");
    const rows = await getDb()
      .select()
      .from(conversationExtensions)
      .where(
        and(
          eq(conversationExtensions.conversationId, "conv-wire-2"),
          eq(conversationExtensions.extensionId, extId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  test("concurrent first-use — both callers get true, one insert wins, no throw", async () => {
    const extId = await seedOrchestrationExtension();
    await seedConversation("conv-race");

    const [a, b] = await Promise.all([
      ensureOrchestrationWired("conv-race"),
      ensureOrchestrationWired("conv-race"),
    ]);
    // Both succeed — the loser's unique-constraint collision is
    // swallowed either by onConflictDoNothing() (drizzle) or by the
    // catch-branch's regex guard (raw driver error).
    expect(a).toBe(true);
    expect(b).toBe(true);

    const { eq, and } = await import("drizzle-orm");
    const rows = await getDb()
      .select()
      .from(conversationExtensions)
      .where(
        and(
          eq(conversationExtensions.conversationId, "conv-race"),
          eq(conversationExtensions.extensionId, extId),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

// ── wireOrchestrationToolsForTurn ───────────────────────────────────

function makeFakeRegistry(invokeAgentSchema: Record<string, unknown>) {
  return {
    getToolsForExtension: (_extId: string) => [
      {
        name: "orchestration__invoke_agent",
        originalName: "invoke_agent",
        description: "Invoke a specialized agent.",
        inputSchema: invokeAgentSchema,
        extensionId: ORCH_EXT_ID,
        extensionName: "orchestration",
      },
    ],
  };
}

const BASE_SCHEMA = {
  type: "object",
  properties: {
    agentConfigId: {
      type: "string",
      description: "The ID of the agent to invoke.",
    },
    task: { type: "string", description: "Task." },
  },
  required: ["agentConfigId", "task"],
};

function baseParams(overrides: Record<string, unknown> = {}): Parameters<
  typeof wireOrchestrationToolsForTurn
>[0] {
  const agentTools: AgentTool[] = [];
  return {
    agentTools,
    conversationId: "conv-wire-3",
    runId: "run-123",
    availableAgents: [
      { id: "a1", name: "Alpha", description: "" },
      { id: "a2", name: "Beta", description: "" },
    ],
    depth: 0,
    registry: makeFakeRegistry(structuredClone(BASE_SCHEMA)) as never,
    executor: {} as never,
    ...overrides,
  };
}

describe("wireOrchestrationToolsForTurn", () => {
  beforeEach(async () => {
    // The ext-id resolver uses getExtensionByName — make sure the
    // orchestration row is seeded (beforeAll seeds once via the wired
    // block, but the beforeEach cache reset means the next call does
    // a fresh DB lookup).
    await seedOrchestrationExtension();
  });

  test("happy path: appends the tool with schema override containing exactly availableAgents ids", async () => {
    const params = baseParams();
    await wireOrchestrationToolsForTurn(params);

    expect(params.agentTools).toHaveLength(1);
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.extTool.name).toBe("invoke_agent"); // un-namespaced
    expect(call.conversationId).toBe("conv-wire-3");
    expect(call.messageId).toBe("run-123"); // runId IS messageId

    const override = call.schemaOverride as {
      properties: { agentConfigId: { enum: string[] } };
    };
    expect(override.properties.agentConfigId.enum).toEqual(["a1", "a2"]);
  });

  test("empty availableAgents: tool NOT appended, warn logged", async () => {
    const warnSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const params = baseParams({ availableAgents: [] });
      await wireOrchestrationToolsForTurn(params);

      expect(params.agentTools).toHaveLength(0);
      expect(captured).toHaveLength(0);
      // Confirm a warn was emitted — the logger writes JSON to stderr.
      const emitted = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .join("\n");
      expect(emitted.toLowerCase()).toContain("no availableagents");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("invocationMetadata: populated fields carry through when defined", async () => {
    const params = baseParams({
      parentMessageId: "msg-parent",
      memberOverrides: { a1: { model: "gpt-4o" } } as Record<string, unknown>,
      teamToolScope: {
        allowedTools: ["read_file"],
        deniedTools: ["bash"],
      },
      depth: 3,
    });
    await wireOrchestrationToolsForTurn(params);

    const md = captured[0]!.invocationMetadata!;
    expect(md.parentMessageId).toBe("msg-parent");
    expect(md.overrides).toEqual({ a1: { model: "gpt-4o" } });
    expect(md.teamToolScope).toEqual({
      allowedTools: ["read_file"],
      deniedTools: ["bash"],
    });
    expect(md.orchestrationDepth).toBe(3);
  });

  test("invocationMetadata: undefined source fields are omitted (only orchestrationDepth remains)", async () => {
    // No parentMessageId / memberOverrides / teamToolScope passed.
    const params = baseParams({ depth: 7 });
    await wireOrchestrationToolsForTurn(params);

    const md = captured[0]!.invocationMetadata!;
    expect(md).toEqual({ orchestrationDepth: 7 });
    expect("parentMessageId" in md).toBe(false);
    expect("overrides" in md).toBe(false);
    expect("teamToolScope" in md).toBe(false);
  });

  test("schema override de-duplicates agent ids", async () => {
    const params = baseParams({
      availableAgents: [
        { id: "dup", name: "One", description: "" },
        { id: "dup", name: "Two", description: "" },
        { id: "unique", name: "Three", description: "" },
      ],
    });
    await wireOrchestrationToolsForTurn(params);

    const override = captured[0]!.schemaOverride as {
      properties: { agentConfigId: { enum: string[] } };
    };
    expect(override.properties.agentConfigId.enum).toEqual(["dup", "unique"]);
  });

  test("schema override does NOT mutate the registry-cached manifest schema", async () => {
    const cachedSchema = structuredClone(BASE_SCHEMA);
    const registry = makeFakeRegistry(cachedSchema);
    const params = baseParams({ registry: registry as never });
    await wireOrchestrationToolsForTurn(params);

    // The per-turn override carries an enum; the cached manifest schema
    // must NOT — else a subsequent turn would inherit the previous
    // turn's agent list.
    const cachedProps = cachedSchema.properties as {
      agentConfigId: Record<string, unknown>;
    };
    expect(cachedProps.agentConfigId.enum).toBeUndefined();
    const override = captured[0]!.schemaOverride as {
      properties: { agentConfigId: { enum: string[] } };
    };
    expect(override.properties.agentConfigId.enum).toEqual(["a1", "a2"]);
  });

  test("registry missing invoke_agent tool → no append, warn logged", async () => {
    const warnSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const emptyRegistry = {
        getToolsForExtension: (_id: string) => [],
      };
      const params = baseParams({ registry: emptyRegistry as never });
      await wireOrchestrationToolsForTurn(params);

      expect(params.agentTools).toHaveLength(0);
      expect(captured).toHaveLength(0);
      const emitted = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .join("\n");
      expect(emitted.toLowerCase()).toContain("no invoke_agent");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

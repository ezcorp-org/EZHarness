import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { installMcpExtension, deleteExtension, updateExtension } from "../db/queries/extensions";
import { createConversation } from "../db/queries/conversations";
import { getDb } from "../db/connection";
import { toolCalls, projects } from "../db/schema";
import { eq } from "drizzle-orm";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

import { mcpReleaseFixture } from "./helpers/mcp-release-fixture";
import { normalizeMcpCatalog } from "@ezcorp/extension-contract";
import { createUser } from "../db/queries/users";
let fixture: ReturnType<typeof mcpReleaseFixture> | undefined;
afterEach(() => fixture?.cleanup());
let ownerId: string;
let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  ownerId = (await createUser({ email: "mcp-owner@test.local", name: "MCP owner", passwordHash: "hash", role: "admin", status: "active" })).id;
  const [p] = await getDb()
    .insert(projects)
    .values({ name: "mcp-exec-proj", path: "/tmp/mcp-exec" })
    .returning();
  projectId = p!.id;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(() => {
  ExtensionRegistry.resetInstance();
});

/**
 * End-to-end integration: the ToolExecutor → MCP client path emits the
 * `tool:start`/`tool:complete`/`tool:error` events, records a `tool_calls`
 * row, and passes shared-variable-resolved input through to the MCP client.
 *
 * We stub the MCP client rather than spawn a real subprocess; the executor
 * branch still exercises every line that matters: dispatch, shared-var
 * resolution, event emission, and DB recording.
 */
describe("ToolExecutor MCP path — events + DB recording", () => {
  async function setupMcp(
    extName: string,
    inputSchema: Record<string, unknown>,
    callToolImpl: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }>,
  ) {
    const ext = await installMcpExtension({
      name: extName,
      server: { transport: "stdio", name: extName, command: "node" },
      cachedTools: [
        { name: "probe", description: "probe", inputSchema },
      ],
    });

    fixture = mcpReleaseFixture({ id: ext.id, name: extName, tools: normalizeMcpCatalog([{ name: "probe", description: "probe", inputSchema }]) });
    fixture.snapshot.installation.ownerId = ownerId;
    await updateExtension(ext.id, { manifest: fixture.manifest });
    const registry = fixture.registry;
    await registry.loadFromDb();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    fixture.invoke(async params => {
      const name = params.name as string;
      const args = params.input as Record<string, unknown>;
      calls.push({ name, args });
      return callToolImpl(name, args);
    });

    return { ext, registry, calls };
  }

  test("emits tool:start and tool:complete events on success", async () => {
    const { ext, registry, calls } = await setupMcp(
      "ev-success",
      { type: "object", properties: { text: { type: "string" } } },
      async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    );

    const bus = new EventBus<AgentEvents>();
    const events: Array<{ type: string; payload: unknown }> = [];
    bus.on("tool:start", (p) => events.push({ type: "tool:start", payload: p }));
    bus.on("tool:complete", (p) => events.push({ type: "tool:complete", payload: p }));
    bus.on("tool:error", (p) => events.push({ type: "tool:error", payload: p }));

    const conv = await createConversation(projectId, { userId: ownerId, title: "ev" });
    const executor = new ToolExecutor(registry, createStubPermissionEngine(), { bus });
    executor.setCurrentUserId(ownerId);

    const result = await executor.executeToolCall(
      "ev-success__probe",
      { text: "abc" },
      conv.id,
      null,
    );

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ text: "abc" });
    expect(events.map((e) => e.type)).toEqual(["tool:start", "tool:complete"]);

    // Verify the tool_calls row
    const rows = await getDb().select().from(toolCalls).where(eq(toolCalls.extensionId, ext.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toolName).toBe("ev-success__probe");
    expect(rows[0]!.success).toBe(true);
    expect(rows[0]!.conversationId).toBe(conv.id);

    await deleteExtension(ext.id);
  });

  test("emits tool:error when the MCP client throws", async () => {
    const { ext, registry } = await setupMcp(
      "ev-throw",
      { type: "object", properties: {} },
      async () => { throw new Error("connect refused"); },
    );

    const bus = new EventBus<AgentEvents>();
    const events: Array<{ type: string }> = [];
    bus.on("tool:start", () => events.push({ type: "tool:start" }));
    bus.on("tool:complete", () => events.push({ type: "tool:complete" }));
    bus.on("tool:error", () => events.push({ type: "tool:error" }));

    const conv = await createConversation(projectId, { userId: ownerId, title: "err" });
    const executor = new ToolExecutor(registry, createStubPermissionEngine(), { bus });
    executor.setCurrentUserId(ownerId);

    const result = await executor.executeToolCall(
      "ev-throw__probe",
      {},
      conv.id,
      null,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("connect refused");
    expect(events.map((e) => e.type)).toEqual(["tool:start", "tool:error"]);

    // isError=true row recorded
    const rows = await getDb().select().from(toolCalls).where(eq(toolCalls.extensionId, ext.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.success).toBe(false);

    await deleteExtension(ext.id);
  });

  test("records an isError=true row when the MCP server returns isError", async () => {
    const { ext, registry } = await setupMcp(
      "ev-iserr",
      { type: "object", properties: {} },
      async () => ({ content: [{ type: "text", text: "nope" }], isError: true }),
    );
    const conv = await createConversation(projectId, { userId: ownerId, title: "isErr" });
    const executor = new ToolExecutor(registry, createStubPermissionEngine());
    executor.setCurrentUserId(ownerId);
    const r = await executor.executeToolCall("ev-iserr__probe", {}, conv.id, null);
    expect(r.isError).toBe(true);

    const rows = await getDb().select().from(toolCalls).where(eq(toolCalls.extensionId, ext.id));
    expect(rows[0]!.success).toBe(false);

    await deleteExtension(ext.id);
  });

  test("shared-variable resolution runs on MCP path: x-shared fields are auto-filled", async () => {
    const { ext, registry, calls } = await setupMcp(
      "ev-shared",
      {
        type: "object",
        properties: {
          cwd: { type: "string", "x-shared": "project.cwd" },
          name: { type: "string" },
        },
      },
      async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    );

    const conv = await createConversation(projectId, { userId: ownerId, title: "shared" });
    const executor = new ToolExecutor(registry, createStubPermissionEngine());
    executor.setCurrentUserId(ownerId);
    await executor.executeToolCall(
      "ev-shared__probe",
      { name: "alice" },
      conv.id,
      null,
    );

    expect(calls).toHaveLength(1);
    // cwd resolved; name passed through
    expect(calls[0]!.args.name).toBe("alice");
    expect(typeof calls[0]!.args.cwd).toBe("string");
    expect(calls[0]!.args.cwd).toBe(process.cwd());

    await deleteExtension(ext.id);
  });

  test("PDP deny is honored on MCP path", async () => {
    const { ext, registry } = await setupMcp(
      "ev-perm",
      { type: "object", properties: {} },
      async () => ({ content: [{ type: "text", text: "should-not-reach" }], isError: false }),
    );
    const conv = await createConversation(projectId, { userId: ownerId, title: "perm" });
    // Phase 1: the per-call permission gate is the PDP, not a checker
    // injected at construction time. Deny-all engine = same observable
    // semantics: PermissionDeniedError + subprocess never invoked.
    const executor = new ToolExecutor(registry, createStubPermissionEngine("deny-all"));
    executor.setCurrentUserId(ownerId);
    await expect(
      executor.executeToolCall("ev-perm__probe", {}, conv.id, null),
    ).rejects.toThrow(/Permission denied/);
    await deleteExtension(ext.id);
  });
});

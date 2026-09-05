// B5 — the host injects the CONVERSATION's active project root into the
// per-call `_meta` (`ezProjectRoot`) before dispatching to the subprocess.
//
// A single persistent extension subprocess serves EVERY conversation, so the
// process-wide `EZCORP_PROJECT_ROOT` env var only ever names ONE project and
// is wrong the moment a second project's conversation calls in. The host owns
// the truth (`conversations.projectId` → `projects.path`), so it resolves the
// root per-call and forwards it on `_meta`. This shard proves:
//   (a) a tool call on a conversation bound to a project injects that
//       project's `path` as `_meta.ezProjectRoot` (alongside ezConversationId);
//   (b) a tool call for an UNKNOWN conversation leaves `ezProjectRoot` unset
//       (defensive resolve — the ext falls back to the env var, no throw).
//
// SMALL isolated shard (kept out of the big suites so Bun's --coverage
// per-line attribution stays clean on this huge file). The only module mock
// is the shared test-pglite db/connection redirect — the queries under test
// (getConversation / getProject) are the REAL ones, backed by real rows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";

mockDbConnection();

import { ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import { conversations, projects, users, extensions, messages } from "../../db/schema";
import type { ExtensionRegistry } from "../registry";
import type { ExtensionManifestV2, ToolCallResult } from "../types";

const EXT_ID = "project-root-meta-ext";
const TOOL = "open_tool";
const PROJECT_PATH = "/app/projects/ecf-demo";

/** Manifest with a single un-gated tool so the call dispatches to the fake
 *  subprocess without tripping the RBAC / capability gates. */
function makeManifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: EXT_ID,
    version: "1.0.0",
    description: "project-root meta shard fixture",
    author: { name: "test" },
    entrypoint: "./e.ts",
    permissions: {},
    tools: [{ name: TOOL, description: "", inputSchema: { type: "object" } }],
  } as ExtensionManifestV2;
}

/** Registry whose fake subprocess records the `_meta` handed to `callTool`
 *  (the 3rd arg) — that's where the host injects `ezProjectRoot`. */
interface CapturedCall { meta?: Record<string, unknown>; options?: { signal?: AbortSignal }; calls?: number }

function makeRegistry(captured: CapturedCall, options: { mcp?: boolean; beforeProcess?: () => Promise<void> } = {}): ExtensionRegistry {
  const manifest = makeManifest();
  if (options.mcp) { manifest.kind = "mcp"; manifest.mcpServers = [{ name: "fixture", transport: "http", url: "https://fixture.test/mcp" }]; }
  const fakeProc = {
    callTool: async (
      _name: string,
      _args: unknown,
      meta?: Record<string, unknown>,
      callOptions?: { signal?: AbortSignal },
    ): Promise<ToolCallResult> => {
      captured.meta = meta;
      captured.options = callOptions;
      captured.calls = (captured.calls ?? 0) + 1;
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
    setNotificationHandler: () => {},
    setRequestHandler: () => {},
  };
  return {
    getRegisteredTool: (toolName: string) => {
      const t = manifest.tools?.find((x) => x.name === toolName);
      if (!t) return null;
      return { extensionId: EXT_ID, originalName: toolName, name: toolName, description: "", inputSchema: { type: "object" } };
    },
    getManifest: () => manifest,
    getGrantedPermissions: () => ({ grantedAt: {} }) as unknown as ReturnType<ExtensionRegistry["getGrantedPermissions"]>,
    getProcess: async () => { await options.beforeProcess?.(); return fakeProc; },
    getInstallPath: () => "/tmp/ext",
    getMcpClient: async () => {
      if (options.mcp) return fakeProc;
      throw new Error("not an mcp ext");
    },
    isBundled: () => false,
  } as unknown as ExtensionRegistry;
}

let userId: string;
let projectConvId: string;

async function seed(): Promise<void> {
  const db = getTestDb();
  await db.insert(extensions).values({ id: EXT_ID, name: EXT_ID, version: "1.0.0", source: "test:fixture", manifest: makeManifest() });
  const projRows = await db
    .insert(projects)
    .values({ name: "ECF Demo", path: PROJECT_PATH })
    .returning({ id: projects.id });
  const projectId = projRows[0]!.id;

  const userRows = await db
    .insert(users)
    .values({ email: "proot@meta.test", passwordHash: "x", name: "proot", role: "member" })
    .returning({ id: users.id });
  userId = userRows[0]!.id;

  const convRows = await db
    .insert(conversations)
    .values({ projectId, userId })
    .returning({ id: conversations.id });
  projectConvId = convRows[0]!.id;
}

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("ToolExecutor · conversation project-root → _meta.ezProjectRoot (B5)", () => {
  beforeAll(async () => {
    await setupTestDb();
    await seed();
  }, 30_000);

  test("(a) tool call on a project-bound conversation injects that project's path", async () => {
    const captured: { meta?: Record<string, unknown> } = {};
    const executor = new ToolExecutor(makeRegistry(captured), createStubPermissionEngine());
    executor.setCurrentUserId(userId);

    const res = await executor.executeToolCall(TOOL, {}, projectConvId, null);
    expect(res.isError).toBe(false);
    expect(captured.meta?.ezConversationId).toBe(projectConvId);
    expect(captured.meta?.ezProjectRoot).toBe(PROJECT_PATH);
  });

  test("(b) unknown conversation has no project authority and cannot commit a tool result", async () => {
    const captured: { meta?: Record<string, unknown> } = {};
    const executor = new ToolExecutor(makeRegistry(captured), createStubPermissionEngine());
    executor.setCurrentUserId(userId);

    await expect(executor.executeToolCall(TOOL, {}, "conv-does-not-exist", null)).rejects.toHaveProperty("code", "event_persist_failed");
    // Still forwards the conversation id, but no project resolved → no key.
    expect(captured.meta?.ezConversationId).toBe("conv-does-not-exist");
    expect(captured.meta && "ezProjectRoot" in captured.meta).toBe(false);
  });

  for (const mcp of [false, true]) test(`forwards the exact cancellation signal to ${mcp ? "MCP" : "subprocess"} dispatch`, async () => {
    const captured: CapturedCall = {};
    const controller = new AbortController();
    const executor = new ToolExecutor(makeRegistry(captured, { mcp }), createStubPermissionEngine());
    executor.setCurrentUserId(userId);
    const result = await executor.executeToolCall(TOOL, {}, projectConvId, null, { signal: controller.signal });
    expect(result.isError).toBe(false);
    expect(captured.calls).toBe(1);
    expect(captured.options?.signal).toBe(controller.signal);
    expect(captured.meta?.ezConversationId).toBe(projectConvId);
  });

  test("pre-aborted calls do not enter tool lookup or dispatch", async () => {
    const captured: CapturedCall = {};
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    const registry = makeRegistry(captured);
    registry.getRegisteredTool = () => { throw new Error("lookup must not run"); };
    const executor = new ToolExecutor(registry, createStubPermissionEngine());
    await expect(executor.executeToolCall(TOOL, {}, projectConvId, null, { signal: controller.signal })).rejects.toThrow("caller stopped");
    expect(captured.calls ?? 0).toBe(0);
  });

  test("code-agent tools context keeps the caller cancellation signal", async () => {
    const captured: CapturedCall = {};
    const controller = new AbortController();
    const executor = new ToolExecutor(makeRegistry(captured), createStubPermissionEngine());
    executor.setCurrentUserId(userId);
    const messageId = crypto.randomUUID();
    await getTestDb().insert(messages).values({ id: messageId, conversationId: projectConvId, role: "assistant", content: "" });
    const context = executor.createToolsContext(projectConvId, messageId, { signal: controller.signal });
    expect(await context.invoke(TOOL, {})).toBe("ok");
    expect(captured.calls).toBe(1);
    expect(captured.options?.signal).toBe(controller.signal);
    controller.abort(new Error("code agent stopped"));
    await expect(context.invoke(TOOL, {})).rejects.toThrow("code agent stopped");
    expect(captured.calls).toBe(1);
  });

  test("abort while resolving a process prevents later tool dispatch", async () => {
    const captured: CapturedCall = {};
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const executor = new ToolExecutor(makeRegistry(captured, { beforeProcess: async () => { entered.resolve(); await resume.promise; } }), createStubPermissionEngine());
    executor.setCurrentUserId(userId);
    const pending = executor.executeToolCall(TOOL, {}, projectConvId, null, { signal: controller.signal });
    await entered.promise;
    controller.abort(new Error("caller stopped"));
    resume.resolve();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("caller stopped");
    expect(captured.calls ?? 0).toBe(0);
  });
});

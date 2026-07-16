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
import { conversations, projects, users } from "../../db/schema";
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
    tools: [{ name: TOOL, description: "", inputSchema: { type: "object" } }],
  } as ExtensionManifestV2;
}

/** Registry whose fake subprocess records the `_meta` handed to `callTool`
 *  (the 3rd arg) — that's where the host injects `ezProjectRoot`. */
function makeRegistry(captured: { meta?: Record<string, unknown> }): ExtensionRegistry {
  const manifest = makeManifest();
  const fakeProc = {
    callTool: async (
      _name: string,
      _args: unknown,
      meta?: Record<string, unknown>,
    ): Promise<ToolCallResult> => {
      captured.meta = meta;
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
    getProcess: async () => fakeProc,
    getInstallPath: () => "/tmp/ext",
    getMcpClient: async () => {
      throw new Error("not an mcp ext");
    },
    isBundled: () => false,
  } as unknown as ExtensionRegistry;
}

let userId: string;
let projectConvId: string;

async function seed(): Promise<void> {
  const db = getTestDb();
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

  test("(b) unknown conversation → ezProjectRoot unset (defensive, no throw)", async () => {
    const captured: { meta?: Record<string, unknown> } = {};
    const executor = new ToolExecutor(makeRegistry(captured), createStubPermissionEngine());
    executor.setCurrentUserId(userId);

    const res = await executor.executeToolCall(TOOL, {}, "conv-does-not-exist", null);
    expect(res.isError).toBe(false);
    // Still forwards the conversation id, but no project resolved → no key.
    expect(captured.meta?.ezConversationId).toBe("conv-does-not-exist");
    expect(captured.meta && "ezProjectRoot" in captured.meta).toBe(false);
  });
});

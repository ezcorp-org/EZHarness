// Integration test: UI toggle-off makes an extension's tools unreachable
// to agents that have it assigned.
//
// Gap closed: the existing seam-permission-disable-integration.test.ts
// proves the *violation-driven* disable path unloads tools from the
// registry, but says nothing about the *admin-driven* toggle-off path —
// the PATCH /api/extensions/[id] {enabled:false} endpoint wired to the
// UI toggle. Those two paths share the final step (loadFromDb uses
// enabledOnly=true) but the write step differs:
//   - violation path  : denyAndDisable() sets enabled=false
//   - admin toggle    : updateExtension(id, {enabled: false})
// If the admin toggle ever writes to the wrong field, forgets to flip
// enabled, or doesn't trigger registry.reload() on the running process,
// agents assigned to that extension could keep invoking its tools after
// the user thought they'd disabled it.
//
// We drive the real PATCH handler, against a real pglite DB, with a
// real ExtensionRegistry, and then assert:
//   - getRegisteredTool returns null
//   - getToolsForAgent drops the tool for the assigned agent
//   - executor.executeToolCall returns "Unknown tool: …" (the same
//     branch exercised by the permission-violation seam test)
// Then we re-enable and assert the tool is back — the same endpoint
// must be able to reverse the action.

import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  getTestDb,
  mockDbConnection,
  mockRealSettings,
} from "./helpers/test-pglite";
import {
  mockServerAlias,
  createMockEvent,
  MEMBER_USER,
  ADMIN_USER,
} from "./helpers/mock-request";

// ── Module-level mocks ───────────────────────────────────────────

mockDbConnection();
mockRealSettings();
mockServerAlias();

// ExtensionRegistry imports ExtensionProcess at module load. We never
// dispatch into a subprocess here (the disabled-tool assertion hits the
// "Unknown tool" branch before any spawn), so a no-op stub is fine.
mock.module("../extensions/subprocess", () => ({
  ExtensionProcess: class {
    isRunning = false;
    kill() {}
  },
  parseMemoryLimit: (_: string) => undefined,
}));

mock.module("$server/db/queries/extensions", () => require("../db/queries/extensions"));
mock.module("$server/extensions/registry", () => require("../extensions/registry"));
mock.module("$server/extensions/security", () => require("../extensions/security"));
mock.module("../../web/src/routes/api/extensions/[id]/$types", () => ({}));
mock.module("../../web/src/routes/api/extensions/[id]/activate/$types", () => ({}));
mock.module("$server/db/queries/audit-log", () => require("../db/queries/audit-log"));
mock.module("$lib/server/security/api-keys", () => ({ requireScope: () => null }));
mock.module("../../web/src/lib/server/security/api-keys", () => ({ requireScope: () => null }));

// ── Handler + collaborators (AFTER mocks) ────────────────────────

import { PATCH } from "../../web/src/routes/api/extensions/[id]/+server";
import { POST as ACTIVATE } from "../../web/src/routes/api/extensions/[id]/activate/+server";
import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { extensions, agentConfigs, users, settings, toolCalls } from "../db/schema";
import { eq } from "drizzle-orm";
import type { ExtensionManifestV2 } from "../extensions/types";

const EXT_NAME = "gated-ext";
const TOOL_NAME = "do_thing";
const NAMESPACED_TOOL = `${EXT_NAME}__${TOOL_NAME}`;

function buildManifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: EXT_NAME,
    version: "1.0.0",
    description: "Toggle gating fixture",
    author: { name: "test" },
    entrypoint: "./index.js",
    tools: [
      {
        name: TOOL_NAME,
        description: "Do a thing",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    permissions: {},
  };
}

let extensionId: string;
let agentId: string;

async function call(
  handler: (ev: any) => unknown,
  event: any,
): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

beforeAll(async () => {
  await setupTestDb();
  await getTestDb().insert(users).values([
    {
      id: MEMBER_USER.id,
      email: MEMBER_USER.email,
      passwordHash: "h",
      name: MEMBER_USER.name,
      role: "member",
    },
    {
      id: ADMIN_USER.id,
      email: ADMIN_USER.email,
      passwordHash: "h",
      name: ADMIN_USER.name,
      role: "admin",
    },
  ]);
});

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  ExtensionRegistry.resetInstance();
  const db = getTestDb();
  await db.delete(toolCalls);
  await db.delete(agentConfigs);
  await db.delete(extensions);
  await db.delete(settings);

  const extRows = await db
    .insert(extensions)
    .values({
      name: EXT_NAME,
      version: "1.0.0",
      description: "Toggle gating fixture",
      manifest: buildManifest(),
      source: "local:/tmp/gated-ext",
      installPath: "/tmp/gated-ext",
      enabled: true,
      grantedPermissions: { grantedAt: {} } as any,
    })
    .returning({ id: extensions.id });
  extensionId = extRows[0]!.id;

  const agentRows = await db
    .insert(agentConfigs)
    .values({
      name: "gated-agent",
      description: "Agent assigned the gated extension",
      prompt: "be helpful",
      capabilities: ["llm"] as any,
      userId: MEMBER_USER.id,
      references: { agents: [], extensions: [extensionId] } as any,
      extensions: [extensionId] as any,
    } as any)
    .returning({ id: agentConfigs.id });
  agentId = agentRows[0]!.id;

  // Initial registry load — tool should be visible to the agent.
  await ExtensionRegistry.getInstance().loadFromDb();
});

describe("UI toggle-off gates the extension from assigned agents", () => {
  test("baseline: enabled extension IS reachable by the assigned agent", async () => {
    const registry = ExtensionRegistry.getInstance();
    expect(registry.getRegisteredTool(NAMESPACED_TOOL)).not.toBeNull();
    const agentTools = await registry.getToolsForAgent(agentId);
    expect(agentTools.map((t) => t.name)).toContain(NAMESPACED_TOOL);
  });

  test("PATCH {enabled:false} → registry drops the tool, agent sees empty tool list, executor rejects with 'Unknown tool'", async () => {
    const db = getTestDb();
    const registry = ExtensionRegistry.getInstance();

    // Simulate the UI toggle-off by hitting the real PATCH handler.
    const res = await call(
      PATCH,
      createMockEvent({
        method: "PATCH",
        url: `http://localhost/api/extensions/${extensionId}`,
        params: { id: extensionId },
        body: { enabled: false },
        user: ADMIN_USER,
      }),
    );
    expect(res.status).toBe(200);

    // DB row is flipped.
    const row = await db.select().from(extensions).where(eq(extensions.id, extensionId));
    expect(row[0]!.enabled).toBe(false);

    // Registry no longer exposes the tool — this is the contract the
    // UI relies on. If the PATCH handler ever stopped calling
    // registry.reload(), this assertion would fail.
    expect(registry.getRegisteredTool(NAMESPACED_TOOL)).toBeNull();
    expect(registry.getToolsForExtension(extensionId)).toHaveLength(0);

    // Agents assigned to this extension must not see its tools. An
    // agent run with only this extension attached would get zero tools
    // — which is the property we actually care about for gating.
    const agentTools = await registry.getToolsForAgent(agentId);
    expect(agentTools.find((t) => t.name === NAMESPACED_TOOL)).toBeUndefined();
    expect(agentTools).toHaveLength(0);

    // And the executor — the thing an agent would use to invoke a
    // tool at runtime — must reject with the "Unknown tool" branch
    // (not a permission check, not a subprocess call). That proves
    // the gating happens at the registry, upstream of execution.
    const executor = new ToolExecutor(registry, createStubPermissionEngine());
    const result = await executor.executeToolCall(
      NAMESPACED_TOOL,
      {},
      "conv-gated",
      "msg-gated",
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown tool");
    expect(result.content[0]!.text).toContain(NAMESPACED_TOOL);
  });

  test("POST /:id/activate after disable → tool returns for the agent", async () => {
    // Disable first.
    await call(
      PATCH,
      createMockEvent({
        method: "PATCH",
        url: `http://localhost/api/extensions/${extensionId}`,
        params: { id: extensionId },
        body: { enabled: false },
        user: ADMIN_USER,
      }),
    );

    const registry = ExtensionRegistry.getInstance();
    expect(registry.getRegisteredTool(NAMESPACED_TOOL)).toBeNull();

    // Re-enable via the admin-only /activate endpoint — PATCH no longer
    // accepts {enabled:true} (task #2: back-door lockdown).
    const res = await call(
      ACTIVATE,
      createMockEvent({
        method: "POST",
        url: `http://localhost/api/extensions/${extensionId}/activate`,
        params: { id: extensionId },
        body: {},
        user: ADMIN_USER,
      }),
    );
    expect(res.status).toBe(200);

    // Tool is reachable again.
    expect(registry.getRegisteredTool(NAMESPACED_TOOL)).not.toBeNull();
    const agentTools = await registry.getToolsForAgent(agentId);
    expect(agentTools.map((t) => t.name)).toContain(NAMESPACED_TOOL);
  });

  test("other extensions on the same agent are unaffected by toggling one off", async () => {
    // Isolation guard: a bug where the registry wiped the entire
    // toolMap on reload but failed to repopulate from the still-enabled
    // siblings would break every extension every time a user toggled
    // one. We seed a sibling, toggle the first, and assert the sibling
    // still works.
    const db = getTestDb();
    const siblingName = "other-ext";
    const siblingToolName = "other_tool";
    const siblingNamespaced = `${siblingName}__${siblingToolName}`;

    const siblingRows = await db
      .insert(extensions)
      .values({
        name: siblingName,
        version: "1.0.0",
        description: "Sibling",
        manifest: {
          ...buildManifest(),
          name: siblingName,
          tools: [{
            name: siblingToolName,
            description: "Sibling tool",
            inputSchema: { type: "object", properties: {} },
          }],
        } as any,
        source: "local:/tmp/other-ext",
        installPath: "/tmp/other-ext",
        enabled: true,
        grantedPermissions: { grantedAt: {} } as any,
      })
      .returning({ id: extensions.id });
    const siblingId = siblingRows[0]!.id;

    // Attach BOTH extensions to the agent.
    await db
      .update(agentConfigs)
      .set({
        extensions: [extensionId, siblingId] as any,
        references: { agents: [], extensions: [extensionId, siblingId] } as any,
      })
      .where(eq(agentConfigs.id, agentId));

    await ExtensionRegistry.getInstance().loadFromDb();
    const registry = ExtensionRegistry.getInstance();

    // Toggle only the first extension off.
    await call(
      PATCH,
      createMockEvent({
        method: "PATCH",
        url: `http://localhost/api/extensions/${extensionId}`,
        params: { id: extensionId },
        body: { enabled: false },
        user: ADMIN_USER,
      }),
    );

    // Sibling tool must still be visible and dispatchable through the
    // registry lookup (the bit that decides "can this agent call this
    // tool").
    expect(registry.getRegisteredTool(NAMESPACED_TOOL)).toBeNull();
    expect(registry.getRegisteredTool(siblingNamespaced)).not.toBeNull();

    const agentTools = await registry.getToolsForAgent(agentId);
    const toolNames = agentTools.map((t) => t.name);
    expect(toolNames).not.toContain(NAMESPACED_TOOL);
    expect(toolNames).toContain(siblingNamespaced);
  });
});

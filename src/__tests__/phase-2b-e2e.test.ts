/**
 * End-to-end test for the Phase 2b capability tier.
 *
 * Covers the "full stack minus HTTP server" vertical slice:
 *   1. Seed an extension row with a manifest declaring `taskEvents: true`
 *      and `agentConfig: "read"`.
 *   2. PUT /api/extensions/[id]/permissions with capability grants →
 *      clampToManifest preserves both fields.
 *   3. The audit log gains CAPABILITY_GRANTED entries (typed + per-field).
 *   4. Reading back via GET /api/extensions/[id]/permissions echoes the
 *      clamped grants.
 *   5. Attempting to grant a capability NOT declared in the manifest is
 *      silently clamped and written as PERMISSION_REJECTED.
 *   6. The handlers route off the granted permissions — a tight loop
 *      through handleEmitTaskEventRpc + handleAgentConfigsRpc proves
 *      the RPC layer sees the grants set in step (2).
 *   7. Revoking the grants via PUT with an empty object — the next RPC
 *      call is refused with -32001.
 *   8. Setting EZCORP_DISABLE_CAPABILITY_TOOLS=1 kills the tier at the
 *      handler layer even if the DB still has the grants (the manual
 *      exit criterion from the plan).
 *
 * Pattern matches scratchpad-e2e.test.ts — SvelteKit routes are called
 * as function handlers with a fabricated RequestEvent; we do not spin
 * up Bun's HTTP listener. This keeps the test fast (< 2s) and stable.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

mock.module("$server/db/connection", async () => {
  const { getDb } = await import("../db/connection");
  return { getDb };
});

mock.module("$server/extensions/registry", async () => {
  // The real registry reloads processes on permission changes. In this
  // test we don't care about subprocess lifecycle — stub reload to a
  // no-op so the PUT handler can complete without touching real procs.
  const actual = await import("../extensions/registry");
  return {
    ...actual,
    ExtensionRegistry: {
      ...actual.ExtensionRegistry,
      getInstance: () => ({ reload: async () => {} }),
    },
  };
});

mock.module("../../web/src/routes/api/extensions/[id]/permissions/$types", () => ({}));

import { PUT as permissionsPut, GET as permissionsGet } from "../../web/src/routes/api/extensions/[id]/permissions/+server";
import { listAuditForExtension } from "../db/queries/audit-log";
import { handleEmitTaskEventRpc } from "../extensions/task-events-handler";
import { handleAgentConfigsRpc } from "../extensions/agent-configs-handler";
import { getDb } from "../db/connection";
import {
  extensions as extensionsTable,
  projects,
  conversations,
  conversationExtensions,
  users,
  agentConfigs,
} from "../db/schema";

import type { JsonRpcRequest, ExtensionPermissions } from "../extensions/types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

const ADMIN = { id: "admin-2b-e2e", role: "admin", email: "a@t", name: "Admin" };
const USER_ID = "user-2b-e2e";
const EXT_ID = "ext-2b-e2e";
const CONV_ID = "conv-2b-e2e";

function makeEvent(body: unknown): any {
  const request = new Request(`http://test/api/extensions/${EXT_ID}/permissions`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    url: new URL(`http://test/api/extensions/${EXT_ID}/permissions`),
    locals: { user: ADMIN },
    params: { id: EXT_ID },
    request,
  };
}

function getEvent(): any {
  return {
    url: new URL(`http://test/api/extensions/${EXT_ID}/permissions`),
    locals: { user: ADMIN },
    params: { id: EXT_ID },
    request: new Request(`http://test/api/extensions/${EXT_ID}/permissions`),
  };
}

function makeBus(): { bus: EventBus<AgentEvents>; calls: Array<{ event: string; payload: unknown }> } {
  const calls: Array<{ event: string; payload: unknown }> = [];
  const bus = {
    emit: (event: string, payload: unknown) => { calls.push({ event, payload }); },
    on: () => () => {},
    off: () => {},
  } as unknown as EventBus<AgentEvents>;
  return { bus, calls };
}

function rpc(method: string, params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

beforeAll(async () => {
  await setupTestDb();

  await getDb().insert(users).values({
    id: USER_ID, email: "u@t.local", passwordHash: "x", name: "U",
  } as any);
  await getDb().insert(users).values({
    id: ADMIN.id, email: "a2@t.local", passwordHash: "x", name: "A", role: "admin",
  } as any);

  await getDb().insert(projects).values({
    id: "proj-2b-e2e", name: "proj", path: "/tmp/proj-2b-e2e",
  } as any);
  await getDb().insert(conversations).values({
    id: CONV_ID, projectId: "proj-2b-e2e", title: "e2e",
  } as any);

  await getDb().insert(extensionsTable).values({
    id: EXT_ID,
    name: EXT_ID,
    version: "1.0.0",
    description: "e2e fixture",
    manifest: {
      schemaVersion: 2,
      name: EXT_ID,
      version: "1.0.0",
      description: "e2e",
      author: { name: "e2e" },
      permissions: {
        taskEvents: true,
        agentConfig: "read",
      },
    },
    source: `test:${EXT_ID}`,
    installPath: `/tmp/${EXT_ID}`,
    enabled: true,
    grantedPermissions: { grantedAt: {} },
  } as any);

  await getDb().insert(conversationExtensions).values({
    conversationId: CONV_ID, extensionId: EXT_ID,
  } as any).onConflictDoNothing();

  await getDb().insert(agentConfigs).values({
    id: crypto.randomUUID(),
    name: "e2e-helper",
    description: "for e2e",
    prompt: "p",
    capabilities: ["llm"],
    references: { agents: [], extensions: [] },
    userId: USER_ID,
  } as any);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("Phase 2b e2e: install → clamp → audit → RPC routing → revoke → kill-switch", () => {
  test("PUT grants taskEvents + agentConfig when manifest declares them; clampToManifest preserves", async () => {
    const res = await permissionsPut(makeEvent({
      permissions: { taskEvents: true, agentConfig: "read" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { grantedPermissions: ExtensionPermissions };
    expect(body.grantedPermissions.taskEvents).toBe(true);
    expect(body.grantedPermissions.agentConfig).toBe("read");
  });

  test("audit log gains CAPABILITY_GRANTED rows for each capability field", async () => {
    const entries = await listAuditForExtension(EXT_ID);
    const caps = entries.filter((e) => e.action === "ext:capability-granted");
    const fields = new Set(caps.map((e) => (e.metadata as { permission: string } | null)?.permission));
    expect(fields.has("taskEvents")).toBe(true);
    expect(fields.has("agentConfig")).toBe(true);
  });

  test("GET echoes the clamped grants", async () => {
    const res = await permissionsGet(getEvent());
    const body = await res.json() as ExtensionPermissions;
    expect(body.taskEvents).toBe(true);
    expect(body.agentConfig).toBe("read");
  });

  test("attempting to grant a non-manifest capability (shell) is silently clamped → PERMISSION_REJECTED audit", async () => {
    const res = await permissionsPut(makeEvent({
      permissions: { taskEvents: true, agentConfig: "read", shell: true },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { grantedPermissions: ExtensionPermissions };
    // shell was NOT in the manifest → clamp drops it.
    expect(body.grantedPermissions.shell).toBeUndefined();
    const entries = await listAuditForExtension(EXT_ID);
    const rejected = entries.filter((e) => e.action === "ext:permission-rejected");
    const shellAttempts = rejected.filter((e) => (e.metadata as { permission: string } | null)?.permission === "shell");
    expect(shellAttempts.length).toBeGreaterThanOrEqual(1);
  });

  test("handleEmitTaskEventRpc routes off the granted permissions → bus fires", async () => {
    const res = await permissionsGet(getEvent());
    const granted = await res.json() as ExtensionPermissions;

    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(EXT_ID, rpc("ezcorp/emit-task-event", {
      v: 1, type: "snapshot",
      payload: { tasks: [], activeTaskId: undefined },
    }), {
      conversationId: CONV_ID, userId: USER_ID,
      grantedPermissions: granted, bus,
    });
    expect(resp.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect((calls[0]!.payload as { conversationId: string }).conversationId).toBe(CONV_ID);
  });

  test("handleAgentConfigsRpc routes off the granted permissions → returns user's configs", async () => {
    const res = await permissionsGet(getEvent());
    const granted = await res.json() as ExtensionPermissions;

    const resp = await handleAgentConfigsRpc(EXT_ID, rpc("ezcorp/agent-configs", {
      v: 1, action: "list",
    }), { userId: USER_ID, grantedPermissions: granted });
    expect(resp.error).toBeUndefined();
    const { configs } = resp.result as { configs: Array<{ name: string }> };
    expect(configs.some((c) => c.name === "e2e-helper")).toBe(true);
  });

  test("revoking via PUT with empty permissions → next RPC call is refused (-32001)", async () => {
    // Revoke all.
    await permissionsPut(makeEvent({ permissions: {} }));
    const getRes = await permissionsGet(getEvent());
    const granted = await getRes.json() as ExtensionPermissions;
    expect(granted.taskEvents).toBeUndefined();
    expect(granted.agentConfig).toBeUndefined();

    // Audit log must have CAPABILITY_REVOKED rows.
    const entries = await listAuditForExtension(EXT_ID);
    const revoked = entries.filter((e) => e.action === "ext:capability-revoked");
    const fields = new Set(revoked.map((e) => (e.metadata as { permission: string } | null)?.permission));
    expect(fields.has("taskEvents")).toBe(true);
    expect(fields.has("agentConfig")).toBe(true);

    // Handler refusal.
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(EXT_ID, rpc("ezcorp/emit-task-event", {
      v: 1, type: "snapshot", payload: { tasks: [] },
    }), {
      conversationId: CONV_ID, userId: USER_ID,
      grantedPermissions: granted, bus,
    });
    expect(resp.error?.code).toBe(-32001);
    expect(calls).toHaveLength(0);
  });

  test("kill-switch EZCORP_DISABLE_CAPABILITY_TOOLS=1 refuses even when DB grants are present", async () => {
    // Re-grant.
    await permissionsPut(makeEvent({
      permissions: { taskEvents: true, agentConfig: "read" },
    }));

    const prev = process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    try {
      // Even if an existing DB grant is in hand, the handler refuses.
      const granted: ExtensionPermissions = {
        taskEvents: true,
        agentConfig: "read",
        grantedAt: { taskEvents: Date.now(), agentConfig: Date.now() },
      };

      const { bus, calls } = makeBus();
      const r1 = await handleEmitTaskEventRpc(EXT_ID, rpc("ezcorp/emit-task-event", {
        v: 1, type: "snapshot", payload: { tasks: [] },
      }), { conversationId: CONV_ID, userId: USER_ID, grantedPermissions: granted, bus });
      expect(r1.error?.code).toBe(-32001);

      const r2 = await handleAgentConfigsRpc(EXT_ID, rpc("ezcorp/agent-configs", {
        v: 1, action: "list",
      }), { userId: USER_ID, grantedPermissions: granted });
      expect(r2.error?.code).toBe(-32001);

      expect(calls).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
      else process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = prev;
    }
  });
});

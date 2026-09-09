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
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import { validateManifest } from "@ezcorp/extension-contract";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { publishExtensionGeneration } from "../extensions/extension-lifecycle-service";
import { listAuditForExtension } from "../db/queries/audit-log";
import { handleEmitTaskEventRpc } from "../extensions/task-events-handler";
import { handleAgentConfigsRpc } from "../extensions/agent-configs-handler";
import { getDb } from "../db/connection";
import {
  extensions as extensionsTable,
  projects,
  projectMembers,
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
const manifest = validateManifest({ schemaVersion: 4, name: EXT_ID, version: "1.0.0", description: "e2e", author: { name: "e2e" }, permissions: { taskEvents: true, agentConfig: "read" } });
const fixture = releaseRuntimeFixture(EXT_ID, manifest, { ownerId: ADMIN.id });
let repository: DatabaseLifecycleRepository;
async function publish(enabled: boolean) {
  await repository.transact(EXT_ID, (state) => {
    state.installation.activeReleaseId = fixture.snapshot.release.id;
    state.installation.generation++;
    state.installation.enabled = enabled;
    state.installation.grants = enabled ? fixture.snapshot.installation.grants : [];
  }, { principalId: ADMIN.id, kind: "human", scope: "global" });
  await publishExtensionGeneration((await repository.read(EXT_ID))!.installation, enabled ? fixture.snapshot.release : null);
}

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
  const { _resetTaskTrackingExtensionIdCache } = await import("../runtime/task-tracking-host");
  _resetTaskTrackingExtensionIdCache();

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
    id: CONV_ID, projectId: "proj-2b-e2e", title: "e2e", userId: USER_ID,
  } as any);
  await getDb().insert(projectMembers).values({ projectId: "proj-2b-e2e", userId: USER_ID, role: "member" });
  await getDb().insert(extensionsTable).values({ id: "task-state-store-2b", name: "task-tracking", version: "1.0.0", manifest: { ...manifest, name: "task-tracking" }, source: "test:task-state", enabled: true });

  await getDb().insert(extensionsTable).values({
    id: EXT_ID,
    name: EXT_ID,
    version: "1.0.0",
    description: "e2e fixture",
    manifest,
    source: "release-v4",
    installPath: null,
    enabled: false,
    grantedPermissions: { grantedAt: {} },
  } as any);

  repository = new DatabaseLifecycleRepository(getDb());
  await repository.create({ installation: { ...fixture.snapshot.installation, activeReleaseId: null, enabled: false, generation: 0, acknowledgedGeneration: 0, grants: [] }, releases: { [fixture.snapshot.release.id]: fixture.snapshot.release }, workspaces: {}, revisions: {}, operations: {}, approvals: {} });

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
  test("release publication grants the exact declared capabilities", async () => {
    await publish(true);
    const response = await permissionsGet(getEvent());
    const grant = await response.json() as ExtensionPermissions;
    expect(grant.taskEvents).toBe(true);
    expect(grant.agentConfig).toBe("read");
  });

  test("activation audit carries the exact sealed grant and actor", async () => {
    const entries = await listAuditForExtension(EXT_ID);
    const activated = entries.filter((entry) => entry.action === "ext:activated");
    expect(activated).toHaveLength(1);
    expect(activated[0]!.userId).toBe(ADMIN.id);
    expect(activated[0]!.metadata?.grants).toEqual(fixture.snapshot.installation.grants);
  });

  test("GET echoes the clamped grants", async () => {
    const res = await permissionsGet(getEvent());
    const body = await res.json() as ExtensionPermissions;
    expect(body.taskEvents).toBe(true);
    expect(body.agentConfig).toBe("read");
  });

  test("legacy PUT cannot add undeclared shell access or mutate current grants", async () => {
    const response = await permissionsPut(makeEvent({ permissions: { shell: true, taskEvents: true, agentConfig: "read" } }));
    expect(response.status).toBe(410);
    const grant = await (await permissionsGet(getEvent())).json() as ExtensionPermissions;
    expect(grant.shell).toBeUndefined();
    expect(grant.taskEvents).toBe(true);
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

  test("disabling the release revokes grants and the next RPC call is refused (-32001)", async () => {
    // Revoke all.
    await publish(false);
    const getRes = await permissionsGet(getEvent());
    const granted = await getRes.json() as ExtensionPermissions;
    expect(granted.taskEvents).toBeUndefined();
    expect(granted.agentConfig).toBeUndefined();

    const entries = await listAuditForExtension(EXT_ID);
    const revoked = entries.filter((entry) => entry.action === "ext:disabled");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.metadata?.grants).toEqual([]);

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
    await publish(true);

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

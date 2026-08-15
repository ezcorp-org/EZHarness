import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AuthUser } from "../auth/types";

afterAll(() => restoreModuleMocks());

// ── Mock DB layer ──────────────────────────────────────────────────
let settingsStore: Record<string, unknown> = {};

mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => settingsStore[key],
  upsertSetting: async (key: string, value: unknown) => {
    settingsStore[key] = value;
  },
}));

// updated for sec-H2 — handleToolPermission now loads the conversation to
// verify ownership before acting on a pending gate. Stub to a conversation
// owned by OWNER_USER below.
//
// `handleSetPermissionMode` reads the same query for the live-switch event's
// conversation, and compares `projectId` as well as the owner — hence the real
// project id here and the `null` for anything else. The refusal paths are
// probed in `src/__tests__/security/project-permission-mode-authz.test.ts`;
// this file drives the happy paths.
mock.module("../db/queries/conversations", () => ({
  getConversation: async (id: string) =>
    id === "conv-owner"
      ? {
          id: "conv-owner",
          userId: "owner-user-1",
          title: "Owner conversation",
          projectId: "proj-6",
        }
      : null,
}));

import {
  handleToolPermission,
  handleGetPermissionMode,
  handleSetPermissionMode,
} from "../routes/tool-permission";
import { createPermissionGate } from "../runtime/tools/permissions";

// updated for sec-H2 — the gate owner for tests below. Gates are created
// with conversationId="conv-owner"; the getConversation mock returns a
// conversation with userId="owner-user-1", so this user is the gate owner.
const OWNER_USER: AuthUser = {
  id: "owner-user-1",
  email: "owner@test.local",
  name: "Owner",
  role: "member",
};

// ── Helpers ────────────────────────────────────────────────────────

function postPermission(id: string, body?: unknown) {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost/api/tool-calls/${id}/permission`, init);
}

function putMode(id: string, body?: unknown) {
  const init: RequestInit = { method: "PUT" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost/api/projects/${id}/tool-permission-mode`, init);
}

function getMode(id: string) {
  return new Request(`http://localhost/api/projects/${id}/tool-permission-mode`);
}

// ── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  settingsStore = {};
});

describe("POST /api/tool-calls/:id/permission", () => {
  test("approve a pending gate -> gate resolves", async () => {
    // updated for sec-H2 — gate is now created with a conversationId,
    // and the handler is called with the owning user.
    const gate = createPermissionGate("tc-approve", "conv-owner");
    const res = await handleToolPermission(
      postPermission("tc-approve", { approved: true }),
      "tc-approve",
      OWNER_USER,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Gate should resolve without throwing
    await gate;
  });

  test("deny a pending gate -> gate rejects with 'Permission denied'", async () => {
    // updated for sec-H2
    const gate = createPermissionGate("tc-deny", "conv-owner");
    const res = await handleToolPermission(
      postPermission("tc-deny", { approved: false }),
      "tc-deny",
      OWNER_USER,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await expect(gate).rejects.toThrow("Permission denied");
  });

  test("invalid JSON body -> returns 400", async () => {
    const req = new Request("http://localhost/api/tool-calls/tc-bad/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    // updated for sec-H2
    const res = await handleToolPermission(req, "tc-bad", OWNER_USER);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid JSON");
  });

  test("missing 'approved' field -> returns 400", async () => {
    // updated for sec-H2
    const res = await handleToolPermission(
      postPermission("tc-missing", { foo: "bar" }),
      "tc-missing",
      OWNER_USER,
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("approved");
  });

  test("unknown toolCallId -> returns 200 (no-op)", async () => {
    // updated for sec-H2 — no pending gate means no ownership check is
    // required; the call remains a no-op. See handleToolPermission for the
    // rationale preserving this shape for page-refresh races.
    const res = await handleToolPermission(
      postPermission("tc-unknown", { approved: true }),
      "tc-unknown",
      OWNER_USER,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /api/projects/:id/tool-permission-mode", () => {
  test("returns 'yolo' (DEFAULT_PERMISSION_MODE) when no setting exists", async () => {
    const res = await handleGetPermissionMode(getMode("proj-1"), "proj-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "yolo" });
  });

  test("returns stored mode when set", async () => {
    settingsStore["project:proj-2:tool_permission_mode"] = "yolo";

    const res = await handleGetPermissionMode(getMode("proj-2"), "proj-2");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "yolo" });
  });
});

describe("PUT /api/projects/:id/tool-permission-mode", () => {
  test("sets mode and persists", async () => {
    const res = await handleSetPermissionMode(
      putMode("proj-3", { mode: "auto-edit" }),
      "proj-3",
      OWNER_USER,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(settingsStore["project:proj-3:tool_permission_mode"]).toBe("auto-edit");
  });

  test("rejects invalid mode -> returns 400", async () => {
    const res = await handleSetPermissionMode(
      putMode("proj-4", { mode: "invalid" }),
      "proj-4",
      OWNER_USER,
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("mode must be one of");
  });

  test("rejects missing body -> returns 400", async () => {
    const req = new Request("http://localhost/api/projects/proj-5/tool-permission-mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await handleSetPermissionMode(req, "proj-5", OWNER_USER);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid JSON");
  });

  test("calls onModeChange callback with mode and conversationId", async () => {
    let callbackMode: string | undefined;
    let callbackConvId: string | undefined;
    const res = await handleSetPermissionMode(
      putMode("proj-6", { mode: "yolo", conversationId: "conv-owner" }),
      "proj-6",
      OWNER_USER,
      { onModeChange: (mode, convId) => { callbackMode = mode; callbackConvId = convId; } },
    );

    expect(res.status).toBe(200);
    expect(callbackMode).toBe("yolo");
    expect(callbackConvId).toBe("conv-owner");
  });

  test("onModeChange is NOT called when no conversationId is provided", async () => {
    // The callback's `conversationId` is a required string, so a project-wide
    // change has nothing to address the live-switch event to and must not
    // fire one. (It used to fire with `undefined` and the route filtered it.)
    let called = false;
    const res = await handleSetPermissionMode(
      putMode("proj-7", { mode: "ask" }),
      "proj-7",
      OWNER_USER,
      { onModeChange: () => { called = true; } },
    );

    expect(res.status).toBe(200);
    expect(called).toBe(false);
    expect(settingsStore["project:proj-7:tool_permission_mode"]).toBe("ask");
  });
});

describe("pending permissions and refresh restore", () => {
  test("gate API call for already-resolved gate is a no-op", async () => {
    // updated for sec-H2 — gate owns a conversation, and both calls go
    // through the owning user. The second call hits the "no pending gate"
    // branch and returns 200 without the ownership check firing.
    const gate = createPermissionGate("tc-already-resolved", "conv-owner");
    const res1 = await handleToolPermission(
      postPermission("tc-already-resolved", { approved: true }),
      "tc-already-resolved",
      OWNER_USER,
    );
    expect(res1.status).toBe(200);
    await gate;

    // Call again for the same toolCallId — should be a 200 no-op
    const res2 = await handleToolPermission(
      postPermission("tc-already-resolved", { approved: true }),
      "tc-already-resolved",
      OWNER_USER,
    );
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true });
  });
});

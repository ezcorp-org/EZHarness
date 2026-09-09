import { beforeEach, expect, test, vi } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const mocks = vi.hoisted(() => ({ updateExtension: vi.fn(), upsertSetting: vi.fn(), insertAuditEntry: vi.fn() }));
vi.mock("$server/db/queries/extensions", () => mocks);
vi.mock("$server/db/queries/settings", () => mocks);
vi.mock("$server/db/queries/audit-log", () => mocks);
import { POST } from "../routes/api/extensions/[id]/reapprove/+server";

beforeEach(() => vi.clearAllMocks());
test("retired TTL consent cannot change persisted grants, preferences, or audit", async () => {
  const response = await POST(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove", {
    params: { id: "ext-1" }, locals: { user: { id: "owner", role: "admin" } },
    request: { method: "POST", body: JSON.stringify({ capability: "shell", scope: "forever" }) },
  }));
  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({ code: "extension_v4_required" });
  expect(mocks.updateExtension).not.toHaveBeenCalled();
  expect(mocks.upsertSetting).not.toHaveBeenCalled();
  expect(mocks.insertAuditEntry).not.toHaveBeenCalled();
});

test("reapprove requires authentication and extensions scope before it can inspect consent", async () => {
  let unauthenticated: Response | undefined;
  try {
    await POST(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove", {
      params: { id: "ext-1" }, request: { method: "POST", body: JSON.stringify({ capability: "shell" }) },
    }));
    expect.fail("unauthenticated reapproval must throw a 401 Response");
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    unauthenticated = error as Response;
  }
  expect(unauthenticated!.status).toBe(401);
  const scopedOut = await POST(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove", {
    params: { id: "ext-1" }, locals: { user: { id: "owner", role: "admin" }, apiKeyScopes: ["read"] }, request: { method: "POST", body: JSON.stringify({ capability: "shell" }) },
  }));
  expect(scopedOut.status).toBe(403);
  expect(mocks.updateExtension).not.toHaveBeenCalled();
  expect(mocks.upsertSetting).not.toHaveBeenCalled();
  expect(mocks.insertAuditEntry).not.toHaveBeenCalled();
});

test("retired reapproval does not parse malformed or oversized consent payloads", async () => {
  for (const body of ["{", "x".repeat(65_537), JSON.stringify({ capability: "shell", scope: "forever", ttlOverrideMs: Number.NaN })]) {
    const response = await POST(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove", {
      params: { id: "ext-1" }, locals: { user: { id: "owner", role: "admin" } }, request: { method: "POST", body },
    }));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "extension_v4_required" });
  }
  expect(mocks.updateExtension).not.toHaveBeenCalled();
  expect(mocks.upsertSetting).not.toHaveBeenCalled();
  expect(mocks.insertAuditEntry).not.toHaveBeenCalled();
});

test("retired reapproval returns a release-specific review location only for an installation id", async () => {
  const named = await POST(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove", {
    params: { id: "ext-1" }, locals: { user: { id: "owner", role: "admin" } }, request: { method: "POST", body: "{}" },
  }));
  expect(named.status).toBe(410);
  expect(await named.json()).toMatchObject({ reviewUrl: "/extensions/author?installation=ext-1" });
  const absent = await POST(makeRequestEvent("http://localhost/api/extensions/reapprove", {
    params: { id: "" }, locals: { user: { id: "owner", role: "admin" } }, request: { method: "POST", body: "{}" },
  }));
  expect(absent.status).toBe(410);
  expect(await absent.json()).toMatchObject({ controlUrl: "/api/extensions/control", openUrl: "/extensions/author" });
  expect(mocks.updateExtension).not.toHaveBeenCalled();
  expect(mocks.upsertSetting).not.toHaveBeenCalled();
  expect(mocks.insertAuditEntry).not.toHaveBeenCalled();
});

import { approval, approvalEvent, setupApprovalRoute } from "./helpers/release-approval-route-fixture";
import { POST as approve } from "../routes/api/extensions/releases/[installationId]/approve/+server";
setupApprovalRoute();

test("human rejection targets the pending release without changing its decision to approval", async () => {
  approval.mockResolvedValue({ status: "denied" });
  const response = await approve(approvalEvent({ approvalId: "replacement", decision: false }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "denied" });
  expect(approval).toHaveBeenCalledExactlyOnceWith({ principalId: "user", scope: "global", kind: "human" }, "installation", "replacement", false);
});

test("a stale release approval stays a conflict and cannot be silently retried", async () => {
  approval.mockRejectedValue({ code: "stale_approval", message: "Release changed." });
  const response = await approve(approvalEvent({ approvalId: "stale", decision: true }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "stale_approval" });
  expect(approval).toHaveBeenCalledTimes(1);
});

test("approval failure hides private database details", async () => {
  approval.mockRejectedValue(new Error("database credential=private"));
  const response = await approve(approvalEvent({ approvalId: "approval", decision: true }));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ code: "extension_failed", message: "Extension operation failed." });
});

import { beforeEach, expect, test, vi } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const mocks = vi.hoisted(() => ({ previewBundledDrift: vi.fn(), reapproveBundledDrift: vi.fn(), updateExtension: vi.fn() }));
vi.mock("$server/extensions/bundled-drift-reapprove", () => mocks);
vi.mock("$server/db/queries/extensions", () => mocks);
import { GET, POST } from "../routes/api/extensions/[id]/reapprove-drift/+server";

beforeEach(() => vi.clearAllMocks());
for (const [method, handler] of [["GET", GET], ["POST", POST]] as const) {
  test(`${method} never evaluates disk config or changes grants, even for administrators`, async () => {
    for (const role of ["admin", "member"]) {
      const response = await handler(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove-drift", { params: { id: "ext-1" }, locals: { user: { id: "owner", role } }, request: { method } }));
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ reviewUrl: "/extensions/author?installation=ext-1" });
    }
    expect(mocks.previewBundledDrift).not.toHaveBeenCalled();
    expect(mocks.reapproveBundledDrift).not.toHaveBeenCalled();
    expect(mocks.updateExtension).not.toHaveBeenCalled();
  });
  test(`${method} requires authentication`, async () => {
    const response = await handler(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove-drift", { params: { id: "ext-1" }, request: { method } }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });
}

for (const [method, handler] of [["GET", GET], ["POST", POST]] as const) {
  test(`${method} rejects an API key without extensions scope before the retired route`, async () => {
    const response = await handler(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove-drift", {
      params: { id: "ext-1" }, locals: { user: { id: "owner", role: "admin" }, apiKeyScopes: ["read"] }, request: { method },
    }));
    expect(response.status).toBe(403);
    expect(mocks.previewBundledDrift).not.toHaveBeenCalled();
    expect(mocks.reapproveBundledDrift).not.toHaveBeenCalled();
    expect(mocks.updateExtension).not.toHaveBeenCalled();
  });

  test(`${method} accepts extensions-scoped API keys only to return the V4 review location`, async () => {
    const response = await handler(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove-drift", {
      params: { id: "ext-1" }, locals: { user: { id: "owner", role: "admin" }, apiKeyScopes: ["extensions"] }, request: { method },
    }));
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body).toMatchObject({ code: "extension_v4_required" });
    expect(body).toMatchObject({ reviewUrl: "/extensions/author?installation=ext-1" });
    expect(mocks.previewBundledDrift).not.toHaveBeenCalled();
    expect(mocks.reapproveBundledDrift).not.toHaveBeenCalled();
    expect(mocks.updateExtension).not.toHaveBeenCalled();
  });

  test(`${method} does not treat a foreign or malformed identifier as disk input`, async () => {
    for (const id of ["foreign-installation", "../outside", "", "not-a-bundled-name"]) {
      const response = await handler(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove-drift", {
        params: { id }, locals: { user: { id: "owner", role: "admin" } }, request: { method },
      }));
      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body).toMatchObject({ code: "extension_v4_required" });
      if (id) expect(body).toMatchObject({ reviewUrl: `/extensions/author?installation=${encodeURIComponent(id)}` });
      else expect(body).toMatchObject({ controlUrl: "/api/extensions/control", openUrl: "/extensions/author" });
    }
    expect(mocks.previewBundledDrift).not.toHaveBeenCalled();
    expect(mocks.reapproveBundledDrift).not.toHaveBeenCalled();
    expect(mocks.updateExtension).not.toHaveBeenCalled();
  });
}

// Drift review keeps the persisted installation owner and scope.
const actorMocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("$server/db/connection", () => ({ getDb: () => ({}) }));
vi.mock("$server/db/queries/extension-releases", () => ({ DatabaseLifecycleRepository: class { read = actorMocks.read; } }));
import { resolveControlActor } from "$lib/server/extensions/control-actor";
beforeEach(() => { vi.clearAllMocks(); actorMocks.read.mockResolvedValue({ installation: { ownerId: "owner", scope: "project:owned" } }); });

test("no target uses global scope without reading installation data", async () => {
  expect(await resolveControlActor({ id: "owner", role: "member" }, "human")).toEqual({ principalId: "owner", scope: "global", kind: "human" });
  expect(actorMocks.read).not.toHaveBeenCalled();
});
test("owner and administrator receive only the stored target scope", async () => {
  for (const user of [{ id: "owner", role: "member" }, { id: "admin", role: "admin" }]) expect(await resolveControlActor(user, "human", "installation")).toEqual({ principalId: user.id, scope: "project:owned", kind: "human" });
  expect(actorMocks.read).toHaveBeenCalledWith("installation");
});
test("foreign and missing installations have the same non-disclosing refusal", async () => {
  await expect(resolveControlActor({ id: "stranger", role: "member" }, "agent", "installation")).rejects.toMatchObject({ code: "not_found", message: "Installation not found." });
  actorMocks.read.mockResolvedValue(null);
  await expect(resolveControlActor({ id: "owner", role: "member" }, "human", "missing")).rejects.toMatchObject({ code: "not_found", message: "Installation not found." });
});

test("a stored global installation preserves agent identity during drift inspection", async () => {
  actorMocks.read.mockResolvedValue({ installation: { ownerId: "owner", scope: "global" } });
  expect(await resolveControlActor({ id: "owner", role: "member" }, "agent", "global-installation")).toEqual({ principalId: "owner", scope: "global", kind: "agent" });
  expect(actorMocks.read).toHaveBeenCalledWith("global-installation");
});

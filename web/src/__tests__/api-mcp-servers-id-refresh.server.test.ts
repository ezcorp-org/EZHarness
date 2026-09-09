import { describe, expect, test } from "vitest";
import { actor, admin, candidate, mcpRouteFixture, mcpStage } from "./helpers/mcp-stage-route-tests";

const { POST } = await import("../routes/api/mcp-servers/[id]/refresh/+server");

describe("POST /api/mcp-servers/[id]/refresh stages a rebuilt v4 candidate", () => {
  const { call } = mcpRouteFixture("refresh", POST);
  test("requires an administrator session and rejects API-key authority", async () => {
    expect((await call({ locals: {} })).status).toBe(401);
    expect((await call({ locals: { ...admin, user: { ...admin.user, role: "user" } } })).status).toBe(403);
    expect((await call({ locals: { ...admin, authMethod: "api-key", apiKey: { scopes: ["*"] } } })).status).toBe(403);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects an empty installation identifier before staging", async () => {
    expect((await call({ id: "" })).status).toBe(400); expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects an omitted installation identifier before staging", async () => {
    expect((await call({ id: null })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("does not grant refresh authority to a read-scoped API key", async () => {
    const response = await call({ locals: { ...admin, authMethod: "api-key", apiKey: { scopes: ["read"] } } });
    expect(response.status).toBe(403);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("does not grant refresh authority to an admin-scoped API key", async () => {
    const response = await call({ locals: { ...admin, authMethod: "api-key", apiKey: { scopes: ["admin"] } } });
    expect(response.status).toBe(403);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("returns the staged candidate revision for a valid refresh", async () => {
    const response = await call({ id: "current" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ installationId: "installation", revision: 1 });
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, "current");
  });
  test("does not parse a refresh request body into the staged operation", async () => {
    const response = await call({ body: { server: { transport: "stdio", command: "host-exec" } } });
    expect(response.status).toBe(202);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, "installation");
  });
  test("stages a refreshed candidate without executing or mutating the active catalog", async () => {
    const response = await call();
    expect(response.status).toBe(202); expect(await response.json()).toEqual(candidate);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, "installation");
  });
  test("redacts unsafe refresh failures and preserves revision conflicts", async () => {
    mcpStage.mockRejectedValueOnce(new Error("tools/list failed for token=secret"));
    const unsafe = await call();
    expect(unsafe.status).toBe(500); expect(await unsafe.json()).toEqual({ code: "extension_failed", message: "Extension operation failed." });
    mcpStage.mockRejectedValueOnce(Object.assign(new Error("Workspace revision changed"), { code: "revision_conflict" }));
    expect((await call()).status).toBe(409); expect(mcpStage).toHaveBeenCalledTimes(2);
  });
  test("redacts thrown non-Error refresh values", async () => {
    mcpStage.mockRejectedValueOnce("private endpoint token=secret");
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "extension_failed", message: "Extension operation failed." });
  });
});

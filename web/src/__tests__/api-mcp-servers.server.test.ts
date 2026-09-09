import { describe, expect, test } from "vitest";
import { actor, admin, candidate, mcpRouteFixture, mcpStage, server } from "./helpers/mcp-stage-route-tests";

const { POST } = await import("../routes/api/mcp-servers/+server");

describe("POST /api/mcp-servers stages a v4 source candidate", () => {
  const { call, validBody } = mcpRouteFixture("install", POST);
  test("requires an administrator session and rejects API-key authority", async () => {
    expect((await call({ locals: {} })).status).toBe(401);
    expect((await call({ locals: { ...admin, user: { ...admin.user, role: "user" } } })).status).toBe(403);
    for (const scope of ["read", "admin", "*"]) expect((await call({ locals: { ...admin, authMethod: "api-key", apiKey: { scopes: [scope] } } })).status).toBe(403);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects malformed, oversized, and unsafe source declarations before staging", async () => {
    for (const body of [{ server }, { name: "../escape", server }, { name: "remote", server: { ...server, transport: "unknown" } }]) expect((await call({ body })).status).toBe(400);
    expect((await call({ raw: "{" })).status).toBe(400);
    expect((await call({ raw: " ".repeat(65_537) })).status).toBe(413);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects an install without a source name", async () => {
    expect((await call({ body: { server } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects uppercase source names", async () => {
    expect((await call({ body: { name: "Remote", server } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects source names longer than the immutable release limit", async () => {
    expect((await call({ body: { name: "r".repeat(65), server } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects HTTP sources without an absolute URL", async () => {
    expect((await call({ body: { name: "remote", server: { ...server, url: "/mcp" } } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects stdio sources without an executable", async () => {
    expect((await call({ body: { name: "remote", server: { transport: "stdio", name: "remote", command: "" } } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("passes a submitted HTTP credential declaration only to the candidate stage", async () => {
    const body = { name: "remote", server: { ...server, headers: { Authorization: "replacement" } } };
    expect((await call({ body })).status).toBe(202);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, body);
  });
  test("passes a submitted stdio source only to the candidate stage", async () => {
    const body = { name: "remote", server: { transport: "stdio", name: "remote", command: "node", args: ["server.js", "--token="], env: { KEY: "" } } };
    expect((await call({ body })).status).toBe(202);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, body);
  });
  test("passes a submitted SSE source only to the candidate stage", async () => {
    const body = { name: "remote", server: { transport: "sse", name: "remote", url: "https://other.example/mcp", headers: {} } };
    expect((await call({ body })).status).toBe(202);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, body);
  });
  test("stages the submitted source as an immutable candidate without legacy catalog mutation", async () => {
    const response = await call();
    expect(response.status).toBe(202); expect(await response.json()).toEqual(candidate);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, validBody());
  });
  test("redacts unsafe staging failures and preserves revision conflicts", async () => {
    mcpStage.mockRejectedValueOnce(new Error("SSRF denied http://10.0.0.1?token=secret"));
    const unsafe = await call();
    expect(unsafe.status).toBe(500); expect(await unsafe.json()).toEqual({ code: "extension_failed", message: "Extension operation failed." });
    mcpStage.mockRejectedValueOnce(Object.assign(new Error("Workspace revision changed"), { code: "revision_conflict" }));
    expect((await call()).status).toBe(409); expect(mcpStage).toHaveBeenCalledTimes(2);
  });
  test("redacts thrown non-Error staging values", async () => {
    mcpStage.mockRejectedValueOnce("secret");
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "extension_failed", message: "Extension operation failed." });
  });
  test("empty credentials are passed as explicit replacements without active secret hydration", async () => {
    const body = { name: "remote", server: { ...server, url: "https://example.com/mcp?key=", headers: { Authorization: "" } } };
    expect((await call({ body })).status).toBe(202);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, body);
  });

});

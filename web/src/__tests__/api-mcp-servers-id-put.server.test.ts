import { describe, expect, test } from "vitest";
import { actor, admin, candidate, mcpRouteFixture, mcpStage, server } from "./helpers/mcp-stage-route-tests";

const { PUT } = await import("../routes/api/mcp-servers/[id]/+server");

describe("PUT /api/mcp-servers/[id] stages a revised v4 source candidate", () => {
  const { call, validBody } = mcpRouteFixture("update", PUT);
  test("accepts only an administrator session before it can restage", async () => {
    expect((await call({ locals: {} })).status).toBe(401);
    expect((await call({ locals: { ...admin, authMethod: "api-key", apiKey: { scopes: ["admin"] } } })).status).toBe(403);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects missing identifiers and malformed or oversized replacement sources", async () => {
    expect((await call({ id: "" })).status).toBe(400);
    expect((await call({ body: { server: { ...server, url: "invalid" } } })).status).toBe(400);
    expect((await call({ raw: "{" })).status).toBe(400);
    expect((await call({ raw: " ".repeat(65_537) })).status).toBe(413);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects an update without a source declaration", async () => {
    expect((await call({ body: {} })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects an update with an unknown transport", async () => {
    expect((await call({ body: { server: { ...server, transport: "pipe" } } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects an HTTP update without a source name", async () => {
    expect((await call({ body: { server: { transport: "http", name: "", url: server.url } } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects an SSE update without an absolute URL", async () => {
    expect((await call({ body: { server: { transport: "sse", name: "remote", url: "mcp" } } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects a stdio update without an executable", async () => {
    expect((await call({ body: { server: { transport: "stdio", name: "remote", command: "" } } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects a stdio update with a non-string argument", async () => {
    expect((await call({ body: { server: { transport: "stdio", name: "remote", command: "node", args: [1] } } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("rejects HTTP headers with non-string values", async () => {
    expect((await call({ body: { server: { ...server, headers: { Authorization: 1 } } } })).status).toBe(400);
    expect(mcpStage).not.toHaveBeenCalled();
  });
  test("stages an HTTP replacement with submitted credentials intact", async () => {
    const body = { server: { ...server, headers: { Authorization: "replacement" } } };
    expect((await call({ body })).status).toBe(202);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, "installation", body);
  });
  test("stages an SSE replacement without reading active credentials", async () => {
    const body = { server: { transport: "sse", name: "remote", url: "https://other.example/mcp", headers: {} } };
    expect((await call({ body })).status).toBe(202);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, "installation", body);
  });
  test("stages a stdio replacement without starting a legacy client", async () => {
    const body = { server: { transport: "stdio", name: "remote", command: "node", args: ["server.js", "--token="], env: { KEY: "" } } };
    expect((await call({ body })).status).toBe(202);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, "installation", body);
  });
  test("passes a submitted description with the replacement source", async () => {
    const body = { description: "revised source", server };
    expect((await call({ body })).status).toBe(202);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, "installation", body);
  });
  test("stages the exact submitted replacement without mutating the legacy catalog", async () => {
    const response = await call();
    expect(response.status).toBe(202); expect(await response.json()).toEqual(candidate);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, "installation", validBody());
  });
  test("redacts unsafe restage errors and returns revision conflicts without retry", async () => {
    mcpStage.mockRejectedValueOnce("database password=secret");
    const unsafe = await call();
    expect(unsafe.status).toBe(500); expect(await unsafe.json()).toEqual({ code: "extension_failed", message: "Extension operation failed." });
    mcpStage.mockRejectedValueOnce(Object.assign(new Error("Workspace revision changed"), { code: "revision_conflict" }));
    expect((await call()).status).toBe(409); expect(mcpStage).toHaveBeenCalledTimes(2);
  });
  test("redacts thrown non-Error restage values", async () => {
    mcpStage.mockRejectedValueOnce("credential=secret");
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "extension_failed", message: "Extension operation failed." });
  });
  test("empty credentials are passed as explicit replacements without active secret hydration", async () => {
    const body = { server: { ...server, url: "https://example.com/mcp?key=", headers: { Authorization: "" } } };
    expect((await call({ body })).status).toBe(202);
    expect(mcpStage).toHaveBeenCalledExactlyOnceWith(actor, "installation", body);
  });

});

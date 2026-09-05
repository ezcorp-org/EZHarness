import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeRequestEvent } from "./server-route-test-utils";

const mcpStage = vi.hoisted(() => vi.fn());
const legacy = vi.hoisted(() => ({
  installMcpExtension: vi.fn(), updateMcpExtension: vi.fn(), getExtension: vi.fn(),
  rehydrateMcpServerSecrets: vi.fn(), reload: vi.fn(), refreshMcpTools: vi.fn(), connect: vi.fn(),
}));
vi.mock("$server/extensions/mcp-control", () => ({ stageMcpExtension: mcpStage, restageMcpExtension: mcpStage }));
vi.mock("$server/db/queries/extensions", () => legacy);
vi.mock("$server/extensions/registry", () => ({ ExtensionRegistry: { getInstance: () => legacy } }));
vi.mock("$server/mcp/client", () => ({ McpClient: class { connect = legacy.connect; } }));

const admin = { user: { id: "admin-1", name: "Admin", email: "admin@example.com", role: "admin", status: "active" }, authMethod: "session" };
const candidate = { installationId: "installation", workspaceId: "candidate", revision: 1, operationId: "build", openUrl: "/extensions/author/candidate" };
const server = { transport: "http", name: "remote", url: "https://example.com/mcp" };

export function mcpRouteTests(kind: "install" | "update" | "refresh", handler: (event: any) => Response | Promise<Response>) {
  const validBody = () => kind === "install" ? { name: "remote", server } : { server };
  function call(options: { locals?: Record<string, unknown>; body?: unknown; raw?: string; id?: string } = {}) {
    return handler(makeRequestEvent("http://localhost/api/mcp-servers/installation", {
      locals: options.locals ?? admin,
      params: { id: options.id ?? "installation" },
      request: { method: kind === "update" ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: options.raw ?? JSON.stringify(options.body ?? validBody()) },
    }));
  }
  describe(`MCP ${kind} stages an immutable candidate`, () => {
    beforeEach(() => { vi.clearAllMocks(); mcpStage.mockReset(); mcpStage.mockResolvedValue(candidate); });
    afterEach(() => { for (const spy of Object.values(legacy)) expect(spy).not.toHaveBeenCalled(); });
    test("rejects missing authentication without staging", async () => {
      expect((await call({ locals: {} })).status).toBe(401);
      expect(mcpStage).not.toHaveBeenCalled();
    });
    test("rejects non-admin sessions without staging", async () => {
      expect((await call({ locals: { ...admin, user: { ...admin.user, role: "user" } } })).status).toBe(403);
      expect(mcpStage).not.toHaveBeenCalled();
    });
    test.each([["read"], ["admin"], ["*"]])("rejects API keys even with scope %s", async scope => {
      expect((await call({ locals: { ...admin, authMethod: "api-key", apiKey: { scopes: [scope] } } })).status).toBe(403);
      expect(mcpStage).not.toHaveBeenCalled();
    });
    test("returns 202 without changing active catalog or spawning legacy clients", async () => {
      const response = await call();
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(candidate);
      const actor = { principalId: "admin-1", scope: "global", kind: "human" };
      expect(mcpStage).toHaveBeenCalledExactlyOnceWith(...(kind === "install" ? [actor, validBody()] : kind === "update" ? [actor, "installation", validBody()] : [actor, "installation"]));
    });
    test.each(["ECONNREFUSED 127.0.0.1:123", "SSRF denied http://10.0.0.1?token=secret", "tools/list failed", "database password=secret"])("redacts internal failure %s", async message => {
      mcpStage.mockRejectedValueOnce(new Error(message));
      const response = await call();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: "extension_failed", message: "Extension operation failed." });
    });
    test("redacts thrown values that are not errors", async () => {
      mcpStage.mockRejectedValueOnce("secret");
      expect(await (await call()).json()).toEqual({ code: "extension_failed", message: "Extension operation failed." });
    });
    test("propagates safe lifecycle conflicts without retrying or activating", async () => {
      mcpStage.mockRejectedValueOnce(Object.assign(new Error("Workspace revision changed"), { code: "revision_conflict" }));
      const response = await call();
      expect(response.status).toBe(409);
      expect(mcpStage).toHaveBeenCalledTimes(1);
    });
    if (kind !== "install") test("rejects an empty installation id before staging", async () => {
      expect((await call({ id: "" })).status).toBe(400);
      expect(mcpStage).not.toHaveBeenCalled();
    });
    if (kind !== "refresh") {
      test.each([
        { server: { ...server, transport: "unknown" } },
        { server: { ...server, url: "invalid" } },
        { server: { transport: "stdio", name: "remote", command: "" } },
      ])("rejects invalid connection declarations", async body => {
        expect((await call({ body: { name: "remote", ...body } })).status).toBe(400);
        expect(mcpStage).not.toHaveBeenCalled();
      });
      test("rejects malformed JSON before staging", async () => {
        expect((await call({ raw: "{" })).status).toBe(400);
        expect(mcpStage).not.toHaveBeenCalled();
      });
      test("bounds request bytes before staging", async () => {
        expect((await call({ raw: " ".repeat(65_537) })).status).toBe(413);
        expect(mcpStage).not.toHaveBeenCalled();
      });
      test.each([
        { ...server, headers: { Authorization: "" }, url: "https://example.com/mcp?key=" },
        { ...server, headers: { Authorization: "replacement" } },
        { transport: "stdio", name: "remote", command: "bun", args: ["server.js", "--token="], env: { KEY: "" } },
        { transport: "sse", name: "remote", url: "https://other.example/mcp", headers: {} },
      ])("passes candidate credentials unchanged without reading or transferring active secrets", async connection => {
        const body = { ...(kind === "install" ? { name: "remote" } : {}), server: connection };
        expect((await call({ body })).status).toBe(202);
        expect(mcpStage.mock.calls[0]?.at(-1)).toEqual(body);
      });
    }
    if (kind === "install") test("requires a safe immutable extension name", async () => {
      for (const body of [{ server }, { name: "../escape", server }]) {
        expect((await call({ body })).status).toBe(400);
      }
      expect(mcpStage).not.toHaveBeenCalled();
    });
  });
}

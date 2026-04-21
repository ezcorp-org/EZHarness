/**
 * MCP API Route Integration Tests
 *
 * Exercises the actual SvelteKit handlers for:
 *   POST /api/mcp-servers
 *   POST /api/mcp-servers/[id]/refresh
 *
 * Uses a real stdio MCP server spawned as a subprocess so the full
 * handler → McpClient → SDK → server round-trip is exercised.
 * DB, registry, and validation all run for real against PGlite.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER, MEMBER_USER } from "./helpers/mock-request";
import { makeStdioMcpServer } from "./helpers/stdio-mcp-fixture";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockDbConnection();
mockServerAlias();

mock.module("$server/db/queries/extensions", () => require("../db/queries/extensions"));
mock.module("$server/extensions/registry", () => require("../extensions/registry"));
mock.module("$server/mcp/client", () => require("../mcp/client"));
mock.module("../../web/src/routes/api/mcp-servers/$types", () => ({}));
mock.module("../../web/src/routes/api/mcp-servers/[id]/refresh/$types", () => ({}));

// ── Handler imports ──────────────────────────────────────────────
import { POST as installPOST } from "../../web/src/routes/api/mcp-servers/+server";
import { POST as refreshPOST } from "../../web/src/routes/api/mcp-servers/[id]/refresh/+server";

import { ExtensionRegistry } from "../extensions/registry";
import { listExtensions, deleteExtension, getExtensionByName } from "../db/queries/extensions";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  ExtensionRegistry.resetInstance();
  for (const ext of await listExtensions()) await deleteExtension(ext.id);
});

describe("POST /api/mcp-servers", () => {
  test("requires admin role", async () => {
    const fixture = makeStdioMcpServer();
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: MEMBER_USER,
      body: {
        name: "role-check",
        server: { transport: "stdio", name: "role-check", command: fixture.command, args: fixture.args },
      },
    });
    try {
      await installPOST(event);
      throw new Error("expected to throw");
    } catch (e) {
      expect((e as Response).status).toBe(403);
    }
  });

  test("rejects missing body fields with validation error", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: { server: { transport: "stdio", name: "n" } }, // missing name + command
    });
    const res = await installPOST(event);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("rejects unknown transport value", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "nope",
        server: { transport: "carrier-pigeon", name: "n", url: "x" },
      },
    });
    const res = await installPOST(event);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("returns 502 when MCP server closes the connection immediately", async () => {
    const fixture = makeStdioMcpServer({ throwOnConnect: true });
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "route-502",
        server: { transport: "stdio", name: "route-502", command: fixture.command, args: fixture.args },
      },
    });
    const res = await installPOST(event);
    expect(res.status).toBe(502);
    const body = await jsonFromResponse(res);
    expect(typeof body.error).toBe("string");
    expect(body.error.toLowerCase()).toContain("mcp connect failed");
    // Nothing persisted
    expect(await getExtensionByName("route-502")).toBeNull();
  }, 15_000);

  test("happy path: creates row, persists cached tools, reloads registry, returns 201", async () => {
    const fixture = makeStdioMcpServer({
      tools: [
        { name: "ping", description: "Ping tool" },
        { name: "pong", description: "Pong tool" },
      ],
    });
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "route-ok",
        description: "Happy path",
        server: { transport: "stdio", name: "route-ok", command: fixture.command, args: fixture.args },
      },
    });
    const res = await installPOST(event);
    expect(res.status).toBe(201);
    const body = await jsonFromResponse(res);
    expect(body.name).toBe("route-ok");
    expect(body.manifest.kind).toBe("mcp");
    expect(body.manifest.tools).toHaveLength(2);
    expect(body.manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(["ping", "pong"]);

    const registry = ExtensionRegistry.getInstance();
    expect(registry.getToolExtension("route-ok__ping")).toBe(body.id);
    expect(registry.getToolExtension("route-ok__pong")).toBe(body.id);

    ExtensionRegistry.resetInstance(); // closes the MCP client spawned by reload
  }, 15_000);

  test("400 on duplicate name (caught after successful MCP connect)", async () => {
    const fixture = makeStdioMcpServer();

    const first = createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "route-dup",
        server: { transport: "stdio", name: "route-dup", command: fixture.command, args: fixture.args },
      },
    });
    const firstRes = await installPOST(first);
    expect(firstRes.status).toBe(201);

    const second = createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "route-dup",
        server: { transport: "stdio", name: "route-dup", command: fixture.command, args: fixture.args },
      },
    });
    const secondRes = await installPOST(second);
    expect(secondRes.status).toBe(400);

    ExtensionRegistry.resetInstance();
  }, 15_000);
});

describe("POST /api/mcp-servers/[id]/refresh", () => {
  test("requires admin role", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers/x/refresh",
      user: MEMBER_USER,
      params: { id: "x" },
    });
    try {
      await refreshPOST(event);
      throw new Error("expected to throw");
    } catch (e) {
      expect((e as Response).status).toBe(403);
    }
  });

  test("returns 502 when registry.refreshMcpTools throws (unknown id)", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers/unknown/refresh",
      user: ADMIN_USER,
      params: { id: "unknown" },
    });
    const res = await refreshPOST(event);
    expect(res.status).toBe(502);
  });

  test("happy path: picks up updated tool list from MCP server", async () => {
    // Install an extension with an initial tool
    const fixtureA = makeStdioMcpServer({
      tools: [{ name: "old", description: "old" }],
    });
    const installRes = await installPOST(createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "refresh-live",
        server: { transport: "stdio", name: "refresh-live", command: fixtureA.command, args: fixtureA.args },
      },
    }));
    expect(installRes.status).toBe(201);
    const installed = await jsonFromResponse(installRes);

    // Swap the manifest.mcpServers command to point at a server exposing
    // new tools. We edit the in-memory manifest directly on the registry
    // so refreshMcpTools constructs a fresh McpClient against the new spec.
    const fixtureB = makeStdioMcpServer({
      tools: [
        { name: "new-a", description: "na" },
        { name: "new-b", description: "nb" },
      ],
    });
    const registry = ExtensionRegistry.getInstance();
    const m = registry.getManifest(installed.id)!;
    registry.setManifestForTest(installed.id, {
      ...m,
      mcpServers: [{ transport: "stdio", name: "refresh-live", command: fixtureB.command, args: fixtureB.args }],
    });
    // Drop any cached client so the next getMcpClient spawns a new one
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (registry as any).mcpClients.delete(installed.id);

    const refEvent = createMockEvent({
      method: "POST",
      url: `http://localhost/api/mcp-servers/${installed.id}/refresh`,
      user: ADMIN_USER,
      params: { id: installed.id },
    });
    const res = await refreshPOST(refEvent);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.id).toBe(installed.id);
    expect(body.tools).toHaveLength(2);
    expect(body.tools.map((t: { name: string }) => t.name).sort()).toEqual(["new-a", "new-b"]);

    ExtensionRegistry.resetInstance();
  }, 20_000);
});

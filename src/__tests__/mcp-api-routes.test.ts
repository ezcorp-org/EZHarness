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
// B4 — the audit leg the three handlers now write through. Real modules, so
// the rows really land in PGlite and the assertions below read the same
// table the audit UI does.
mock.module("$server/extensions/audit-actions", () => require("../extensions/audit-actions"));
mock.module("$server/extensions/mcp-audit", () => require("../extensions/mcp-audit"));
mock.module("../../web/src/routes/api/mcp-servers/$types", () => ({}));
mock.module("../../web/src/routes/api/mcp-servers/[id]/$types", () => ({}));
mock.module("../../web/src/routes/api/mcp-servers/[id]/refresh/$types", () => ({}));

// ── Handler imports ──────────────────────────────────────────────
import { POST as installPOST } from "../../web/src/routes/api/mcp-servers/+server";
import { PUT as editPUT } from "../../web/src/routes/api/mcp-servers/[id]/+server";
import { POST as refreshPOST } from "../../web/src/routes/api/mcp-servers/[id]/refresh/+server";

import { ExtensionRegistry } from "../extensions/registry";
import { listExtensions, deleteExtension, getExtensionByName } from "../db/queries/extensions";
import { listAuditLog } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";
import { getTestDb } from "./helpers/test-pglite";
import { users } from "../db/schema";

beforeAll(async () => {
  await setupTestDb();
  // `audit_log.user_id` is an FK to `users`. Without a real row the insert
  // fails, `insertAuditEntry` swallows it by contract, and every audit
  // assertion below would pass vacuously against zero rows — so seed the
  // admin principal the mock events authenticate as.
  await getTestDb()
    .insert(users)
    .values({ id: ADMIN_USER.id, email: ADMIN_USER.email, passwordHash: "x", name: ADMIN_USER.name, role: "admin" })
    .onConflictDoNothing();
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
    // RETURNED, not thrown. The old try/catch asserted a THROWN Response,
    // which SvelteKit renders as a 500 "Internal Error" — so it pinned the
    // bug rather than the 403 it looked like it was checking.
    const res = await installPOST(event);
    expect(res.status).toBe(403);
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
    // RETURNED, not thrown — see the install case above.
    const res = await refreshPOST(event);
    expect(res.status).toBe(403);
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

// ── B4: audit rows for the MCP lifecycle ─────────────────────────────
//
// Every other extension-mutating route wrote an `audit_log` row; these three
// wrote none, so configuring a credentialed connection to a third-party
// server was the one privileged extension mutation with no trail. Each test
// drives the REAL handler against a REAL stdio MCP server and then reads the
// REAL table.
describe("MCP lifecycle audit rows", () => {
  const SECRET = "sk-super-secret-token";

  /** Rows for one action, newest-first, as `listAuditLog` returns them. */
  async function rowsFor(action: string) {
    return listAuditLog({ action, limit: 50 });
  }

  test("install writes one row naming the actor, the connection and the tools", async () => {
    const fixture = makeStdioMcpServer({ tools: [{ name: "ping", description: "p" }] });
    const res = await installPOST(createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "audit-install",
        server: {
          transport: "stdio",
          name: "audit-install",
          command: fixture.command,
          args: fixture.args,
          env: { SOME_API_KEY: SECRET },
        },
      },
    }));
    expect(res.status).toBe(201);
    const ext = await jsonFromResponse(res);

    const rows = (await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_INSTALLED))
      .filter((r) => r.target === ext.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.userId).toBe(ADMIN_USER.id);
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.actor).toBe(ADMIN_USER.id);
    expect(meta.reason).toBe("mcp-install");
    expect(meta.extensionName).toBe("audit-install");
    // Install has no "before" side.
    expect(meta.oldValue).toBeNull();
    const after = meta.newValue as Record<string, unknown>;
    expect(after.transport).toBe("stdio");
    expect(after.toolCount).toBe(1);
    expect(after.toolNames).toEqual(["ping"]);
    // The env KEY is recorded; the value never is.
    expect(after.authKeys).toEqual(["SOME_API_KEY"]);
    expect(JSON.stringify(row.metadata)).not.toContain(SECRET);

    ExtensionRegistry.resetInstance();
  }, 20_000);

  test("edit writes a row carrying BOTH sides so a re-pointed connection is diffable", async () => {
    const v1 = makeStdioMcpServer({ tools: [{ name: "old", description: "o" }] });
    const installed = await jsonFromResponse(await installPOST(createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "audit-edit",
        server: { transport: "stdio", name: "audit-edit", command: v1.command, args: v1.args },
      },
    })));

    const v2 = makeStdioMcpServer({
      tools: [{ name: "new-a", description: "a" }, { name: "new-b", description: "b" }],
    });
    const editRes = await editPUT(createMockEvent({
      method: "PUT",
      url: `http://localhost/api/mcp-servers/${installed.id}`,
      user: ADMIN_USER,
      params: { id: installed.id },
      body: {
        server: { transport: "stdio", name: "audit-edit", command: v2.command, args: v2.args },
      },
    }));
    expect(editRes.status).toBe(200);

    const rows = (await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_UPDATED))
      .filter((r) => r.target === installed.id);
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta.reason).toBe("mcp-update");
    expect(meta.actor).toBe(ADMIN_USER.id);
    const before = meta.oldValue as Record<string, unknown>;
    const after = meta.newValue as Record<string, unknown>;
    // The tool snapshot moved, and so did the argv (a different script path).
    expect(before.toolNames).toEqual(["old"]);
    expect(after.toolNames).toEqual(["new-a", "new-b"]);
    expect(before.transport).toBe("stdio");

    ExtensionRegistry.resetInstance();
  }, 25_000);

  test("refresh writes a row whose before/after differ ONLY in the tool snapshot", async () => {
    const v1 = makeStdioMcpServer({ tools: [{ name: "solo", description: "s" }] });
    const installed = await jsonFromResponse(await installPOST(createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "audit-refresh",
        server: { transport: "stdio", name: "audit-refresh", command: v1.command, args: v1.args },
      },
    })));

    // Re-point the in-memory manifest at a server exposing more tools, the
    // same way the pre-existing refresh happy-path test does.
    const v2 = makeStdioMcpServer({
      tools: [{ name: "one", description: "1" }, { name: "two", description: "2" }],
    });
    const registry = ExtensionRegistry.getInstance();
    const m = registry.getManifest(installed.id)!;
    registry.setManifestForTest(installed.id, {
      ...m,
      mcpServers: [{ transport: "stdio", name: "audit-refresh", command: v2.command, args: v2.args }],
    });
    (registry as unknown as { mcpClients: Map<string, unknown> }).mcpClients.delete(installed.id);

    const res = await refreshPOST(createMockEvent({
      method: "POST",
      url: `http://localhost/api/mcp-servers/${installed.id}/refresh`,
      user: ADMIN_USER,
      params: { id: installed.id },
    }));
    expect(res.status).toBe(200);

    const rows = (await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_REFRESHED))
      .filter((r) => r.target === installed.id);
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta.reason).toBe("mcp-refresh");
    const before = meta.oldValue as Record<string, unknown>;
    const after = meta.newValue as Record<string, unknown>;
    // The connection is untouched by a refresh…
    expect(after.transport).toBe(before.transport);
    expect(after.target).toBe(before.target);
    // …and the snapshot is what moved. This is the regression that the
    // "read the row BEFORE refreshMcpTools writes it back" ordering exists
    // to prevent: read it after and both sides would say ["one","two"].
    expect(before.toolNames).toEqual(["solo"]);
    expect(after.toolNames).toEqual(["one", "two"]);

    ExtensionRegistry.resetInstance();
  }, 25_000);

  test("a failed install (502, nothing persisted) writes NO row", async () => {
    const fixture = makeStdioMcpServer({ throwOnConnect: true });
    const before = (await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_INSTALLED)).length;
    const res = await installPOST(createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: {
        name: "audit-502",
        server: { transport: "stdio", name: "audit-502", command: fixture.command, args: fixture.args },
      },
    }));
    expect(res.status).toBe(502);
    // The trail must never claim an install that did not happen.
    expect((await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_INSTALLED)).length).toBe(before);
  }, 15_000);
});

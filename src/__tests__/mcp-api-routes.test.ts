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
import { listErrors } from "../db/queries/error-logs";
import { getDb } from "../db/connection";
import { errorLogs, users } from "../db/schema";
import { MCP_CONNECT_FAILED_MESSAGE } from "../mcp/connect-failure";
import { MCP_TARGET_ALLOW_ENV } from "../mcp/target-guard";

const allowEnvAtStart = process.env[MCP_TARGET_ALLOW_ENV];

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
  if (allowEnvAtStart === undefined) delete process.env[MCP_TARGET_ALLOW_ENV];
  else process.env[MCP_TARGET_ALLOW_ENV] = allowEnvAtStart;
  await closeTestDb();
});

beforeEach(async () => {
  ExtensionRegistry.resetInstance();
  for (const ext of await listExtensions()) await deleteExtension(ext.id);
  await getDb().delete(errorLogs);
  // The guard reads this per call; a value inherited from the developer's
  // shell must not decide whether these assertions hold.
  delete process.env[MCP_TARGET_ALLOW_ENV];
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
    // The transport's own words used to be echoed here — that was the
    // port-scan oracle. The body is now the one constant.
    expect(body.error).toBe(MCP_CONNECT_FAILED_MESSAGE);
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

describe("POST /api/mcp-servers — SSRF guard + failure-oracle collapse", () => {
  /** Install an http-transport MCP server and return the raw response. */
  function installHttp(name: string, url: string) {
    return installPOST(
      createMockEvent({
        method: "POST",
        url: "http://localhost/api/mcp-servers",
        user: ADMIN_USER,
        body: { name, server: { transport: "http", name, url } },
      }),
    );
  }

  // The targets an SSRF against a self-hosted box actually wants. Each must
  // be refused BEFORE a socket is opened, and must leave no row behind.
  const ssrfTargets: Array<[string, string]> = [
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["metadata via decimal IPv4", "http://2852039166/latest/meta-data/"],
    ["loopback admin API", "http://127.0.0.1:1456/api/settings"],
    ["IPv6 loopback", "http://[::1]:1456/api/settings"],
    ["v4-mapped loopback", "http://[::ffff:127.0.0.1]:6379/"],
    ["internal Redis", "http://10.0.0.5:6379/"],
    ["internal LAN host", "http://192.168.1.50:8080/mcp"],
    ["CGNAT range", "http://100.64.0.1:8080/mcp"],
    ["IPv6 unique-local", "http://[fd00::1]:8080/mcp"],
  ];

  for (const [label, url] of ssrfTargets) {
    test(`refuses ${label} without persisting anything`, async () => {
      const name = `ssrf-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      const res = await installHttp(name, url);

      expect(res.status).toBe(502);
      const body = await jsonFromResponse(res);
      expect(body.error).toBe(MCP_CONNECT_FAILED_MESSAGE);
      // No extension row, so a blocked probe leaves no trace the caller can
      // read back through the extensions API either.
      expect(await getExtensionByName(name)).toBeNull();
      expect(await listExtensions()).toHaveLength(0);
    }, 15_000);
  }

  test("a blocked target and a real connect failure are byte-identical to the caller", async () => {
    // THE oracle test. (a) is refused by the SSRF guard before any socket;
    // (b) is a genuine transport failure from a server that exits on spawn.
    // If these two responses differ in ANY observable way, an admin-scoped
    // key can still separate "internal address" from "unreachable", which is
    // exactly the port-scan primitive the fix removes.
    const blockedRes = await installHttp("oracle-blocked", "http://169.254.169.254/latest/");

    const fixture = makeStdioMcpServer({ throwOnConnect: true });
    const failedRes = await installPOST(
      createMockEvent({
        method: "POST",
        url: "http://localhost/api/mcp-servers",
        user: ADMIN_USER,
        body: {
          name: "oracle-failed",
          server: {
            transport: "stdio",
            name: "oracle-failed",
            command: fixture.command,
            args: fixture.args,
          },
        },
      }),
    );

    expect(blockedRes.status).toBe(failedRes.status);
    expect(await blockedRes.text()).toBe(await failedRes.text());
  }, 15_000);

  test("two different internal targets are indistinguishable from each other", async () => {
    // Closed port vs. a host that is not listening at all vs. metadata:
    // three different underlying outcomes, one response.
    const a = await installHttp("oracle-a", "http://10.0.0.5:6379/");
    const b = await installHttp("oracle-b", "http://192.168.99.99:1/");
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  }, 15_000);

  test("the real reason is still recorded server-side for the admin", async () => {
    await installHttp("ssrf-audited", "http://169.254.169.254/latest/meta-data/");

    const rows = await listErrors();
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    // The response said nothing; the error log says everything.
    expect(meta.blocked).toBe(true);
    expect(meta.reason).toBe("private-address");
    expect(String(meta.target)).toContain("169.254.169.254");
    expect(meta.route).toBe("POST /api/mcp-servers");
    expect(meta.extension).toBe("ssrf-audited");
  }, 15_000);

  test("EZCORP_MCP_TARGET_ALLOW re-opens a private target, and it still fails uniformly", async () => {
    // The self-hosting escape hatch. Bind a port, release it, then point the
    // installer at it: the guard now ALLOWS the target (so the SSRF block is
    // genuinely lifted) and the request dies on a real refused connection —
    // which returns the SAME body as the blocked case. Proving the allowlist
    // works and proving it doesn't reopen the oracle are the same test.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const closedPort = probe.port;
    await probe.stop(true);

    process.env[MCP_TARGET_ALLOW_ENV] = "127.0.0.1";
    const allowedRes = await installHttp("allow-hatch", `http://127.0.0.1:${closedPort}/mcp`);
    expect(allowedRes.status).toBe(502);
    expect((await jsonFromResponse(allowedRes)).error).toBe(MCP_CONNECT_FAILED_MESSAGE);
    expect(await getExtensionByName("allow-hatch")).toBeNull();

    // It reached the transport rather than the guard — that is what makes
    // this an escape hatch and not a no-op.
    const meta = (await listErrors())[0]!.metadata as Record<string, unknown>;
    expect(meta.blocked).toBe(false);
    expect(meta.reason).toBe("connect-error");
  }, 15_000);

  test("the allowlist is scoped — allowing loopback does not allow metadata", async () => {
    process.env[MCP_TARGET_ALLOW_ENV] = "127.0.0.1";
    await installHttp("scoped-allow", "http://169.254.169.254/latest/");

    const meta = (await listErrors())[0]!.metadata as Record<string, unknown>;
    expect(meta.blocked).toBe(true);
    expect(meta.reason).toBe("private-address");
  }, 15_000);

  // NOTE: "a public URL reaches the transport" is asserted in
  // mcp-target-guard.test.ts with an injected resolver, NOT here. The
  // integration form would need a real outbound request, and a backend-pool
  // test that depends on the internet fails for reasons that have nothing to
  // do with this code. The allow-hatch case above already proves the handoff
  // from guard to transport happens for a permitted target.

  test("stdio installs are unaffected by the guard", async () => {
    // stdio has no network target; the sandbox envelope governs its egress.
    // A guard that accidentally caught stdio would break every local MCP.
    const fixture = makeStdioMcpServer({ tools: [{ name: "ping", description: "p" }] });
    const res = await installPOST(
      createMockEvent({
        method: "POST",
        url: "http://localhost/api/mcp-servers",
        user: ADMIN_USER,
        body: {
          name: "stdio-unaffected",
          server: {
            transport: "stdio",
            name: "stdio-unaffected",
            command: fixture.command,
            args: fixture.args,
          },
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(await getExtensionByName("stdio-unaffected")).not.toBeNull();
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

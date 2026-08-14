/**
 * The uniform MCP connect-failure contract (`src/mcp/connect-failure.ts`).
 *
 * Two properties are load-bearing and both are asserted here:
 *
 *   1. The CALLER-facing half is a constant — one status, one body, with no
 *      substring of the underlying error in it. That is what closes the
 *      port-scan oracle, so the message is asserted against the actual
 *      failure texts an attacker would probe with.
 *   2. The OPERATOR-facing half is NOT lost — the real cause reaches
 *      `error_logs` with a structured reason, so an admin can still
 *      diagnose. Asserted against a real PGlite, not a mock, because "the
 *      row is written" is the whole point of collapsing the response.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  MCP_CONNECT_FAILED_MESSAGE,
  MCP_CONNECT_FAILED_STATUS,
  reportMcpConnectFailure,
} from "../mcp/connect-failure";
import { McpTargetBlockedError, MCP_TARGET_ALLOW_ENV } from "../mcp/target-guard";
import { listErrors } from "../db/queries/error-logs";
import { getDb } from "../db/connection";
import { errorLogs } from "../db/schema";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await getDb().delete(errorLogs);
});

describe("the uniform response contract", () => {
  test("the status is 502", () => {
    expect(MCP_CONNECT_FAILED_STATUS).toBe(502);
  });

  test("the message names the escape hatch so a self-hoster is not stuck", () => {
    expect(MCP_CONNECT_FAILED_MESSAGE).toContain(MCP_TARGET_ALLOW_ENV);
  });

  test("the message is a frozen constant, not a template", () => {
    // Pinned by exact equality: the oracle came back the moment any part of
    // the body was interpolated from the failure. An edit that reintroduces
    // a `${...}` has to change this line, which is the point.
    //
    // The phrase "private network" IS in the text and is NOT a leak: it is
    // returned verbatim for a refused connection to a PUBLIC host too, so it
    // discriminates nothing. Invariance, not vocabulary, is the property —
    // see the route-level tests that assert byte-identical bodies for a
    // blocked target and an unreachable one.
    expect(MCP_CONNECT_FAILED_MESSAGE).toBe(
      "MCP server unreachable or invalid. If the target is on a private network, " +
        "allow it with EZCORP_MCP_TARGET_ALLOW.",
    );
  });

  test("the message carries no address or errno token", () => {
    // Everything an attacker sweeps for: transport errnos and address
    // fragments. None can appear, because none is interpolated.
    const oracleTokens = [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "ECONNRESET",
      "169.254",
      "127.0.0.1",
      "10.0.0",
      "192.168",
      "localhost",
      "refused",
      "timed out",
    ];
    for (const token of oracleTokens) {
      expect(MCP_CONNECT_FAILED_MESSAGE.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });
});

describe("server-side diagnosis survives the collapse", () => {
  test("a guard rejection is recorded with its reason and target", async () => {
    await reportMcpConnectFailure(
      new McpTargetBlockedError("private-address", "mcp.lan → 10.0.0.5"),
      { route: "POST /api/mcp-servers", extension: "lan-mcp", transport: "http" },
    );

    const rows = await listErrors();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.level).toBe("warn");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.blocked).toBe(true);
    expect(meta.reason).toBe("private-address");
    expect(meta.target).toBe("mcp.lan → 10.0.0.5");
    expect(meta.route).toBe("POST /api/mcp-servers");
    expect(meta.extension).toBe("lan-mcp");
    expect(meta.transport).toBe("http");
  });

  test("a plain transport error is recorded at error level", async () => {
    await reportMcpConnectFailure(new Error("connect ECONNREFUSED 10.0.0.5:6379"), {
      route: "PUT /api/mcp-servers/[id]",
      extension: "edited",
      transport: "sse",
    });

    const rows = await listErrors();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.level).toBe("error");
    // The RAW cause is preserved here — this is the admin surface, and it is
    // exactly what the HTTP response is no longer allowed to say.
    expect(row.message).toContain("ECONNREFUSED");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.blocked).toBe(false);
    expect(meta.reason).toBe("connect-error");
    expect(meta.target).toBeNull();
  });

  test("an optional context field is recorded as null, not dropped", async () => {
    // The refresh route knows the id but not the transport.
    await reportMcpConnectFailure(new Error("boom"), {
      route: "POST /api/mcp-servers/[id]/refresh",
    });

    const meta = (await listErrors())[0]!.metadata as Record<string, unknown>;
    expect(meta.extension).toBeNull();
    expect(meta.transport).toBeNull();
  });

  test("a stack is captured when the error carries one", async () => {
    await reportMcpConnectFailure(new Error("with-stack"), { route: "r" });
    expect((await listErrors())[0]!.stack).toContain("Error");
  });

  test("a stackless Error records a null stack", async () => {
    const stackless = new Error("no-stack");
    stackless.stack = undefined;
    await reportMcpConnectFailure(stackless, { route: "r" });
    expect((await listErrors())[0]!.stack).toBeNull();
  });

  test("a thrown non-Error is stringified rather than dropped", async () => {
    await reportMcpConnectFailure("pipe closed", { route: "r", extension: "x" });

    const rows = await listErrors();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toContain("pipe closed");
    expect(rows[0]!.stack).toBeNull();
    expect((rows[0]!.metadata as Record<string, unknown>).blocked).toBe(false);
  });

  test("reporting never throws, so it cannot change what the caller sees", async () => {
    // A guard error whose target is empty, an undefined thrown value — the
    // reporter must absorb all of it.
    await reportMcpConnectFailure(undefined, { route: "r" });
    await reportMcpConnectFailure(new McpTargetBlockedError("scheme", "ftp:"), { route: "r" });
    expect(await listErrors()).toHaveLength(2);
  });
});

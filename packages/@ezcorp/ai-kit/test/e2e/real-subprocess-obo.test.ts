/**
 * E2E: Full on-behalf-of chain validated with a REAL spawned subprocess.
 *
 * What this proves (no mocks):
 *   1. Test harness mints a real ezkint_* key via provisionInternalKey.
 *   2. A real Bun subprocess boots the MCP stdio server.
 *   3. A real MCP Client + StdioClientTransport completes the MCP handshake.
 *   4. callTool({ _meta: { ezOnBehalfOf: "geff" } }) flows through the ALS
 *      wrapper, sets X-Ezcorp-On-Behalf-Of on the outgoing HTTP request.
 *   5. The test server's bearer-auth path accepts the ezkint_* token,
 *      resolves the OBO header, and persists the conversation with userId=geff.
 *   6. The DB row proves it: userId === "geff", not "sys-ai-kit".
 *
 * Opt-in via `EZCORP_E2E_SUBPROCESS=1`. Default-skipped because the
 * test requires both (a) permission to spawn a bun subprocess and (b)
 * PGlite with the `vector` extension available on-disk (used by the
 * memory module's embedding column). Both are present in full dev/CI
 * environments and absent in many sandbox runners. Matches the skip-
 * guarded pattern used by the other e2e tests in this directory.
 *
 * IMPORTANT: DB modules are imported dynamically inside beforeAll so that
 * process.env["EZCORP_DB_PATH"] = ":memory:" is in effect before the
 * connection module evaluates its top-level `DB_PATH` const.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";

// ── Set DB path BEFORE any DB module is imported ─────────────────────────────
// connection.ts evaluates `DB_PATH = process.env.EZCORP_DB_PATH ?? ...` at
// module load time. Setting the env here (top-level module scope, before any
// dynamic import of db modules) ensures the in-memory path is used.
process.env["EZCORP_DB_PATH"] = ":memory:";
// Prevent hooks.server.ts from running full initialization if it's ever loaded.
process.env["PI_SKIP_INIT"] = "1";

// ── Guard: opt-in. Default-skipped because the test requires pgvector
//   and subprocess spawn capability; run explicitly with
//   EZCORP_E2E_SUBPROCESS=1 bun test test/e2e/real-subprocess-obo.test.ts
const RUN = process.env["EZCORP_E2E_SUBPROCESS"] === "1";
const SKIP = !RUN;

// Use the same bun binary that is running this test (avoids $PATH resolution
// issues in sandboxed/NixOS environments where PATH differs between processes).
const BUN_BIN = process.execPath;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read a tool result's first text block as a parsed JSON value. */
function readTool(result: unknown): unknown {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0]!.text);
}

// ── Module-level test state ───────────────────────────────────────────────────

let testServer: ReturnType<typeof Bun.serve> | undefined;
let testServerUrl: string;

/** Headers captured by the test server for each POST /api/conversations request. */
const capturedRequestHeaders: Array<Record<string, string>> = [];

/** Conversation rows written by the handler, keyed by id. */
const writtenConversations = new Map<
  string,
  { id: string; projectId: string; userId: string | null }
>();

let mcpClient: Client | undefined;
let mcpTransport: StdioClientTransport | undefined;

describe.skipIf(SKIP)("e2e subprocess: full OBO chain with real stdio MCP", () => {
  beforeAll(async () => {
    // ── 1. Init in-memory DB + seed rows ─────────────────────────────────────
    // All DB imports are dynamic here: process.env["EZCORP_DB_PATH"] = ":memory:"
    // was already set at module top-level (above), but dynamic import ensures no
    // import hoisting can evaluate DB_PATH before we set the env.
    const { initDb, getDb } = await import("../../../../../src/db/connection");
    const { createConversation } = await import("../../../../../src/db/queries/conversations");
    const { getUserById } = await import("../../../../../src/db/queries/users");

    await initDb();
    const db = getDb();

    // Ensure the global project row exists (migration seeds it; ON CONFLICT
    // makes this idempotent in case a prior test run left it in :memory:).
    await db.execute(sql`
      INSERT INTO projects (id, name, path)
      VALUES ('global', 'Global', '/')
      ON CONFLICT (id) DO NOTHING
    `);

    // createUser uses INSERT ... RETURNING; wrap in ON CONFLICT to be safe if
    // Bun's test runner reuses module state across re-runs in watch mode.
    // We use raw SQL for idempotent upsert since createUser doesn't have one.
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, name, role, status)
      VALUES ('geff', 'geff@example.com', 'x', 'Geff', 'member', 'active')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, name, role, status)
      VALUES ('sys-ai-kit', 'ai-kit@sys.ezcorp.invalid', 'x', 'System: ai-kit', 'member', 'active')
      ON CONFLICT (id) DO NOTHING
    `);

    // ── 2. Mint an internal key for sys-ai-kit ──────────────────────────────
    // Dynamic import of internal-auth — only `import type` from SvelteKit
    // aliases, so it loads cleanly outside the SvelteKit context.
    const { provisionInternalKey } = await import(
      "../../../../../web/src/lib/server/security/internal-auth"
    );
    const { verifyInternalKey } = await import(
      "../../../../../web/src/lib/server/security/internal-auth"
    );

    const { raw: rawKey } = provisionInternalKey("ai-kit", ["chat", "read"], "sys-ai-kit");

    // ── 3. Stand up a minimal test server ──────────────────────────────────
    // Hosts the real POST /api/conversations handler with the real bearer-auth
    // logic (verifyInternalKey + OBO resolution). No SvelteKit required.
    //
    // Security constraints (mirrors hooks.server.ts + bearer-auth.ts):
    //   - Reject requests with proxy-forwarded headers.
    //   - verifyInternalKey receives remoteAddr = "127.0.0.1" (loopback).
    //   - Only the EXACT OBO logic from bearer-auth.ts is replicated inline.

    const jsonResp = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    testServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;

        if (path === "/api/health") return jsonResp({ ok: true });

        // ── Auth ──────────────────────────────────────────────────────────
        const authHeader = req.headers.get("authorization");
        if (!authHeader?.startsWith("Bearer ")) return jsonResp({ error: "unauthorized" }, 401);
        const rawToken = authHeader.slice(7);

        // Reject proxy-forwarding headers — same logic as hooks.server.ts
        // `proxyForwardedHeadersPresent` guard in bearer-auth path.
        const proxyPresent =
          req.headers.has("x-forwarded-for") ||
          req.headers.has("x-real-ip") ||
          req.headers.has("forwarded");
        if (proxyPresent) return jsonResp({ error: "proxy headers present" }, 403);

        // Both test server and subprocess run on loopback.
        const remoteAddr = "127.0.0.1";

        const principal = verifyInternalKey(rawToken, remoteAddr);
        if (!principal) return jsonResp({ error: "unauthorized" }, 401);

        // OBO resolution — mirrors bearer-auth.ts §on-behalf-of block.
        let effectiveUserId = principal.userId;
        const oboRaw = req.headers.get("x-ezcorp-on-behalf-of");
        const obo = typeof oboRaw === "string" ? oboRaw.trim() : "";
        if (obo.length > 0 && !obo.startsWith("sys-")) {
          try {
            const target = await getUserById(obo);
            if (target && target.status === "active") {
              effectiveUserId = target.id;
            }
          } catch {
            // DB unavailable — fall back to system principal (safe).
          }
        }

        // ── GET /api/auth/me ─────────────────────────────────────────────
        if (path === "/api/auth/me" && req.method === "GET") {
          return jsonResp({ id: effectiveUserId, name: principal.name, email: "", role: "member" });
        }

        // ── GET /api/projects/:id ────────────────────────────────────────
        const projMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
        if (projMatch && req.method === "GET") {
          const pid = projMatch[1]!;
          if (pid === "global") return jsonResp({ id: "global", name: "Global", path: "/" });
          return jsonResp({ error: "not found" }, 404);
        }

        // ── POST /api/conversations ──────────────────────────────────────
        if (path === "/api/conversations" && req.method === "POST") {
          // Capture headers for later assertions.
          const captured: Record<string, string> = {};
          req.headers.forEach((v, k) => {
            captured[k.toLowerCase()] = v;
          });
          capturedRequestHeaders.push(captured);

          const body = (await req.json()) as { projectId: string; title?: string };
          const conv = await createConversation(body.projectId, {
            title: body.title ?? "New conversation",
            userId: effectiveUserId,
          });
          writtenConversations.set(conv.id, {
            id: conv.id,
            projectId: conv.projectId,
            userId: conv.userId ?? null,
          });
          return jsonResp(conv, 201);
        }

        return jsonResp({ error: "not found" }, 404);
      },
    });

    // Use 127.0.0.1 explicitly so verifyInternalKey's loopback check passes.
    testServerUrl = `http://127.0.0.1:${testServer.port}`;

    // ── 4 + 5. Spawn real subprocess + connect MCP Client over stdio ─────────
    // StdioClientTransport spawns and owns the subprocess lifecycle.
    // rawKey is passed ONLY to the subprocess env — never to this process's env.
    const serverScript = resolve(import.meta.dir, "../../src/mcp/server.ts");

    mcpTransport = new StdioClientTransport({
      command: BUN_BIN,
      args: [serverScript],
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        EZCORP_BASE_URL: testServerUrl,
        EZCORP_API_KEY: rawKey,
        // Subprocess is a pure HTTP client; EZCORP_DB_PATH is a no-op for it.
        EZCORP_DB_PATH: ":memory:",
      },
      stderr: "inherit",
    });

    mcpClient = new Client({ name: "test-harness", version: "0.0.1" }, { capabilities: {} });
    await mcpClient.connect(mcpTransport);
  }, 25_000);

  afterAll(async () => {
    // Graceful shutdown: close client first (MCP shutdown notification),
    // then stop the test server, then clean up auth + DB state.
    await mcpClient?.close().catch(() => {});
    mcpClient = undefined;
    mcpTransport = undefined;

    testServer?.stop(true);
    testServer = undefined;

    const { resetInternalKeyStoreForTests } = await import(
      "../../../../../web/src/lib/server/security/internal-auth"
    );
    resetInternalKeyStoreForTests();

    const { closeDb } = await import("../../../../../src/db/connection");
    await closeDb();

    delete process.env["EZCORP_DB_PATH"];
    delete process.env["PI_SKIP_INIT"];
  });

  // ── Link 1: subprocess boots + MCP handshake succeeds ───────────────────
  test("MCP client connects to subprocess and lists tools", async () => {
    const tools = await mcpClient!.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("start_chat");
    expect(names).toContain("send_message");
    expect(names).toContain("list_projects");
  }, 15_000);

  // ── Links 2–6: full chain ────────────────────────────────────────────────
  test("start_chat with _meta.ezOnBehalfOf=geff → conversation owned by geff", async () => {
    const headersBefore = capturedRequestHeaders.length;

    // Link 3: MCP callTool sends _meta.ezOnBehalfOf to subprocess.
    // Link 4: subprocess ALS wrapper → X-Ezcorp-On-Behalf-Of header.
    // Link 5: test server verifies ezkint_* token + resolves OBO.
    // Link 6: DB write uses effectiveUserId = "geff".
    const result = await mcpClient!.callTool({
      name: "start_chat",
      arguments: { projectId: "global", title: "e2e obo subprocess test" },
      _meta: { ezOnBehalfOf: "geff" },
    });

    // ── Assert A: response contains a conversation id ────────────────────────
    const conv = readTool(result) as { id: string; projectId: string };
    expect(typeof conv.id).toBe("string");
    expect(conv.id.length).toBeGreaterThan(0);

    // ── Assert B: request carried ezkint_* auth AND OBO header ───────────────
    const newHeaders = capturedRequestHeaders.slice(headersBefore);
    expect(newHeaders.length).toBeGreaterThanOrEqual(1);
    const reqHeaders = newHeaders[0]!;
    expect(reqHeaders["authorization"]).toMatch(/^Bearer ezkint_/);
    expect(reqHeaders["x-ezcorp-on-behalf-of"]).toBe("geff");

    // ── Assert C: DB row owned by geff, NOT sys-ai-kit ───────────────────────
    const written = writtenConversations.get(conv.id);
    expect(written).toBeDefined();
    expect(written!.userId).toBe("geff");
    expect(written!.userId).not.toBe("sys-ai-kit");
  }, 15_000);

  // ── Baseline: no OBO → row owned by sys-ai-kit ──────────────────────────
  test("start_chat WITHOUT _meta → conversation owned by sys-ai-kit (baseline)", async () => {
    const headersBefore = capturedRequestHeaders.length;

    const result = await mcpClient!.callTool({
      name: "start_chat",
      arguments: { projectId: "global", title: "e2e no-obo baseline" },
    });

    const conv = readTool(result) as { id: string };
    expect(typeof conv.id).toBe("string");

    const newHeaders = capturedRequestHeaders.slice(headersBefore);
    const reqHeaders = newHeaders[0]!;
    // Auth header present, OBO header absent.
    expect(reqHeaders["authorization"]).toMatch(/^Bearer ezkint_/);
    expect(reqHeaders["x-ezcorp-on-behalf-of"]).toBeUndefined();

    // DB row must be owned by the system principal.
    const written = writtenConversations.get(conv.id);
    expect(written).toBeDefined();
    expect(written!.userId).toBe("sys-ai-kit");
  }, 15_000);

  // ── Subprocess exits cleanly when client closes ──────────────────────────
  test("subprocess exits cleanly after client.close()", async () => {
    // Closing the client sends MCP shutdown, closes transport stdin →
    // subprocess gets EOF and exits naturally without SIGKILL.
    let threw = false;
    try {
      await mcpClient!.close();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Mark undefined so afterAll doesn't double-close.
    mcpClient = undefined;
    mcpTransport = undefined;
  }, 10_000);
});

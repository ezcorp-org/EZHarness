/**
 * #206 — repeated identical DENIES are folded into one counted audit row,
 * against the real `audit_log` table.
 *
 * The generator is durable deny state, which #204 made reachable: once an
 * MCP tool's needed-capability set is non-empty, a conversation-scoped
 * override that omits `network` (or an admin revoking the grant, or a
 * backfill row whose UPDATE threw) refuses EVERY call and used to write a
 * row per call — `MAX_TOOL_CALLS_PER_TURN` (100) per turn per conversation,
 * indefinitely for a looping or scheduled agent.
 *
 * A deny is forensic data, so this suite asserts the folding is LOSSLESS in
 * the persisted rows, not merely that fewer rows were written:
 *   - every call still returns `deny` with its reason (the decision is
 *     never folded, only the row);
 *   - the tail row carries the count, the head's `auditId`, the missing
 *     capability kind + value, the original reason and the first/last
 *     timestamps;
 *   - heads + suppressed equals the number of refusals, exactly;
 *   - a deny for a DIFFERENT missing capability, tool or conversation is
 *     never folded into the first burst;
 *   - the fail-closed `override-lookup-failed` deny is never folded.
 *
 * The tail row is driven through the coalescer's early-flush threshold
 * (`COALESCE_FLUSH_AT`) rather than by waiting out the 10s window: the
 * engine owns its coalescer with production settings, and a suite that
 * sleeps for a window is a suite that measures the host.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  mockDbConnection,
  mockRealSettings,
  setupTestDb,
  closeTestDb,
  getTestDb,
} from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();
mockRealSettings();

/**
 * Seam for the fail-closed branch: a DB failure on the conversation-override
 * read. Flipped on by the last suite only, so every other test runs against
 * the real query. `db/queries/conversation-extensions` is snapshotted in
 * `helpers/mock-cleanup.ts`, so the stub cannot leak into another file.
 */
let overrideReadFails = false;
const realConvExt = await import("../db/queries/conversation-extensions");
mock.module("../db/queries/conversation-extensions", () => ({
  ...realConvExt,
  getConversationExtensionEffectiveGrants: async (conversationId: string, extensionId: string) => {
    if (overrideReadFails) throw new Error("PGlite: connection terminated");
    return realConvExt.getConversationExtensionEffectiveGrants(conversationId, extensionId);
  },
}));

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

import {
  createPermissionEngine,
  primeConversationOverrideCache,
  _resetOverrideCacheForTests,
  type AuthorizeContext,
} from "../extensions/permission-engine";
import { COALESCE_FLUSH_AT } from "../extensions/perm-audit-coalescer";
import type { ExtensionRegistry } from "../extensions/registry";
import type { CapabilitySet } from "../extensions/capability-types";
import { auditLog, users } from "../db/schema";
import { eq } from "drizzle-orm";

const USER_ID = "perm-deny-coalesce-user";
const EXT_ID = "weather-mcp-206";
const CONV_ID = "conv-deny-206";
const HOST = "api.weather.test";

/** The needed set an MCP tool carries after #204 — non-empty, so the PDP
 *  actually gates instead of waving the call through. */
const NEEDED: CapabilitySet = [{ kind: "network", value: HOST }];

/** A registry that grants NOTHING — the revoked-grant state. */
function revokedRegistry(): ExtensionRegistry {
  return {
    getGrantedPermissions: () => ({ grantedAt: {} }),
    isBundled: () => false,
  } as unknown as ExtensionRegistry;
}

function engineFor(registry: ExtensionRegistry) {
  return createPermissionEngine({
    registry,
    bus: { emit: () => {}, on: () => () => {} } as unknown as Parameters<
      typeof createPermissionEngine
    >[0]["bus"],
    db: { _token: "deny-coalesce-test" },
  });
}

function ctxFor(over: Partial<AuthorizeContext> = {}): AuthorizeContext {
  return {
    extensionId: EXT_ID,
    userId: USER_ID,
    conversationId: CONV_ID,
    toolName: "weather-mcp__forecast",
    // Supplied so `authorize` skips the spawn-parent lookup: this suite
    // makes hundreds of calls and the audit rows are what it measures.
    parentAuditId: "root-audit-206",
    ...over,
  };
}

async function denyRows() {
  return getTestDb().select().from(auditLog).where(eq(auditLog.action, "ext:perm:denied"));
}

/** The folded tail rows, identified the way an operator would: by the
 *  self-describing marker the engine writes into `reason`. */
function tailRows(rows: Awaited<ReturnType<typeof denyRows>>) {
  return rows.filter((r) =>
    String((r.metadata as Record<string, unknown>).reason ?? "").startsWith(
      "coalesced-deny-tail",
    ),
  );
}

beforeEach(async () => {
  await setupTestDb();
  await getTestDb()
    .insert(users)
    .values({
      id: USER_ID,
      email: "deny206@example.com",
      passwordHash: "x",
      name: "Deny 206",
      role: "member",
    })
    .onConflictDoNothing();
  _resetOverrideCacheForTests();
  // No override row for this conversation: primed as `null` so the engine
  // takes the registry-grant path without a DB read per call.
  primeConversationOverrideCache(CONV_ID, EXT_ID, null);
});

describe("a persistent deny writes one row, not one per call", () => {
  test("100 refusals in a turn produce a single audit row", async () => {
    const engine = engineFor(revokedRegistry());
    const decisions: string[] = [];
    for (let i = 0; i < 100; i++) {
      const d = await engine.authorize(ctxFor(), NEEDED);
      decisions.push(d.decision);
      // The DECISION is never coalesced — only the row is. A folded deny
      // that returned anything but `deny` would be a permission bypass.
      if (d.decision !== "deny") throw new Error(`call ${i} returned ${d.decision}`);
      expect(d.reason).toContain("network");
    }
    expect(decisions.every((x) => x === "deny")).toBe(true);

    const rows = await denyRows();
    // Pre-#206: 100 rows. The verbatim head is written; the tail is still
    // open (100 < COALESCE_FLUSH_AT), so it has not flushed yet.
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta.capabilityKind).toBe("network");
    expect(meta.capabilityValue).toBe(HOST);
    expect(rows[0]!.userId).toBe(USER_ID);
    expect(rows[0]!.target).toBe(EXT_ID);

    engine._resetCacheForTests();
  });

  test("the flushed tail row accounts for every suppressed refusal", async () => {
    const engine = engineFor(revokedRegistry());
    // One past the threshold: head + FLUSH_AT folded, then the next call
    // flushes the summary and opens a new window as its own head.
    const calls = COALESCE_FLUSH_AT + 2;
    for (let i = 0; i < calls; i++) {
      const d = await engine.authorize(ctxFor(), NEEDED);
      expect(d.decision).toBe("deny");
    }

    const rows = await denyRows();
    const tails = tailRows(rows);
    expect(tails).toHaveLength(1);
    const heads = rows.length - tails.length;
    expect(heads).toBe(2);

    const meta = tails[0]!.metadata as Record<string, unknown>;
    // The count is the whole justification for folding a security event.
    expect(meta.suppressed).toBe(COALESCE_FLUSH_AT);
    expect(meta.totalInWindow).toBe(COALESCE_FLUSH_AT + 1);
    // Exact accounting: nothing was lost and nothing was double-counted.
    expect(heads + (meta.suppressed as number)).toBe(calls);

    // The tail row is a complete deny record on its own.
    expect(meta.capabilityKind).toBe("network");
    expect(meta.capabilityValue).toBe(HOST);
    expect(meta.toolName).toBe("weather-mcp__forecast");
    expect(meta.conversationId).toBe(CONV_ID);
    expect(tails[0]!.userId).toBe(USER_ID);
    // Self-describing marker FIRST, original reason preserved after it.
    expect(String(meta.reason)).toStartWith("coalesced-deny-tail (");
    expect(String(meta.reason)).toContain(HOST);

    // Joinable to the head it folded, and bracketed in time.
    const headIds = rows
      .filter((r) => !tails.includes(r))
      .map((r) => (r.metadata as Record<string, unknown>).auditId);
    expect(headIds).toContain(meta.headAuditId);
    const firstAt = Date.parse(String(meta.firstAt));
    const lastAt = Date.parse(String(meta.lastAt));
    expect(Number.isNaN(firstAt)).toBe(false);
    expect(Number.isNaN(lastAt)).toBe(false);
    expect(lastAt).toBeGreaterThanOrEqual(firstAt);

    engine._resetCacheForTests();
  });
});

describe("only byte-identical refusals fold", () => {
  test("a different missing capability, tool or conversation is a new row", async () => {
    const engine = engineFor(revokedRegistry());
    // Open the burst and fold one.
    await engine.authorize(ctxFor(), NEEDED);
    await engine.authorize(ctxFor(), NEEDED);
    expect(await denyRows()).toHaveLength(1);

    // A different missing capability VALUE — a different fact.
    await engine.authorize(ctxFor(), [{ kind: "network", value: "api.other.test" }]);
    expect(await denyRows()).toHaveLength(2);

    // A different capability KIND.
    await engine.authorize(ctxFor(), [{ kind: "fs.read", value: "/etc" }]);
    expect(await denyRows()).toHaveLength(3);

    // A different tool on the same missing capability.
    await engine.authorize(ctxFor({ toolName: "weather-mcp__radar" }), NEEDED);
    expect(await denyRows()).toHaveLength(4);

    // A different conversation.
    primeConversationOverrideCache("conv-other-206", EXT_ID, null);
    await engine.authorize(ctxFor({ conversationId: "conv-other-206" }), NEEDED);
    expect(await denyRows()).toHaveLength(5);

    engine._resetCacheForTests();
  });

  test("an ALLOW burst does not suppress a deny for the same tool", async () => {
    // The registry grants the host, so the same (extension, tool) pair
    // allows; a later call needing a DIFFERENT host is refused. An allow
    // window must never swallow that refusal.
    const registry = {
      getGrantedPermissions: () => ({ grantedAt: {}, network: [HOST] }),
      isBundled: () => false,
    } as unknown as ExtensionRegistry;
    const engine = engineFor(registry);

    for (let i = 0; i < 5; i++) {
      const d = await engine.authorize(ctxFor(), NEEDED);
      expect(d.decision).toBe("allow");
    }
    const allowed = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:allowed"));
    expect(allowed).toHaveLength(1);

    const denied = await engine.authorize(ctxFor(), [
      { kind: "network", value: "api.evil.test" },
    ]);
    expect(denied.decision).toBe("deny");
    expect(await denyRows()).toHaveLength(1);

    engine._resetCacheForTests();
  });
});

describe("the fail-closed override-lookup deny is never folded", () => {
  test("every DB-failure refusal keeps its own row", async () => {
    // The override read throws, so `authorize` takes the fail-closed
    // branch. Those rows carry a per-row `underlyingError`, and the state
    // they report (an unhealthy DB) is one an operator must see every
    // instance of — so this call site deliberately bypasses the
    // coalescer. Routing it through would collapse these three rows into
    // one and red this test.
    _resetOverrideCacheForTests();
    const engine = engineFor(revokedRegistry());
    // A conversation with NO primed cache entry, so the read is reached.
    const ctx = ctxFor({ conversationId: "conv-db-broken-206" });

    overrideReadFails = true;
    try {
      for (let i = 0; i < 3; i++) {
        const d = await engine.authorize(ctx, NEEDED);
        expect(d.decision).toBe("deny");
        expect("reason" in d && d.reason).toBe("override-lookup-failed");
      }
    } finally {
      overrideReadFails = false;
    }

    const rows = await denyRows();
    expect(rows).toHaveLength(3);
    expect(tailRows(rows)).toHaveLength(0);
    for (const row of rows) {
      const meta = row.metadata as Record<string, unknown>;
      expect(meta.reason).toBe("override-lookup-failed");
      expect(String(meta.underlyingError)).toContain("connection terminated");
    }

    engine._resetCacheForTests();
  });
});

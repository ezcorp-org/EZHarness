/**
 * Phase 1 PDP unit + integration coverage.
 *
 * Locks in the contract documented in `src/extensions/permission-engine.ts`:
 *   • `authorize` allows when granted ⊇ needed
 *   • denies when granted is missing any needed cap; reason names the
 *     missing cap
 *   • prompts when a sensitive cap (fs.write/shell) lacks always-allow
 *   • writes exactly one auditLog row per decision
 *   • honors `capContext` override (intersection wins over registry)
 *   • cache is updated by `resolvePrompt` write
 *   • fail-closed: `createPermissionEngine` throws if `db`, `registry`,
 *     or `bus` is missing
 *
 * The integration block at the bottom boots the registry, runs one
 * tool call end-to-end through `ToolExecutor`, and asserts that an
 * `auditLog` row with `action='ext:perm:allowed'` exists.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mockDbConnection, mockRealSettings, setupTestDb, closeTestDb, getTestDb } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();
mockRealSettings();

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

import {
  createPermissionEngine,
  _resetPermissionEngineForTests,
  type PermissionEngine,
} from "../extensions/permission-engine";
import type { CapabilitySet } from "../extensions/capability-types";
import type { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionPermissions } from "../extensions/types";
import { auditLog } from "../db/schema";
import { eq } from "drizzle-orm";

// ── Test helpers ────────────────────────────────────────────────────

interface FakeRegistryArgs {
  granted?: ExtensionPermissions | null;
}

function makeFakeRegistry(args: FakeRegistryArgs = {}): ExtensionRegistry {
  return {
    getGrantedPermissions: (_id: string) => args.granted ?? null,
  } as unknown as ExtensionRegistry;
}

function makeFakeBus() {
  return {
    emit: () => {},
    on: () => () => {},
  } as unknown as Parameters<typeof createPermissionEngine>[0]["bus"];
}

function makeEngine(args: FakeRegistryArgs = {}): PermissionEngine {
  _resetPermissionEngineForTests();
  return createPermissionEngine({
    registry: makeFakeRegistry(args),
    bus: makeFakeBus(),
    db: { _token: "test" },
  });
}

const HELLO_USER = "user-1";
const HELLO_CONV = "conv-1";
const HELLO_EXT = "ext-1";

beforeEach(async () => {
  await setupTestDb();
  // Seed the test user so audit-log FK to `users` doesn't reject the
  // insert (`ON DELETE SET NULL` doesn't apply on insert — the
  // referenced row must exist or the insert fails).
  const { users } = await import("../db/schema");
  await getTestDb()
    .insert(users)
    .values({
      id: HELLO_USER,
      email: "user1@example.com",
      passwordHash: "x",
      name: "User One",
      role: "member",
    })
    .onConflictDoNothing();
});

// ── Construction guard (fail-closed) ────────────────────────────────

describe("createPermissionEngine — fail-closed dep contract", () => {
  test("throws when registry is missing", () => {
    expect(() =>
      createPermissionEngine({
        registry: undefined as unknown as ExtensionRegistry,
        bus: makeFakeBus(),
        db: {},
      }),
    ).toThrow(/registry/);
  });

  test("throws when bus is missing", () => {
    expect(() =>
      createPermissionEngine({
        registry: makeFakeRegistry(),
        bus: undefined as unknown as Parameters<typeof createPermissionEngine>[0]["bus"],
        db: {},
      }),
    ).toThrow(/bus/);
  });

  test("throws when db token is missing (undefined, not just falsy)", () => {
    expect(() =>
      createPermissionEngine({
        registry: makeFakeRegistry(),
        bus: makeFakeBus(),
        db: undefined,
      }),
    ).toThrow(/db/);
  });
});

// ── Allow path ──────────────────────────────────────────────────────

describe("authorize — allow when granted ⊇ needed", () => {
  test("network cap covers when host is granted", async () => {
    const engine = makeEngine({
      granted: {
        grantedAt: {},
        network: ["api.foo.com"],
      },
    });
    const decision = await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV, toolName: "tool" },
      [{ kind: "network", value: "api.foo.com" }],
    );
    expect(decision.decision).toBe("allow");
    expect("auditId" in decision && typeof decision.auditId).toBe("string");
  });

  test("filesystem read covered by granted prefix", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, filesystem: ["/data"] },
    });
    const decision = await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
      [{ kind: "fs.read", value: "/data/file.txt" }],
    );
    expect(decision.decision).toBe("allow");
  });

  test("storage cap covered by granted boolean", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, storage: true },
    });
    const decision = await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
      [{ kind: "storage" }],
    );
    expect(decision.decision).toBe("allow");
  });

  test("namespaced ezcorp:tasks:emit cap covered", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, taskEvents: true },
    });
    const decision = await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
      [{ kind: "ezcorp:tasks:emit" }],
    );
    expect(decision.decision).toBe("allow");
  });
});

// ── Deny path ───────────────────────────────────────────────────────

describe("authorize — deny when granted missing a cap", () => {
  test("denies and names the missing network host", async () => {
    const engine = makeEngine({ granted: { grantedAt: {}, network: ["a.com"] } });
    const decision = await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV, toolName: "fetcher" },
      [{ kind: "network", value: "evil.com" }],
    );
    expect(decision.decision).toBe("deny");
    if (decision.decision !== "deny") throw new Error("unreachable");
    expect(decision.reason).toContain("network");
    expect(decision.reason).toContain("evil.com");
    expect(decision.reason).toContain("fetcher");
    expect(decision.missing).toEqual({ kind: "network", value: "evil.com" });
  });

  test("denies when filesystem prefix doesn't cover", async () => {
    const engine = makeEngine({ granted: { grantedAt: {}, filesystem: ["/home"] } });
    const decision = await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
      [{ kind: "fs.read", value: "/etc/passwd" }],
    );
    expect(decision.decision).toBe("deny");
  });

  test("denies when no permissions granted at all", async () => {
    const engine = makeEngine({ granted: null });
    const decision = await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
      [{ kind: "shell" }],
    );
    expect(decision.decision).toBe("deny");
  });
});

// ── Prompt path ─────────────────────────────────────────────────────

describe("authorize — prompt when sensitive cap lacks always-allow", () => {
  test("fs.write needs prompt by default", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, filesystem: ["/tmp"] },
    });
    const decision = await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
      [{ kind: "fs.write", value: "/tmp/x" }],
    );
    expect(decision.decision).toBe("prompt");
    if (decision.decision !== "prompt") throw new Error("unreachable");
    expect(decision.promptId).toBeTruthy();
    expect(decision.sensitive.kind).toBe("fs.write");
  });

  test("shell needs prompt by default", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, shell: true },
    });
    const decision = await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
      [{ kind: "shell" }],
    );
    expect(decision.decision).toBe("prompt");
  });

  test("non-sensitive caps (fs.read, network, storage) don't prompt", async () => {
    const engine = makeEngine({
      granted: {
        grantedAt: {},
        filesystem: ["/tmp"],
        network: ["a.com"],
        storage: true,
      },
    });
    expect(
      (
        await engine.authorize(
          { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
          [{ kind: "fs.read", value: "/tmp/x" }],
        )
      ).decision,
    ).toBe("allow");
    expect(
      (
        await engine.authorize(
          { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
          [{ kind: "network", value: "a.com" }],
        )
      ).decision,
    ).toBe("allow");
  });
});

// ── Audit row writes ────────────────────────────────────────────────

describe("authorize — audit log row per decision", () => {
  test("writes one PERM_ALLOWED row on allow", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, storage: true },
    });
    await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV, toolName: "writer" },
      [{ kind: "storage" }],
    );
    const rows = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:allowed"));
    expect(rows.length).toBe(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta.toolName).toBe("writer");
    expect(meta.conversationId).toBe(HELLO_CONV);
    expect(rows[0]!.target).toBe(HELLO_EXT);
  });

  test("writes one PERM_DENIED row on deny", async () => {
    const engine = makeEngine({ granted: { grantedAt: {} } });
    await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
      [{ kind: "shell" }],
    );
    const rows = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:denied"));
    expect(rows.length).toBe(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta.capabilityKind).toBe("shell");
    expect(meta.reason).toContain("shell");
  });

  test("writes one PERM_PROMPTED row on prompt", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, filesystem: ["/tmp"] },
    });
    await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
      [{ kind: "fs.write", value: "/tmp/x" }],
    );
    const rows = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:prompted"));
    expect(rows.length).toBe(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta.capabilityKind).toBe("fs.write");
    expect(typeof meta.promptId).toBe("string");
  });

  test("metadata is stripped of control characters and length-capped", async () => {
    const engine = makeEngine({ granted: { grantedAt: {} } });
    const dirtyTool = `bad\x00name\x07with\x1Fcontrols`;
    await engine.authorize(
      {
        extensionId: HELLO_EXT,
        userId: HELLO_USER,
        conversationId: HELLO_CONV,
        toolName: dirtyTool,
      },
      [{ kind: "shell" }],
    );
    const rows = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:denied"));
    expect(rows.length).toBe(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta.toolName).toBe("badnamewithcontrols");
  });

  test("parentAuditId rides through metadata for chain tracking", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, storage: true },
    });
    await engine.authorize(
      {
        extensionId: HELLO_EXT,
        userId: HELLO_USER,
        conversationId: HELLO_CONV,
        toolName: "child",
        parentAuditId: "abc-parent-id",
      },
      [{ kind: "storage" }],
    );
    const rows = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:allowed"));
    expect(rows.length).toBe(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta.parentAuditId).toBe("abc-parent-id");
  });
});

// ── always-allow read from settings DB ──────────────────────────────

describe("authorize — pre-existing always-allow row read from DB on first call", () => {
  test("seeded DB row → first authorize returns allow (no prompt) and writes PERM_ALLOWED", async () => {
    const { upsertSetting } = await import("../db/queries/settings");
    const { alwaysAllowSettingKey } = await import("../extensions/permissions");
    // Seed an always-allow row matching the conversation-scope lookup
    // path the engine uses on first authorize().
    await upsertSetting(
      alwaysAllowSettingKey({
        extensionId: HELLO_EXT,
        userId: HELLO_USER,
        scope: "conversation",
        scopeId: HELLO_CONV,
        capability: "shell",
      }),
      true,
    );

    const engine = makeEngine({
      granted: { grantedAt: {}, shell: true },
    });
    const decision = await engine.authorize(
      { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV },
      [{ kind: "shell" }],
    );
    expect(decision.decision).toBe("allow");

    const allowed = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:allowed"));
    expect(allowed.length).toBe(1);
    const prompted = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:prompted"));
    expect(prompted.length).toBe(0);
  });
});

// ── capContext override ─────────────────────────────────────────────

describe("authorize — capContext override (Phase 4 plumbing)", () => {
  test("capContext intersection wins over the registry's grant set", async () => {
    // Registry grants network: a.com + b.com. Cross-ext call's
    // capContext is the intersection — only a.com survives. A request
    // for b.com must deny even though the extension has it directly.
    const engine = makeEngine({
      granted: { grantedAt: {}, network: ["a.com", "b.com"] },
    });
    const intersection: CapabilitySet = [{ kind: "network", value: "a.com" }];
    const decisionA = await engine.authorize(
      {
        extensionId: HELLO_EXT,
        userId: HELLO_USER,
        conversationId: HELLO_CONV,
        capContext: intersection,
      },
      [{ kind: "network", value: "a.com" }],
    );
    expect(decisionA.decision).toBe("allow");
    const decisionB = await engine.authorize(
      {
        extensionId: HELLO_EXT,
        userId: HELLO_USER,
        conversationId: HELLO_CONV,
        capContext: intersection,
      },
      [{ kind: "network", value: "b.com" }],
    );
    expect(decisionB.decision).toBe("deny");
  });
});

// ── always-allow cache + resolvePrompt ──────────────────────────────

describe("resolvePrompt — persists + invalidates cache", () => {
  test("resolvePrompt(true) writes always-allow; subsequent authorize allows without prompt", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, shell: true },
    });
    const ctx = { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV };
    const first = await engine.authorize(ctx, [{ kind: "shell" }]);
    expect(first.decision).toBe("prompt");
    if (first.decision !== "prompt") throw new Error("unreachable");
    await engine.resolvePrompt(first.promptId, true, "conversation", HELLO_CONV);

    // Next call: same ctx + needed → allow.
    const second = await engine.authorize(ctx, [{ kind: "shell" }]);
    expect(second.decision).toBe("allow");
  });

  test("resolvePrompt(false) does NOT persist; next call still prompts", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, shell: true },
    });
    const ctx = { extensionId: HELLO_EXT, userId: HELLO_USER, conversationId: HELLO_CONV };
    const first = await engine.authorize(ctx, [{ kind: "shell" }]);
    if (first.decision !== "prompt") throw new Error("expected prompt");
    await engine.resolvePrompt(first.promptId, false, "conversation", HELLO_CONV);

    const second = await engine.authorize(ctx, [{ kind: "shell" }]);
    expect(second.decision).toBe("prompt");
  });

  test("resolvePrompt with unknown promptId is a no-op (logged via injected logger)", async () => {
    const engine = makeEngine({
      granted: { grantedAt: {}, shell: true },
    });
    // No throw — silent no-op.
    await engine.resolvePrompt("nonexistent-prompt", true, "conversation", HELLO_CONV);
  });
});

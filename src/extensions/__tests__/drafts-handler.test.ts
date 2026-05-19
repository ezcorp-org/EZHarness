// Unit tests for src/extensions/drafts-handler.ts.
//
// Mirrors the append-message-handler test pattern: real PGlite +
// drizzle, mock only db/connection. Verifies the full enforcement
// ladder (bundled-allowlist gate, custom.drafts.kinds gate, kind
// allowlist, ttl bounds) plus the happy-path side effect (row landed
// in `ez_drafts`).

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";

mock.module("../../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

// Stub the shared install pipeline — its own branches are unit-tested
// in `src/__tests__/author-install.test.ts`. Here we only assert the
// `install` action's routing, owner-context plumbing, and error
// mapping. The exported `AuthorInstallError` MUST be the same class
// the handler's `instanceof` checks against, so the handler (which
// imports it from this same mocked module) maps it correctly.
class MockAuthorInstallError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AuthorInstallError";
    this.code = code;
    if (details) this.details = details;
  }
}
let installAuthoredDraftImpl: (a: {
  draftId: string;
  userId: string;
  enable: boolean;
}) => Promise<{
  extensionId: string;
  name: string;
  redirectUrl: string;
  openUrl?: string;
}> = async () => ({
  extensionId: "ext-x",
  name: "weather",
  redirectUrl: "/extensions/weather",
});
let lastInstallArgs: { draftId: string; userId: string; enable: boolean } | null =
  null;
mock.module("../author-install", () => ({
  AuthorInstallError: MockAuthorInstallError,
  installAuthoredDraft: (a: { draftId: string; userId: string; enable: boolean }) => {
    lastInstallArgs = a;
    return installAuthoredDraftImpl(a);
  },
}));

const { handleDraftsRpc, BUNDLED_DRAFTS_ALLOWLIST } = await import("../drafts-handler");
const { getDb } = await import("../../db/connection");
const { ezDrafts, users } = await import("../../db/schema");
const { eq } = await import("drizzle-orm");

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonRpcRequest, ExtensionPermissions } from "../types";
import type { DraftsContext } from "../drafts-handler";

const ALLOWED_NAME = "extension-author";
const FORGED_NAME = "evil-extension";
const USER = "user-drafts";
const OTHER_USER = "user-drafts-other";

// Minimal allowlisted scaffold map. extension-author drafts are now
// host-materialized — `create` REQUIRES `files`, and the handler
// writes them under getExtensionAuthorDraftDir(). Tests that only
// need a draft row as a fixture pass this.
const AUTHOR_FILES: Record<string, string> = {
  "ezcorp.config.ts": "export default {};\n",
  "index.ts": "// scaffold\n",
};

function makePerms(kinds?: string[]): ExtensionPermissions {
  const perms: ExtensionPermissions = { grantedAt: {} };
  if (kinds) perms.custom = { drafts: { kinds } };
  return perms;
}

function makeCtx(overrides: Partial<DraftsContext> = {}): DraftsContext {
  return {
    userId: overrides.userId ?? USER,
    grantedPermissions: overrides.grantedPermissions ?? makePerms(["extension"]),
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/drafts", params };
}

// Host-owned create now writes files via findProjectRoot(cwd). chdir
// to a .git-free temp dir so materialization lands in an isolated
// tree, never the real repo's gitignored .ezcorp/.
let _prevCwd = "";
let _tmpRoot = "";

beforeAll(async () => {
  _tmpRoot = mkdtempSync(join(tmpdir(), "drafts-handler-"));
  _prevCwd = process.cwd();
  process.chdir(_tmpRoot);
  await setupTestDb();
  await getDb().insert(users).values({
    id: USER,
    email: `${USER}@t.local`,
    passwordHash: "x",
    name: USER,
  } as never).onConflictDoNothing();
  await getDb().insert(users).values({
    id: OTHER_USER,
    email: `${OTHER_USER}@t.local`,
    passwordHash: "x",
    name: OTHER_USER,
  } as never).onConflictDoNothing();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
  if (_prevCwd) try { process.chdir(_prevCwd); } catch { /* */ }
  if (_tmpRoot) try { rmSync(_tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

// ── Bundled-allowlist gate ─────────────────────────────────────────

describe("ezcorp/drafts — bundled-allowlist gate", () => {
  test("allowlist contains 'extension-author'", () => {
    expect(BUNDLED_DRAFTS_ALLOWLIST.has("extension-author")).toBe(true);
  });

  test("non-bundled name → -32603", async () => {
    const resp = await handleDraftsRpc(
      FORGED_NAME,
      rpc({ action: "create", kind: "extension", payload: { x: 1 } }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(/bundled-only/);
  });

  test("name check is case-sensitive (no normalization)", async () => {
    const resp = await handleDraftsRpc(
      "Extension-Author",
      rpc({ action: "create", kind: "extension", payload: { x: 1 } }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32603);
  });
});

// ── custom.drafts.kinds permission gate ────────────────────────────

describe("ezcorp/drafts — custom.drafts.kinds gate", () => {
  test("granted.custom missing → -32603", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", kind: "extension", payload: { x: 1 } }),
      makeCtx({ grantedPermissions: makePerms() }),
    );
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(/custom\.drafts\.kinds/);
  });

  test("granted.custom.drafts.kinds non-array → -32603", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", kind: "extension", payload: { x: 1 } }),
      makeCtx({
        grantedPermissions: {
          grantedAt: {},
          custom: { drafts: { kinds: "not-an-array" as unknown as string[] } },
        },
      }),
    );
    expect(resp.error?.code).toBe(-32603);
  });

  test("kind not in declared kinds → -32603", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      // declared kinds = ["agent"], request kind = "extension"
      rpc({ action: "create", kind: "extension", payload: { x: 1 } }),
      makeCtx({ grantedPermissions: makePerms(["agent"]) }),
    );
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(/not in granted/);
  });
});

// ── Param validation ───────────────────────────────────────────────

describe("ezcorp/drafts — param validation", () => {
  test("missing action → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({}),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("unknown action → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "bogus" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("create: missing kind → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", payload: { x: 1 } }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("create: unknown kind → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", kind: "weird", payload: { x: 1 } }),
      makeCtx({ grantedPermissions: makePerms(["weird"]) }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/Unknown kind/);
  });

  test("create: missing payload → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", kind: "extension" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("create: array payload → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", kind: "extension", payload: [1, 2] }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("create: ttlMs non-positive → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", kind: "extension", payload: { x: 1 }, ttlMs: 0 }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("create: ttlMs > 30-day cap → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", kind: "extension", payload: { x: 1 }, ttlMs: 100 * 24 * 60 * 60 * 1000 }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/30-day cap/);
  });
});

// ── Happy path ─────────────────────────────────────────────────────

describe("ezcorp/drafts — create happy path", () => {
  test("host-owned: persists row, materializes files on disk, stamps draftDir", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({
        action: "create",
        kind: "extension",
        payload: { name: "weather", type: "tool", mode: "author" },
        files: {
          "ezcorp.config.ts": "export default { name: 'weather' };\n",
          "index.ts": "// weather entry\n",
          "README.md": "# weather\n",
        },
      }, "create-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { draftId: string; openUrl: string };
    expect(typeof result.draftId).toBe("string");
    expect(result.draftId.length).toBeGreaterThan(0);
    expect(result.openUrl).toBe(`/extensions/author?prefill=${result.draftId}`);

    const rows = await getDb().select().from(ezDrafts).where(eq(ezDrafts.id, result.draftId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(USER);
    expect(rows[0]!.kind).toBe("extension");
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.name).toBe("weather");
    expect(payload.mode).toBe("author");

    // The host stamped the REAL materialized dir into the payload …
    const draftDir = payload.draftDir as string;
    expect(typeof draftDir).toBe("string");
    expect(draftDir).toContain(
      `/.ezcorp/extension-data/extension-author/drafts/${USER}/${result.draftId}`,
    );
    // … and actually wrote the files there (the deterministic path —
    // the sandboxed subprocess did zero fs).
    expect(existsSync(draftDir)).toBe(true);
    expect(readFileSync(join(draftDir, "ezcorp.config.ts"), "utf-8")).toBe(
      "export default { name: 'weather' };\n",
    );
    expect(readFileSync(join(draftDir, "README.md"), "utf-8")).toBe("# weather\n");
  });

  test("author draft WITHOUT files → -32602 (fail fast, no row minted)", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({
        action: "create",
        kind: "extension",
        payload: { name: "nofiles", type: "tool", mode: "author" },
      }, "create-nofiles"),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/files/i);
    // No row leaked for this name.
    const rows = await getDb()
      .select()
      .from(ezDrafts)
      .where(eq(ezDrafts.userId, USER));
    expect(
      rows.some(
        (r: { payload: unknown }) =>
          (r.payload as Record<string, unknown>)?.name === "nofiles",
      ),
    ).toBe(false);
  });

  test("bad path in files → -32603 and the row is rolled back (no orphan)", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({
        action: "create",
        kind: "extension",
        payload: { name: "evil", type: "tool", mode: "author" },
        files: { "../escape.ts": "pwned" },
      }, "create-evil"),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(/materialize/i);
    // Transactional: the row minted before materialization is discarded.
    const rows = await getDb()
      .select()
      .from(ezDrafts)
      .where(eq(ezDrafts.userId, USER));
    const evil = rows.find(
      (r: { payload: unknown }) =>
        (r.payload as Record<string, unknown>)?.name === "evil",
    ) as { consumedAt: Date | null } | undefined;
    // discardDraftAndDir consumes the row; it must not be a live draft.
    expect(evil?.consumedAt ?? null).not.toBeNull();
  });

  test("ttlMs override is honored", async () => {
    const customTtl = 60 * 1000; // 1 minute
    const before = Date.now();
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({
        action: "create",
        kind: "extension",
        payload: { x: 1 },
        ttlMs: customTtl,
      }, "ttl-1"),
      makeCtx(),
    );
    const after = Date.now();
    expect(resp.error).toBeUndefined();
    const result = resp.result as { draftId: string };
    const rows = await getDb().select().from(ezDrafts).where(eq(ezDrafts.id, result.draftId));
    const expiresAt = rows[0]!.expiresAt.getTime();
    // Expires at: createdAt + ttlMs ⇒ in [before+ttlMs, after+ttlMs]
    expect(expiresAt).toBeGreaterThanOrEqual(before + customTtl - 50); // small slop
    expect(expiresAt).toBeLessThanOrEqual(after + customTtl + 50);
  });

  test("open URL is kind-specific", async () => {
    // declared kinds includes 'project' for this scenario
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", kind: "project", payload: { name: "p" } }, "url-proj"),
      makeCtx({ grantedPermissions: makePerms(["project"]) }),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { openUrl: string };
    expect(result.openUrl).toMatch(/^\/projects\/new\?prefill=/);
  });
});

// ── Consume ────────────────────────────────────────────────────────

describe("ezcorp/drafts — consume", () => {
  test("consume: missing draftId → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "consume" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("consume: unknown id → { ok: false }", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "consume", draftId: "00000000-0000-0000-0000-000000000000" }),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    expect((resp.result as { ok: boolean }).ok).toBe(false);
  });

  test("consume: existing-id-by-owner → { ok: true } and is idempotent", async () => {
    // Mint a draft first.
    const create = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", kind: "extension", payload: { x: 1 } }, "c-1"),
      makeCtx(),
    );
    const draftId = (create.result as { draftId: string }).draftId;

    const first = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "consume", draftId }, "c-2"),
      makeCtx(),
    );
    expect((first.result as { ok: boolean }).ok).toBe(true);

    // Idempotent re-consume by the same owner.
    const second = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "consume", draftId }, "c-3"),
      makeCtx(),
    );
    expect((second.result as { ok: boolean }).ok).toBe(true);
  });

  test("consume: another user's draft → { ok: false } (owner-scoped)", async () => {
    const create = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "create", kind: "extension", payload: { x: 2 } }, "owner-1"),
      makeCtx({ userId: USER }),
    );
    const draftId = (create.result as { draftId: string }).draftId;

    const stranger = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "consume", draftId }, "owner-2"),
      makeCtx({ userId: OTHER_USER }),
    );
    expect((stranger.result as { ok: boolean }).ok).toBe(false);
  });
});

// ── resolveDir (owner-scoped path resolver) ───────────────────────────

describe("ezcorp/drafts — resolveDir", () => {
  test("missing draftId → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "resolveDir" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("non-existent draftId → -32603 (opaque)", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "resolveDir", draftId: "00000000-0000-0000-0000-000000000000" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(/not found/i);
  });

  test("owner: returns draftDir under drafts/<userId>/<draftId>", async () => {
    const create = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc(
        {
          action: "create",
          kind: "extension",
          payload: { name: "x", type: "tool", mode: "author" },
          files: AUTHOR_FILES,
        },
        "rd-1",
      ),
      makeCtx({ userId: USER }),
    );
    const draftId = (create.result as { draftId: string }).draftId;

    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "resolveDir", draftId }, "rd-2"),
      makeCtx({ userId: USER }),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { draftDir: string };
    expect(result.draftDir).toContain(`/.ezcorp/extension-data/extension-author/drafts/${USER}/${draftId}`);
  });

  test("non-owner: -32603 (opacity — same as missing)", async () => {
    const create = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc(
        {
          action: "create",
          kind: "extension",
          payload: { name: "x", type: "tool", mode: "author" },
          files: AUTHOR_FILES,
        },
        "rd-3",
      ),
      makeCtx({ userId: USER }),
    );
    const draftId = (create.result as { draftId: string }).draftId;

    const stranger = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "resolveDir", draftId }, "rd-4"),
      makeCtx({ userId: OTHER_USER }),
    );
    expect(stranger.error?.code).toBe(-32603);
    expect(stranger.error?.message).toMatch(/not found/i);
  });

  test("non-author draft (e.g. agent kind) → -32603", async () => {
    const create = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc(
        { action: "create", kind: "agent", payload: { name: "a" } },
        "rd-5",
      ),
      makeCtx({
        userId: USER,
        grantedPermissions: makePerms(["agent"]),
      }),
    );
    const draftId = (create.result as { draftId: string }).draftId;
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "resolveDir", draftId }, "rd-6"),
      makeCtx({ userId: USER }),
    );
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(/directory/i);
  });
});

// ── listForUser (caller-scoped active list) ───────────────────────────

describe("ezcorp/drafts — listForUser", () => {
  test("returns only caller's extension-author drafts (not OTHER_USER's)", async () => {
    await handleDraftsRpc(
      ALLOWED_NAME,
      rpc(
        {
          action: "create",
          kind: "extension",
          payload: { name: "mine-1", type: "tool", mode: "author" },
          files: AUTHOR_FILES,
        },
        "lf-1",
      ),
      makeCtx({ userId: USER }),
    );
    await handleDraftsRpc(
      ALLOWED_NAME,
      rpc(
        {
          action: "create",
          kind: "extension",
          payload: { name: "theirs-1", type: "tool", mode: "author" },
          files: AUTHOR_FILES,
        },
        "lf-2",
      ),
      makeCtx({ userId: OTHER_USER }),
    );

    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "listForUser" }, "lf-3"),
      makeCtx({ userId: USER }),
    );
    const drafts = (resp.result as { drafts: Array<{ name?: string }> }).drafts;
    const names = drafts.map((d) => d.name);
    expect(names).toContain("mine-1");
    expect(names).not.toContain("theirs-1");
  });
});

// ── discard (consume + dir removal) ────────────────────────────────────

describe("ezcorp/drafts — discard", () => {
  test("missing draftId → -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "discard" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("non-owner: -32603 (no row removal)", async () => {
    const create = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc(
        {
          action: "create",
          kind: "extension",
          payload: { name: "x", type: "tool", mode: "author" },
          files: AUTHOR_FILES,
        },
        "dc-1",
      ),
      makeCtx({ userId: USER }),
    );
    const draftId = (create.result as { draftId: string }).draftId;
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "discard", draftId }, "dc-2"),
      makeCtx({ userId: OTHER_USER }),
    );
    expect(resp.error?.code).toBe(-32603);
    // Row still present (not consumed by stranger).
    const rows = await getDb().select().from(ezDrafts).where(eq(ezDrafts.id, draftId));
    expect(rows[0]!.consumedAt).toBeNull();
  });

  test("owner: returns { ok: true } and consumes row", async () => {
    const create = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc(
        {
          action: "create",
          kind: "extension",
          payload: { name: "x", type: "tool", mode: "author" },
          files: AUTHOR_FILES,
        },
        "dc-3",
      ),
      makeCtx({ userId: USER }),
    );
    const draftId = (create.result as { draftId: string }).draftId;
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "discard", draftId }, "dc-4"),
      makeCtx({ userId: USER }),
    );
    expect(resp.error).toBeUndefined();
    expect((resp.result as { ok: boolean }).ok).toBe(true);
    const rows = await getDb().select().from(ezDrafts).where(eq(ezDrafts.id, draftId));
    expect(rows[0]!.consumedAt).not.toBeNull();
  });
});

// ── install (agent-driven, gated upstream by the permission card) ──

describe("ezcorp/drafts \u2014 install", () => {
  test("missing draftId \u2192 -32602", async () => {
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "install" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("success \u2192 {ok,extensionId,name}; passes ctx.userId + enable:true", async () => {
    installAuthoredDraftImpl = async () => ({
      extensionId: "ext-installed",
      name: "weather",
      redirectUrl: "/extensions/weather",
    });
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "install", draftId: "d-ok" }, "i-1"),
      makeCtx({ userId: USER }),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ ok: true, extensionId: "ext-installed", name: "weather" });
    expect(lastInstallArgs).toEqual({ draftId: "d-ok", userId: USER, enable: true });
  });

  test("openUrl from pipeline is surfaced in the tool result (Phase 1 D1/D2)", async () => {
    installAuthoredDraftImpl = async () => ({
      extensionId: "ext-installed",
      name: "weather",
      redirectUrl: "/extensions/weather",
      // The pipeline emits this only when the host NAME_REGEX
      // re-check passed; the handler must pass it through verbatim.
      openUrl: "/extensions/weather",
    });
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "install", draftId: "d-ok" }, "i-url"),
      makeCtx({ userId: USER }),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({
      ok: true,
      extensionId: "ext-installed",
      name: "weather",
      openUrl: "/extensions/weather",
    });
  });

  test("openUrl omitted by pipeline \u2192 omitted from tool result (no malformed URL)", async () => {
    installAuthoredDraftImpl = async () => ({
      extensionId: "ext-installed",
      name: "weather",
      redirectUrl: "/extensions/weather",
      // openUrl intentionally absent (pipeline withheld it).
    });
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "install", draftId: "d-ok" }, "i-nourl"),
      makeCtx({ userId: USER }),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({
      ok: true,
      extensionId: "ext-installed",
      name: "weather",
    });
    expect("openUrl" in (resp.result as Record<string, unknown>)).toBe(false);
  });

  test("AuthorInstallError \u2192 -32603 with code-prefixed message", async () => {
    installAuthoredDraftImpl = async () => {
      throw new MockAuthorInstallError("VERIFY_FAILED", "smoke-test failed");
    };
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "install", draftId: "d-bad" }, "i-2"),
      makeCtx({ userId: USER }),
    );
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toContain("VERIFY_FAILED");
    expect(resp.error?.message).toContain("smoke-test failed");
  });

  test("unexpected (non-AuthorInstallError) throw \u2192 -32603 generic", async () => {
    installAuthoredDraftImpl = async () => {
      throw new Error("kaboom");
    };
    const resp = await handleDraftsRpc(
      ALLOWED_NAME,
      rpc({ action: "install", draftId: "d-x" }, "i-3"),
      makeCtx({ userId: USER }),
    );
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toContain("Install failed");
  });
});

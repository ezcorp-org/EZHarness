/**
 * Server-handler tests for `/api/extensions/author/install/+server.ts`.
 *
 * Drives every branch:
 *   - auth gate (401 via requireAuth throw)
 *   - missing draftId (400)
 *   - draft not found (404, owner-scoped)
 *   - manifest missing / invalid (422 with errors)
 *   - name collision pre-install (409, dir not moved)
 *   - install path collision (409)
 *   - env-key-leak gate (422 with leakedNames)
 *   - happy path (201, draft consumed, redirect URL)
 */

import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Module mocks (BEFORE the route import) ─────────────────────────

const draftStore = new Map<string, { userId: string; kind: string; payload: unknown; consumed: boolean }>();
let mockGetExtensionByName = vi.fn(async (_name: string) => null as { id: string } | null);
let mockInstallFromLocal = vi.fn(async () => ({ id: "ext-installed", name: "weather" }));
let mockReload = vi.fn(async () => undefined);
// Per-test stub for the DETERMINISTIC verify gate. Default: PASS so the
// non-verify branches (auth/param/collision/env-leak) still exercise the
// happy path. Per-test overrides simulate FAIL (missing/failing
// smokeTest). `verifySpy` records each call so skill/agent skip can be
// asserted.
let mockVerifyResult: () => Promise<{
  pass: boolean;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
}> = async () => ({
  pass: true,
  steps: [
    { name: "load-manifest", ok: true, detail: "ok" },
    { name: "validate-manifest", ok: true, detail: "ok" },
    { name: "smoke-test-present", ok: true, detail: "ok" },
    { name: "smoke-test-roundtrip", ok: true, detail: "ok" },
  ],
});
const verifySpy = vi.fn();

vi.mock("$server/auth/middleware", () => ({
  requireAuth: vi.fn((locals: { user?: { id: string } }) => {
    if (!locals.user) throw new Response("unauth", { status: 401 });
    return locals.user;
  }),
}));

vi.mock("$lib/server/security/api-keys", () => ({
  requireScope: vi.fn(() => null),
}));

vi.mock("$server/db/queries/ez-drafts", async () => {
  const { join } = await import("node:path");
  return {
    getDraft: vi.fn(async (id: string, userId: string) => {
      const row = draftStore.get(id);
      if (!row) return undefined;
      if (row.userId !== userId) return undefined;
      return {
        id,
        userId,
        kind: row.kind,
        payload: row.payload,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      };
    }),
    consumeDraft: vi.fn(async (id: string) => {
      const r = draftStore.get(id);
      if (r) r.consumed = true;
      return r ? { id, userId: r.userId, kind: r.kind, payload: r.payload, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), consumedAt: new Date() } : undefined;
    }),
    // The install endpoint resolves the on-disk dir via this helper.
    // Mirrors prod layout: drafts/<userId>/<draftId> (was: drafts/<draftId>).
    getExtensionAuthorDraftDir: vi.fn((id: string, userId: string) =>
      join(DRAFT_ROOT, userId, id),
    ),
  };
});

vi.mock("$server/extensions/loader", () => ({
  loadManifest: vi.fn(async (dir: string) => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cfgPath = join(dir, "ezcorp.config.ts");
    if (!existsSync(cfgPath)) throw new Error(`No ezcorp.config.ts found at ${dir}`);
    const src = readFileSync(cfgPath, "utf8");
    if (!src.includes("defineExtension")) {
      throw new Error("ezcorp.config.ts must have a default export");
    }
    // Match top-level `name: "..."` only — the `author: { name: "..." }`
    // line is indented deeper, so anchor on `\n  name:` (two-space top
    // level field). Tests use 2-space indent throughout.
    const topNameMatch = src.match(/\n {2}name:\s*"([^"]+)"/);
    if (!topNameMatch) {
      throw new Error("Invalid manifest: name required");
    }
    return {
      schemaVersion: 2,
      name: topNameMatch[1],
      version: "0.1.0",
      description: "x",
      author: { name: "x" },
      permissions: {},
    };
  }),
}));

vi.mock("$server/db/queries/extensions", () => ({
  getExtensionByName: (...args: unknown[]) => mockGetExtensionByName(...args as [string]),
}));

vi.mock("$server/extensions/installer", () => ({
  installFromLocal: (...args: unknown[]) => mockInstallFromLocal(...args as []),
}));

vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: mockReload }),
  },
}));

// Mock the deterministic verify gate so the endpoint doesn't spawn a
// real subprocess during tests. Each test swaps `mockVerifyResult` to
// simulate PASS / FAIL. `verifySpy` records invocation so skill/agent
// skip can be asserted (verify is NOT called for those kinds).
vi.mock("$server/extensions/sdk/verify", () => ({
  verifyExtension: vi.fn(async () => {
    verifySpy();
    return mockVerifyResult();
  }),
}));

vi.mock("$server/extensions/manifest", () => ({
  validateManifestV2: (data: unknown) => {
    if (!data || typeof data !== "object") return { valid: false, errors: ["not an object"] };
    const m = data as Record<string, unknown>;
    const errs: string[] = [];
    if (!m.name) errs.push("name required");
    if (!m.version) errs.push("version required");
    return { valid: errs.length === 0, errors: errs };
  },
}));

import { POST } from "../routes/api/extensions/author/install/+server";

// ── Test fixtures ──────────────────────────────────────────────────

let TMP: string;
let DRAFT_ROOT: string;
let INSTALL_ROOT: string;
const USER = { id: "user-x", email: "x@x", name: "X", role: "member" };

function makeReq(body: unknown, locals: Partial<{ user: typeof USER }> = { user: USER }): never {
  return {
    request: new Request("http://x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals,
    params: {},
    url: new URL("http://x"),
    route: { id: "/api/extensions/author/install" },
    fetch: globalThis.fetch,
    cookies: {} as never,
    getClientAddress: () => "127.0.0.1",
    isDataRequest: false,
    isSubRequest: false,
    setHeaders: () => {},
    platform: undefined,
  } as never;
}

function seedDraft(id: string, userId: string, name: string, files: Record<string, string>): void {
  // New layout: drafts/<userId>/<draftId> (reviewer C1).
  const dir = join(DRAFT_ROOT, userId, id);
  draftStore.set(id, {
    userId,
    kind: "extension",
    payload: { name, type: "tool", mode: "author", draftDir: dir },
    consumed: false,
  });
  mkdirSync(dir, { recursive: true });
  for (const [n, c] of Object.entries(files)) {
    writeFileSync(join(dir, n), c, "utf8");
  }
}

const validManifestSrc = (name: string) => `import { defineExtension } from "@ezcorp/sdk";
export default defineExtension({
  schemaVersion: 2,
  name: "${name}",
  version: "0.1.0",
  description: "x",
  author: { name: "x" },
  permissions: {},
});
`;

beforeEach(() => {
  TMP = join(tmpdir(), `ext-author-install-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  // Pretend repo root is here. The endpoint walks up looking for `.git`.
  mkdirSync(join(TMP, ".git"), { recursive: true });
  DRAFT_ROOT = join(TMP, ".ezcorp/extension-data/extension-author/drafts");
  INSTALL_ROOT = join(TMP, ".ezcorp/extensions");
  mkdirSync(DRAFT_ROOT, { recursive: true });
  process.chdir(TMP);

  draftStore.clear();
  mockGetExtensionByName = vi.fn(async () => null);
  mockInstallFromLocal = vi.fn(async () => ({ id: "ext-installed", name: "weather" }));
  mockReload = vi.fn(async () => undefined);
  verifySpy.mockClear();
  // Reset the verify gate to PASS. Per-test overrides simulate FAIL.
  mockVerifyResult = async () => ({
    pass: true,
    steps: [
      { name: "load-manifest", ok: true, detail: "ok" },
      { name: "validate-manifest", ok: true, detail: "ok" },
      { name: "smoke-test-present", ok: true, detail: "ok" },
      { name: "smoke-test-roundtrip", ok: true, detail: "ok" },
    ],
  });
});

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* swallow */ }
});

// ── Tests ───────────────────────────────────────────────────────────

describe("POST /api/extensions/author/install — auth + param", () => {
  test("missing user → 401", async () => {
    const resp = await POST(makeReq({ draftId: "d1" }, {}));
    expect(resp.status).toBe(401);
  });

  test("missing draftId → 400", async () => {
    const resp = await POST(makeReq({}));
    expect(resp.status).toBe(400);
  });

  test("non-string draftId → 400", async () => {
    const resp = await POST(makeReq({ draftId: 42 }));
    expect(resp.status).toBe(400);
  });

  test("invalid JSON body → 400", async () => {
    const req = {
      request: new Request("http://x", { method: "POST", body: "{not-json" }),
      locals: { user: USER },
      params: {},
      url: new URL("http://x"),
    } as never;
    const resp = await POST(req);
    expect(resp.status).toBe(400);
  });
});

describe("POST /api/extensions/author/install — draft lookup", () => {
  test("unknown draftId → 404", async () => {
    const resp = await POST(makeReq({ draftId: "missing" }));
    expect(resp.status).toBe(404);
  });

  test("draft owned by another user → 404", async () => {
    seedDraft("d-other", "other-user", "weather", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-other" }));
    expect(resp.status).toBe(404);
  });

  test("draft kind != extension → 400", async () => {
    draftStore.set("d-bad-kind", { userId: USER.id, kind: "agent", payload: {}, consumed: false });
    const resp = await POST(makeReq({ draftId: "d-bad-kind" }));
    expect(resp.status).toBe(400);
  });

  test("draft directory missing on disk → 404", async () => {
    draftStore.set("d-no-dir", { userId: USER.id, kind: "extension", payload: {}, consumed: false });
    const resp = await POST(makeReq({ draftId: "d-no-dir" }));
    expect(resp.status).toBe(404);
  });
});

describe("POST /api/extensions/author/install — manifest validation", () => {
  test("missing ezcorp.config.ts → 422", async () => {
    seedDraft("d-no-cfg", USER.id, "weather", { "README.md": "x" });
    const resp = await POST(makeReq({ draftId: "d-no-cfg" }));
    expect(resp.status).toBe(422);
    const body = await resp.json();
    expect(body.errors).toContain("Missing ezcorp.config.ts");
  });

  test("manifest fails validateManifestV2 → 422 with errors", async () => {
    seedDraft("d-bad-manifest", USER.id, "x", {
      // Manifest missing name
      "ezcorp.config.ts": `import { defineExtension } from "@ezcorp/sdk";
export default defineExtension({
  schemaVersion: 2,
  version: "0.1.0",
  description: "x",
  author: { name: "x" },
  permissions: {},
});
`,
    });
    const resp = await POST(makeReq({ draftId: "d-bad-manifest" }));
    expect(resp.status).toBe(422);
    const body = await resp.json();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  test("manifest body throws on eval → 422", async () => {
    seedDraft("d-evil-manifest", USER.id, "x", {
      "ezcorp.config.ts": "this is not even javascript {",
    });
    const resp = await POST(makeReq({ draftId: "d-evil-manifest" }));
    expect(resp.status).toBe(422);
  });
});

describe("POST /api/extensions/author/install — name + path collision", () => {
  test("existing extension with same name → 409", async () => {
    mockGetExtensionByName = vi.fn(async () => ({ id: "preexisting" }));
    seedDraft("d-name-coll", USER.id, "weather", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-name-coll" }));
    expect(resp.status).toBe(409);
    // Draft dir not moved
    expect(existsSync(join(DRAFT_ROOT, USER.id, "d-name-coll"))).toBe(true);
  });

  test("install path already on disk → 409", async () => {
    seedDraft("d-path-coll", USER.id, "weather", { "ezcorp.config.ts": validManifestSrc("weather") });
    mkdirSync(join(INSTALL_ROOT, "weather"), { recursive: true });
    const resp = await POST(makeReq({ draftId: "d-path-coll" }));
    expect(resp.status).toBe(409);
    expect(existsSync(join(DRAFT_ROOT, USER.id, "d-path-coll"))).toBe(true);
  });
});

describe("POST /api/extensions/author/install — env-key-leak gate", () => {
  test("EnvKeyLeakInstallError → 422 with leakedNames", async () => {
    class FakeLeak extends Error {
      readonly leakedNames = ["MY_API_KEY"];
      constructor() {
        super("Install refused: env-key-leak");
        this.name = "EnvKeyLeakInstallError";
      }
    }
    mockInstallFromLocal = vi.fn(async () => {
      throw new FakeLeak();
    });
    seedDraft("d-leak", USER.id, "weather", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-leak" }));
    expect(resp.status).toBe(422);
    const body = await resp.json();
    expect(body.leakedNames).toEqual(["MY_API_KEY"]);
    // Rollback: draft dir restored to its original location
    expect(existsSync(join(DRAFT_ROOT, USER.id, "d-leak"))).toBe(true);
    // installFromLocal was attempted
    expect(mockInstallFromLocal).toHaveBeenCalledTimes(1);
  });

  test("generic install error → 422 with message", async () => {
    mockInstallFromLocal = vi.fn(async () => {
      throw new Error("Other failure");
    });
    seedDraft("d-other-fail", USER.id, "weather", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-other-fail" }));
    expect(resp.status).toBe(422);
    const body = await resp.json();
    expect(body.errors).toContain("Other failure");
  });
});

describe("POST /api/extensions/author/install — happy path", () => {
  test("201 + draft consumed + dir moved + redirectUrl", async () => {
    seedDraft("d-happy", USER.id, "weather", {
      "ezcorp.config.ts": validManifestSrc("weather"),
      "index.ts": "// stub",
    });
    const resp = await POST(makeReq({ draftId: "d-happy" }));
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.extensionId).toBe("ext-installed");
    expect(body.redirectUrl).toBe("/extensions/weather");

    // Draft consumed
    expect(draftStore.get("d-happy")?.consumed).toBe(true);
    // Files moved out of draft area
    expect(existsSync(join(DRAFT_ROOT, USER.id, "d-happy"))).toBe(false);
    // Files arrived at install path
    expect(existsSync(join(INSTALL_ROOT, "weather", "ezcorp.config.ts"))).toBe(true);
    expect(existsSync(join(INSTALL_ROOT, "weather", "index.ts"))).toBe(true);
    // Registry reloaded
    expect(mockReload).toHaveBeenCalledTimes(1);
    // installFromLocal received `enabled: false`
    expect(mockInstallFromLocal).toHaveBeenCalledWith(
      join(INSTALL_ROOT, "weather"),
      expect.objectContaining({ grantedAt: {} }),
      false,
      expect.objectContaining({ isBundled: false, envEscapeHatch: false }),
    );
  });

  test("registry reload failure is non-fatal (still 201)", async () => {
    mockReload = vi.fn(async () => {
      throw new Error("registry boom");
    });
    seedDraft("d-reload-fail", USER.id, "weather", {
      "ezcorp.config.ts": validManifestSrc("weather"),
    });
    const resp = await POST(makeReq({ draftId: "d-reload-fail" }));
    expect(resp.status).toBe(201);
  });
});

// ── Deterministic acceptance gate (Phase C — hard-fail) ──────────────

/**
 * Seed a draft with a specific payload.type so the install endpoint
 * picks the verify branch (tool/multi) or skips it (skill/agent).
 */
function seedDraftWithType(id: string, type: string, files: Record<string, string>): void {
  const dir = join(DRAFT_ROOT, USER.id, id);
  draftStore.set(id, {
    userId: USER.id,
    kind: "extension",
    payload: { name: "weather", type, mode: "author", draftDir: dir },
    consumed: false,
  });
  mkdirSync(dir, { recursive: true });
  for (const [n, c] of Object.entries(files)) {
    writeFileSync(join(dir, n), c, "utf8");
  }
}

const failingVerify = (failName: string, detail: string) => async () => ({
  pass: false,
  steps: [
    { name: "load-manifest", ok: true, detail: "ok" },
    { name: failName, ok: false, detail },
  ],
});

describe("POST /api/extensions/author/install — deterministic gate (Phase C)", () => {
  test("type=tool with passing smokeTest → 201 (verify invoked)", async () => {
    seedDraftWithType("d-tool-ok", "tool", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-tool-ok" }));
    expect(resp.status).toBe(201);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  test("type=multi with passing smokeTest → 201 (verify invoked)", async () => {
    seedDraftWithType("d-multi-ok", "multi", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-multi-ok" }));
    expect(resp.status).toBe(201);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  test("type=tool MISSING smokeTest → 422 hard-fail + VerifyResult body", async () => {
    mockVerifyResult = failingVerify(
      "smoke-test-present",
      "tool/multi extensions MUST declare a `smokeTest` block",
    );
    seedDraftWithType("d-tool-nosmoke", "tool", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-tool-nosmoke" }));
    expect(resp.status).toBe(422);
    const body = await resp.json();
    expect(body.verifyResult).toBeDefined();
    expect(body.verifyResult.pass).toBe(false);
    expect(body.errors[0]).toContain("smoke-test-present");
    // Install must NOT have proceeded.
    expect(mockInstallFromLocal).not.toHaveBeenCalled();
    // Draft dir NOT moved (still in place for the user to fix).
    expect(existsSync(join(DRAFT_ROOT, USER.id, "d-tool-nosmoke"))).toBe(true);
  });

  test("type=multi FAILING smokeTest round-trip → 422 hard-fail", async () => {
    mockVerifyResult = failingVerify(
      "smoke-test-roundtrip",
      "Smoke test failed: Expected isError=false, got isError=true",
    );
    seedDraftWithType("d-multi-fail", "multi", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-multi-fail" }));
    expect(resp.status).toBe(422);
    const body = await resp.json();
    expect(body.verifyResult.pass).toBe(false);
    expect(body.errors[0]).toContain("smoke-test-roundtrip");
    expect(mockInstallFromLocal).not.toHaveBeenCalled();
  });

  test("type=skill → verify SKIPPED, install proceeds (201)", async () => {
    seedDraftWithType("d-skill", "skill", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-skill" }));
    expect(resp.status).toBe(201);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  test("type=agent → verify SKIPPED, install proceeds (201)", async () => {
    seedDraftWithType("d-agent", "agent", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-agent" }));
    expect(resp.status).toBe(201);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  test("skill with FAILING verify stub still installs (verify not consulted)", async () => {
    // Defense-in-depth: even if the verify mock would fail, skill never
    // reaches the gate — proves the kind check, not the verdict, gates.
    mockVerifyResult = failingVerify("smoke-test-present", "would fail");
    seedDraftWithType("d-skill-2", "skill", { "ezcorp.config.ts": validManifestSrc("weather") });
    const resp = await POST(makeReq({ draftId: "d-skill-2" }));
    expect(resp.status).toBe(201);
    expect(verifySpy).not.toHaveBeenCalled();
  });
});

// ── N3: invalid draftId regex + missing prefill 400 paths ────────────

describe("POST /api/extensions/author/install — N3 input validation", () => {
  test("invalid draftId (path-traversal) → 400", async () => {
    const resp = await POST(makeReq({ draftId: "../escape" }));
    expect(resp.status).toBe(400);
  });

  test("invalid draftId (slash) → 400", async () => {
    const resp = await POST(makeReq({ draftId: "a/b" }));
    expect(resp.status).toBe(400);
  });

  test("invalid draftId (empty string) → 400", async () => {
    const resp = await POST(makeReq({ draftId: "" }));
    expect(resp.status).toBe(400);
  });
});

/**
 * Server-handler tests for the editable preview page's API endpoints:
 *   - PUT    /api/extensions/author/draft/[id] — save edits
 *   - DELETE /api/extensions/author/draft/[id] — discard
 *   - POST   /api/extensions/author/draft/[id]/validate — manifest check
 *
 * The +page.server.ts loader (read-only) is exercised via direct test
 * helpers — vitest's `+page.server.ts`-load-mocking would require a
 * SvelteKit-aware harness we don't ship. The PUT/DELETE/validate path
 * coverage is what matters; the loader is thin.
 */

import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const draftStore = new Map<string, { userId: string; kind: string; payload: unknown; consumedAt: Date | null }>();

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
  const { existsSync } = await import("node:fs");
  const { rm } = await import("node:fs/promises");
  return {
    getDraft: vi.fn(async (id: string, userId: string) => {
      const r = draftStore.get(id);
      if (!r) return undefined;
      if (r.userId !== userId) return undefined;
      return {
        id,
        userId,
        kind: r.kind,
        payload: r.payload,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: r.consumedAt,
      };
    }),
    consumeDraft: vi.fn(async (id: string, userId: string) => {
      const r = draftStore.get(id);
      if (!r || r.userId !== userId) return undefined;
      r.consumedAt = new Date();
      return {
        id,
        userId,
        kind: r.kind,
        payload: r.payload,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: r.consumedAt,
      };
    }),
    // The +server.ts and +page.server.ts modules now import this
    // helper to compute the userId-namespaced dir. Mirror the
    // production layout exactly so the tests touch the real path.
    getExtensionAuthorDraftDir: vi.fn((id: string, userId: string) =>
      join(DRAFT_ROOT, userId, id),
    ),
    discardDraftAndDir: vi.fn(async (id: string, userId: string) => {
      const r = draftStore.get(id);
      if (!r || r.userId !== userId) return { ok: false };
      r.consumedAt = new Date();
      const dir = join(DRAFT_ROOT, userId, id);
      if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
      return { ok: true };
    }),
  };
});

vi.mock("$server/extensions/manifest", () => ({
  validateManifestV2: (data: unknown) => {
    if (!data || typeof data !== "object") return { valid: false, errors: ["not an object"] };
    const m = data as Record<string, unknown>;
    const errs: string[] = [];
    if (!m.name) errs.push("name required");
    return { valid: errs.length === 0, errors: errs };
  },
}));

// `loadManifest` lives in $server/extensions/loader. The real impl
// does a child-process import; mock it with a stub that reads the
// file from disk and applies the validate stub above. This keeps the
// "no `new Function`" contract end-to-end while letting tests drive
// happy-path / failure cases via fixture content.
vi.mock("$server/extensions/loader", () => ({
  // Validate is the edit→revalidate loop: it MUST cache-bust. A
  // regression back to `loadManifest` throws here instead of silently
  // re-validating pre-edit bytes.
  loadManifest: vi.fn(() => {
    throw new Error("validate must call loadManifestFresh, not loadManifest");
  }),
  loadManifestFresh: vi.fn(async (dir: string) => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cfgPath = join(dir, "ezcorp.config.ts");
    if (!existsSync(cfgPath)) throw new Error(`No ezcorp.config.ts found at ${dir}`);
    const src = readFileSync(cfgPath, "utf8");
    if (!src.includes("defineExtension")) {
      throw new Error("ezcorp.config.ts must have a default export");
    }
    // Match top-level `\n  name: "..."` only (2-space indent). The
    // `author: { name: "..." }` line is deeper so won't match.
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

// Validate now runs the host's FULL acceptance gate (the same one
// install runs), which for a tool/multi draft spawns a sandboxed
// round-trip. Mock the round-trip so these tests stay hermetic; each
// case swaps `mockVerify` to drive PASS/FAIL.
let mockVerify: () => { pass: boolean; steps: Array<{ name: string; ok: boolean; detail: string }> } =
  () => ({
    pass: true,
    steps: [
      { name: "load-manifest", ok: true, detail: "Loaded weather@0.1.0" },
      { name: "smoke-test-roundtrip", ok: true, detail: "round-tripped" },
    ],
  });
vi.mock("$server/extensions/sdk/verify", () => ({
  verifyExtension: vi.fn(async () => mockVerify()),
}));

// The route handlers expect their generated RequestEvent type. We pass
// fixtures typed as `never` (compatible with anything) to avoid pinning
// each call site to a specific route literal — the test never asserts
// on params/url shape, only on the response.
import { PUT, DELETE } from "../routes/api/extensions/author/draft/[id]/+server";
import { POST as validatePOST } from "../routes/api/extensions/author/draft/[id]/validate/+server";

let TMP: string;
let DRAFT_ROOT: string;
const USER = { id: "user-x", email: "x@x", name: "X", role: "member" };

function makeReq(opts: {
  body?: unknown;
  /** Pass `null` to simulate an unauthenticated request. Default = USER. */
  user?: typeof USER | null;
  params?: Record<string, string>;
  method?: string;
}): never {
  const init: RequestInit = { method: opts.method ?? "PUT" };
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  return {
    request: new Request("http://x", init),
    locals: opts.user === null ? {} : { user: opts.user ?? USER },
    params: opts.params ?? { id: "d1" },
    url: new URL("http://x"),
  } as never;
}

function seedDraft(id: string, userId: string, files: Record<string, string>): void {
  // New layout: `drafts/<userId>/<draftId>/` (was: `drafts/<draftId>/`).
  // Owner-scoping is enforced in the path itself — reviewer C1 fix.
  const dir = join(DRAFT_ROOT, userId, id);
  draftStore.set(id, {
    userId,
    kind: "extension",
    payload: { name: "weather", type: "tool", mode: "author", draftDir: dir },
    consumedAt: null,
  });
  mkdirSync(dir, { recursive: true });
  for (const [n, c] of Object.entries(files)) {
    writeFileSync(join(dir, n), c, "utf8");
  }
}

const validManifestSrc = `import { defineExtension } from "@ezcorp/sdk";
export default defineExtension({
  schemaVersion: 2,
  name: "weather",
  version: "0.1.0",
  description: "x",
  author: { name: "x" },
  permissions: {},
});
`;

beforeEach(() => {
  TMP = join(tmpdir(), `ext-author-page-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(join(TMP, ".git"), { recursive: true });
  DRAFT_ROOT = join(TMP, ".ezcorp/extension-data/extension-author/drafts");
  mkdirSync(DRAFT_ROOT, { recursive: true });
  process.chdir(TMP);
  draftStore.clear();
  mockVerify = () => ({
    pass: true,
    steps: [
      { name: "load-manifest", ok: true, detail: "Loaded weather@0.1.0" },
      { name: "smoke-test-roundtrip", ok: true, detail: "round-tripped" },
    ],
  });
});

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* swallow */ }
});

// ── PUT /api/extensions/author/draft/[id] ─────────────────────────

describe("PUT — save edits", () => {
  test("missing user → 401", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": validManifestSrc });
    const resp = await PUT(makeReq({ body: { path: "README.md", content: "x" }, user: null }));
    expect(resp.status).toBe(401);
  });

  test("non-string path → 400", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": validManifestSrc });
    const resp = await PUT(makeReq({ body: { path: 42, content: "x" } }));
    expect(resp.status).toBe(400);
  });

  test("path outside allowlist → 400", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": validManifestSrc });
    const resp = await PUT(makeReq({ body: { path: "secret.key", content: "x" } }));
    expect(resp.status).toBe(400);
  });

  test("path with .. → 400", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": validManifestSrc });
    const resp = await PUT(makeReq({ body: { path: "../escape", content: "x" } }));
    expect(resp.status).toBe(400);
  });

  test("draft not found → 404", async () => {
    const resp = await PUT(makeReq({ body: { path: "README.md", content: "x" } }));
    expect(resp.status).toBe(404);
  });

  test("happy path: writes file + returns ok", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": validManifestSrc });
    const resp = await PUT(makeReq({ body: { path: "README.md", content: "# Patched" } }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(readFileSync(join(DRAFT_ROOT, USER.id, "d1", "README.md"), "utf8")).toBe("# Patched");
  });

  test("subsequent load reflects edit (round-trip via _readDraftFiles)", async () => {
    seedDraft("d1", USER.id, { "README.md": "old" });
    await PUT(makeReq({ body: { path: "README.md", content: "new" } }));
    const { _readDraftFiles } = await import("../routes/api/extensions/author/draft/[id]/+server");
    const files = _readDraftFiles(join(DRAFT_ROOT, USER.id, "d1"));
    expect(files["README.md"]).toBe("new");
  });

  test("invalid JSON body → 400", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": validManifestSrc });
    const req = {
      request: new Request("http://x", { method: "PUT", body: "{not-json" }),
      locals: { user: USER },
      params: { id: "d1" },
      url: new URL("http://x"),
    } as never;
    const resp = await PUT(req);
    expect(resp.status).toBe(400);
  });
});

// ── DELETE /api/extensions/author/draft/[id] ──────────────────────

describe("DELETE — discard", () => {
  test("missing user → 401", async () => {
    const resp = await DELETE(makeReq({ method: "DELETE", user: null }));
    expect(resp.status).toBe(401);
  });

  test("draft not found → 404", async () => {
    const resp = await DELETE(makeReq({ method: "DELETE" }));
    expect(resp.status).toBe(404);
  });

  test("happy path: 204 + dir removed + row consumed", async () => {
    seedDraft("d1", USER.id, { "README.md": "x" });
    const resp = await DELETE(makeReq({ method: "DELETE" }));
    expect(resp.status).toBe(204);
    expect(existsSync(join(DRAFT_ROOT, USER.id, "d1"))).toBe(false);
    expect(draftStore.get("d1")?.consumedAt).not.toBeNull();
  });
});

// ── POST /api/extensions/author/draft/[id]/validate ───────────────

describe("POST validate — full acceptance gate", () => {
  test("missing draft → 404", async () => {
    const resp = await validatePOST(makeReq({ method: "POST" }));
    expect(resp.status).toBe(404);
  });

  test("missing config file → ok:false", async () => {
    seedDraft("d1", USER.id, { "README.md": "x" });
    const resp = await validatePOST(makeReq({ method: "POST" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(false);
  });

  test("valid manifest + passing round-trip → ok:true, errors:[]", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": validManifestSrc });
    const resp = await validatePOST(makeReq({ method: "POST" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.errors).toEqual([]);
  });

  test("invalid manifest → ok:false with errors", async () => {
    seedDraft("d1", USER.id, {
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
    const resp = await validatePOST(makeReq({ method: "POST" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  test("malformed manifest body → ok:false", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": "this is not js {" });
    const resp = await validatePOST(makeReq({ method: "POST" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(false);
  });

  // H2: Validate used to run manifest validation ONLY, so a draft whose
  // smokeTest was broken validated green and then 422'd on Install.
  test("valid manifest but a FAILING smoke test → ok:false (same gate as install)", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": validManifestSrc });
    mockVerify = () => ({
      pass: false,
      steps: [
        { name: "load-manifest", ok: true, detail: "Loaded weather@0.1.0" },
        { name: "smoke-test-roundtrip", ok: false, detail: "Smoke test failed: boom" },
      ],
    });
    const resp = await validatePOST(makeReq({ method: "POST" }));
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.pass).toBe(false);
    expect(body.errors[0]).toContain("smoke-test-roundtrip");
  });

  test("returns the same { ok, pass, steps } shape as the in-chat validate tool", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": validManifestSrc });
    const body = await (await validatePOST(makeReq({ method: "POST" }))).json();
    expect(body.ok).toBe(true);
    expect(body.pass).toBe(true);
    expect(Array.isArray(body.steps)).toBe(true);
    for (const step of body.steps) {
      expect(typeof step.name).toBe("string");
      expect(typeof step.ok).toBe("boolean");
      expect(typeof step.detail).toBe("string");
    }
    expect(body.steps.some((s: { name: string }) => s.name === "load-manifest")).toBe(true);
  });

  // C3: the edit→revalidate loop hits the SAME draftId repeatedly. Every
  // other test in the suite mints a fresh id, so none of them could see
  // a validate that answered from a cached first read.
  test("re-validating the SAME draftId after an edit reflects the edit", async () => {
    seedDraft("d1", USER.id, { "ezcorp.config.ts": validManifestSrc });
    const first = await (await validatePOST(makeReq({ method: "POST" }))).json();
    expect(first.ok).toBe(true);

    // The author "breaks" the manifest through the normal save path.
    const save = await PUT(
      makeReq({
        body: {
          path: "ezcorp.config.ts",
          content: `import { defineExtension } from "@ezcorp/sdk";
export default defineExtension({
  schemaVersion: 2,
  version: "0.1.0",
  description: "x",
  author: { name: "x" },
  permissions: {},
});
`,
        },
      }),
    );
    expect(save.status).toBe(200);

    const second = await (await validatePOST(makeReq({ method: "POST" }))).json();
    expect(second.ok).toBe(false);
    expect(second.ok).not.toBe(first.ok);
    expect(second.errors.length).toBeGreaterThan(0);
  });
});

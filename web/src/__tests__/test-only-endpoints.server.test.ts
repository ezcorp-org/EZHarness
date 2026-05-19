/**
 * Server-handler tests for the test-only HTTP endpoints under
 * `/api/__test/*`. These ship in production builds but MUST be inert
 * unless `PI_E2E_REAL=1` AND we're not in a `NODE_ENV=production`
 * build — see the belt-and-braces gate in each handler.
 *
 * Coverage matrix per endpoint:
 *
 *   POST /api/__test/seed-extension-author-draft
 *     - 404 when PI_E2E_REAL unset / "0" / NODE_ENV=production
 *     - 401 when unauthenticated
 *     - 400 on missing body / bad type
 *     - 400 on NAME_REGEX violation
 *     - 201 happy path: draft row inserted, files written, owner =
 *       caller
 *
 *   POST /api/__test/cleanup-extension
 *     - 404 when PI_E2E_REAL unset / NODE_ENV=production
 *     - 403 for non-admin
 *     - 400 on bad name regex (incl. `..`)
 *     - idempotent: missing row + missing dir → `{ ok: true,
 *       rowDeleted: false, dirRemoved: false }`
 *     - 200 happy path: row deleted, dir removed
 *
 * All DB writes are mocked. `scaffoldExtension` runs for real (it's a
 * pure function that returns a file map). Filesystem writes for the
 * seed-happy-path test land in a per-test tmpdir so we can `expect()`
 * file contents on disk without polluting the worktree.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Module mocks (BEFORE the route imports) ─────────────────────────

const draftStore = new Map<
  string,
  { userId: string; kind: string; payload: unknown }
>();
let nextDraftId = 1;

// Track the active tmpdir per test so `getExtensionAuthorDraftDir`
// returns a path inside it.
let TMP_ROOT = "";

vi.mock("$server/db/queries/ez-drafts", async () => {
  const { join } = await import("node:path");
  return {
    createDraft: vi.fn(
      async (data: { userId: string; kind: string; payload: unknown }) => {
        const id = `draft-${nextDraftId++}`;
        draftStore.set(id, { userId: data.userId, kind: data.kind, payload: data.payload });
        return {
          id,
          userId: data.userId,
          kind: data.kind,
          payload: data.payload,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        };
      },
    ),
    getExtensionAuthorDraftDir: vi.fn((draftId: string, userId: string) =>
      join(TMP_ROOT, ".ezcorp/extension-data/extension-author/drafts", userId, draftId),
    ),
  };
});

// Mocked DB queries for the cleanup endpoint.
const extensionStore = new Map<string, { id: string; name: string }>();
let mockDeleteExtension = vi.fn(async (id: string) => {
  for (const [k, v] of extensionStore) {
    if (v.id === id) {
      extensionStore.delete(k);
      return true;
    }
  }
  return false;
});

vi.mock("$server/db/queries/extensions", () => ({
  getExtensionByName: vi.fn(async (name: string) => extensionStore.get(name) ?? null),
  deleteExtension: (...args: unknown[]) => mockDeleteExtension(...args as [string]),
}));

// Mock $server/extensions/bundled — the cleanup endpoint imports
// `getProjectRoot` from here. Returning the test tmpdir keeps every
// `.ezcorp/extensions/<name>` lookup inside the per-test sandbox.
vi.mock("$server/extensions/bundled", () => ({
  getProjectRoot: vi.fn(() => TMP_ROOT),
}));

// Auth middleware: shared across both endpoints. We override
// `requireAuth` and `requireRole` to introspect `locals.user`.
vi.mock("$server/auth/middleware", () => ({
  requireAuth: vi.fn((locals: { user?: { id: string; role: string } }) => {
    if (!locals.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return locals.user;
  }),
  requireRole: vi.fn(
    (locals: { user?: { id: string; role: string } }, role: string) => {
      if (!locals.user) {
        throw new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (locals.user.role !== role) {
        throw new Response(JSON.stringify({ error: "Insufficient permissions" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return locals.user;
    },
  ),
}));

// Imports come AFTER the mocks. Both handlers are dynamic-loaded.
const { POST: seedPOST } = await import(
  "../routes/api/__test/seed-extension-author-draft/+server"
);
const { POST: cleanupPOST } = await import(
  "../routes/api/__test/cleanup-extension/+server"
);

// ── Test fixtures ──────────────────────────────────────────────────

const ADMIN_USER = { id: "admin-1", email: "admin@x", name: "Admin", role: "admin" };
const MEMBER_USER = { id: "user-1", email: "u@x", name: "User", role: "member" };

interface ReqOpts {
  body?: unknown;
  rawBody?: string;
  locals?: Record<string, unknown>;
}

function makeRequestEvent(url: string, opts: ReqOpts = {}): never {
  const body =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  return {
    request: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    locals: opts.locals ?? { user: ADMIN_USER },
    params: {},
    url: new URL(url),
    route: { id: "/api/__test/x" },
    fetch: globalThis.fetch,
    cookies: {} as never,
    getClientAddress: () => "127.0.0.1",
    isDataRequest: false,
    isSubRequest: false,
    setHeaders: () => {},
    platform: undefined,
  } as never;
}

beforeEach(() => {
  draftStore.clear();
  extensionStore.clear();
  nextDraftId = 1;
  TMP_ROOT = mkdtempSync(join(tmpdir(), "test-only-endpoints-"));
  // Default: both gates open. Each test overrides as needed.
  process.env.PI_E2E_REAL = "1";
  delete process.env.NODE_ENV;
  mockDeleteExtension = vi.fn(async (id: string) => {
    for (const [k, v] of extensionStore) {
      if (v.id === id) {
        extensionStore.delete(k);
        return true;
      }
    }
    return false;
  });
});

afterEach(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* swallow */ }
  delete process.env.PI_E2E_REAL;
  delete process.env.NODE_ENV;
});

// ── /api/__test/seed-extension-author-draft ────────────────────────

describe("POST /api/__test/seed-extension-author-draft — gate", () => {
  test("returns 404 when PI_E2E_REAL is unset", async () => {
    delete process.env.PI_E2E_REAL;
    const resp = await seedPOST(
      makeRequestEvent("http://x/api/__test/seed-extension-author-draft", {
        body: { name: "e2e-x", type: "tool" },
      }),
    );
    expect(resp.status).toBe(404);
  });

  test("returns 404 when PI_E2E_REAL=0", async () => {
    process.env.PI_E2E_REAL = "0";
    const resp = await seedPOST(
      makeRequestEvent("http://x/api/__test/seed-extension-author-draft", {
        body: { name: "e2e-x", type: "tool" },
      }),
    );
    expect(resp.status).toBe(404);
  });

  test("returns 404 when NODE_ENV=production even if PI_E2E_REAL=1 (belt-and-braces gate)", async () => {
    process.env.PI_E2E_REAL = "1";
    process.env.NODE_ENV = "production";
    const resp = await seedPOST(
      makeRequestEvent("http://x/api/__test/seed-extension-author-draft", {
        body: { name: "e2e-x", type: "tool" },
      }),
    );
    expect(resp.status).toBe(404);
  });
});

describe("POST /api/__test/seed-extension-author-draft — validation", () => {
  test("returns 401 when no user on locals", async () => {
    const resp = await seedPOST(
      makeRequestEvent("http://x/api/__test/seed-extension-author-draft", {
        body: { name: "e2e-x", type: "tool" },
        locals: {},
      }),
    );
    expect(resp.status).toBe(401);
  });

  test("returns 400 on missing body", async () => {
    const resp = await seedPOST(
      makeRequestEvent("http://x/api/__test/seed-extension-author-draft", {
        rawBody: "{not-json",
      }),
    );
    expect(resp.status).toBe(400);
  });

  test("returns 400 when `type` is invalid", async () => {
    const resp = await seedPOST(
      makeRequestEvent("http://x/api/__test/seed-extension-author-draft", {
        body: { name: "e2e-x", type: "explosive" },
      }),
    );
    expect(resp.status).toBe(400);
  });

  test("returns 400 when `name` is missing", async () => {
    const resp = await seedPOST(
      makeRequestEvent("http://x/api/__test/seed-extension-author-draft", {
        body: { type: "tool" },
      }),
    );
    expect(resp.status).toBe(400);
  });

  test("returns 400 on NAME_REGEX violation (uppercase)", async () => {
    const resp = await seedPOST(
      makeRequestEvent("http://x/api/__test/seed-extension-author-draft", {
        body: { name: "Bad-Name", type: "tool" },
      }),
    );
    expect(resp.status).toBe(400);
  });

  test("returns 400 on NAME_REGEX violation (path traversal `..`)", async () => {
    const resp = await seedPOST(
      makeRequestEvent("http://x/api/__test/seed-extension-author-draft", {
        body: { name: "..", type: "tool" },
      }),
    );
    expect(resp.status).toBe(400);
  });
});

describe("POST /api/__test/seed-extension-author-draft — happy path", () => {
  test("inserts a draft row, writes files on disk, returns { draftId, draftDir }, owner = caller", async () => {
    const resp = await seedPOST(
      makeRequestEvent("http://x/api/__test/seed-extension-author-draft", {
        body: { name: "e2e-weather", type: "tool", description: "Weather lookup" },
        locals: { user: ADMIN_USER },
      }),
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as {
      draftId: string;
      draftDir: string;
      userId: string;
      files: string[];
    };
    expect(typeof body.draftId).toBe("string");
    expect(body.userId).toBe(ADMIN_USER.id);
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.files).toContain("ezcorp.config.ts");

    // Draft row stored owner-scoped.
    const stored = draftStore.get(body.draftId);
    expect(stored?.userId).toBe(ADMIN_USER.id);
    expect(stored?.kind).toBe("extension");

    // Files exist on disk.
    expect(existsSync(join(body.draftDir, "ezcorp.config.ts"))).toBe(true);
  });
});

// ── /api/__test/cleanup-extension ──────────────────────────────────

describe("POST /api/__test/cleanup-extension — gate", () => {
  test("returns 404 when PI_E2E_REAL is unset", async () => {
    delete process.env.PI_E2E_REAL;
    const resp = await cleanupPOST(
      makeRequestEvent("http://x/api/__test/cleanup-extension", {
        body: { name: "x" },
      }),
    );
    expect(resp.status).toBe(404);
  });

  test("returns 404 when NODE_ENV=production even if PI_E2E_REAL=1 (belt-and-braces gate)", async () => {
    process.env.PI_E2E_REAL = "1";
    process.env.NODE_ENV = "production";
    const resp = await cleanupPOST(
      makeRequestEvent("http://x/api/__test/cleanup-extension", {
        body: { name: "x" },
      }),
    );
    expect(resp.status).toBe(404);
  });
});

describe("POST /api/__test/cleanup-extension — auth + validation", () => {
  test("returns 403 for non-admin user", async () => {
    const resp = await cleanupPOST(
      makeRequestEvent("http://x/api/__test/cleanup-extension", {
        body: { name: "x" },
        locals: { user: MEMBER_USER },
      }),
    );
    expect(resp.status).toBe(403);
  });

  test("returns 400 on missing name", async () => {
    const resp = await cleanupPOST(
      makeRequestEvent("http://x/api/__test/cleanup-extension", {
        body: {},
      }),
    );
    expect(resp.status).toBe(400);
  });

  test("returns 400 on path-traversal `..`", async () => {
    const resp = await cleanupPOST(
      makeRequestEvent("http://x/api/__test/cleanup-extension", {
        body: { name: "../escape" },
      }),
    );
    expect(resp.status).toBe(400);
  });

  test("returns 400 on uppercase name (regex)", async () => {
    const resp = await cleanupPOST(
      makeRequestEvent("http://x/api/__test/cleanup-extension", {
        body: { name: "Bad" },
      }),
    );
    expect(resp.status).toBe(400);
  });
});

describe("POST /api/__test/cleanup-extension — happy path", () => {
  test("missing extension → idempotent ok:true with rowDeleted/dirRemoved both false", async () => {
    const resp = await cleanupPOST(
      makeRequestEvent("http://x/api/__test/cleanup-extension", {
        body: { name: "never-existed" },
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      rowDeleted: boolean;
      dirRemoved: boolean;
    };
    expect(body).toEqual({ ok: true, rowDeleted: false, dirRemoved: false });
  });

  test("happy path: row deleted, dir removed", async () => {
    // Seed an extension row + on-disk install dir inside TMP_ROOT.
    extensionStore.set("e2e-target", { id: "ext-1", name: "e2e-target" });
    const installedPath = join(TMP_ROOT, ".ezcorp/extensions", "e2e-target");
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(join(installedPath, "marker.txt"), "x", "utf8");

    const resp = await cleanupPOST(
      makeRequestEvent("http://x/api/__test/cleanup-extension", {
        body: { name: "e2e-target" },
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      rowDeleted: boolean;
      dirRemoved: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.rowDeleted).toBe(true);
    expect(body.dirRemoved).toBe(true);

    // Filesystem actually removed.
    expect(existsSync(installedPath)).toBe(false);
    // Row removed.
    expect(extensionStore.has("e2e-target")).toBe(false);
  });
});

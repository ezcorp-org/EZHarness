// Regression test for sec-M3: GET /api/fs/list must sandbox to
// EZCORP_PROJECT_ROOT and reject paths that escape via symlink, absolute
// traversal, relative traversal, or "~/…" expansion.
//
// Pre-fix (web/src/routes/api/fs/list/+server.ts:10-41):
//   const home = process.env.HOME ?? "/";
//   const raw = url.searchParams.get("dir") ?? home;
//   const dir = resolve(raw.startsWith("~") ? raw.replace("~", home) : raw);
//   if (!dir.startsWith(allowedBase + "/") && dir !== allowedBase) { … }
// — sandbox was $HOME, so ~/.ssh, ~/.aws, IDE configs were listable by any
// cookie-authed user. No symlink check. No role check.
//
// Fix does three things:
//   1. Sandbox root is process.env.EZCORP_PROJECT_ROOT ?? process.cwd()
//      (no $HOME / tilde expansion).
//   2. Authorization tightened to admin role (was any authed user).
//   3. realpath() on both the sandbox root and the requested dir, then
//      prefix-compare the real paths. This defeats symlink escapes where
//      a symlink inside the sandbox targets something outside it.
//
// Tests fix(sec-M3): 449ef7b

import { test, expect, describe, afterAll, beforeAll, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
  MEMBER_USER,
} from "../helpers/mock-request";

mockServerAlias();

// The handler imports these — stub them out with harmless implementations
// so the test exercises only the sandbox logic and the admin-role gate
// (which lives in the handler itself).
mock.module("../../../web/src/routes/api/fs/list/$types", () => ({}));
// Dual-specifier mocks. Bun's alias resolution for `$server/*` /
// `$lib/*` only works when the SvelteKit generated tsconfig path maps
// are honored; in a bare worktree checkout they may not be. Register the
// relative specifier (the shape the handler's import actually resolves
// to after alias substitution) so the mock fires regardless.
const authMiddleware = () => ({
  requireAuth: (locals: any) => {
    if (!locals?.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return locals.user;
  },
});
mock.module("$server/auth/middleware", authMiddleware);
mock.module("../../auth/middleware", authMiddleware);
const apiKeysStub = () => ({ requireScope: () => null });
mock.module("$lib/server/security/api-keys", apiKeysStub);
mock.module("../../../web/src/lib/server/security/api-keys", apiKeysStub);

// Handler import AFTER mocks.
import { GET } from "../../../web/src/routes/api/fs/list/+server";

async function call(handler: any, event: any): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

// Sandbox fixture: a tmp dir with an inner subdir, a file, and a symlink
// inside the sandbox pointing to /etc (the classic escape vector).
let sandbox: string;
let innerDir: string;
let etcSymlink: string;
let outsideFile: string;
let prevProjectRoot: string | undefined;

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "ezcorp-m3-sandbox-")));
  innerDir = join(sandbox, "inside-dir");
  mkdirSync(innerDir);
  writeFileSync(join(innerDir, "keep.txt"), "inside sandbox");

  // Symlink from inside the sandbox → /etc. Pre-fix path-prefix check saw
  // the lexical path "<sandbox>/etc-link" starting with the sandbox prefix
  // and allowed it. Post-fix realpath check resolves it to /etc and rejects.
  etcSymlink = join(sandbox, "etc-link");
  try {
    symlinkSync("/etc", etcSymlink);
  } catch {
    // Some environments may not allow /etc symlinks — fall back to the
    // tmp dir's parent which is also outside the sandbox root.
    symlinkSync(tmpdir(), etcSymlink);
  }

  // A plain file outside the sandbox, absolute path, just to test
  // absolute-path escape.
  outsideFile = mkdtempSync(join(tmpdir(), "ezcorp-m3-outside-"));
  writeFileSync(join(outsideFile, "leak.txt"), "outside sandbox");

  prevProjectRoot = process.env.EZCORP_PROJECT_ROOT;
  process.env.EZCORP_PROJECT_ROOT = sandbox;
});

afterAll(() => {
  if (prevProjectRoot === undefined) delete process.env.EZCORP_PROJECT_ROOT;
  else process.env.EZCORP_PROJECT_ROOT = prevProjectRoot;
  for (const p of [sandbox, outsideFile]) {
    if (p && existsSync(p)) {
      try { rmSync(p, { recursive: true, force: true }); } catch {}
    }
  }
  restoreModuleMocks();
});

afterEach(() => {
  // Nothing per-test — fixtures are shared.
});

describe("sec-M3: /api/fs/list sandbox and authorization", () => {
  test("unauthenticated → 401 (requireAuth throws)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/fs/list",
      // no user
    });
    const res = await call(GET, event);
    expect(res.status).toBe(401);
  });

  test("member role → 403 (admin gate)", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/fs/list?dir=${encodeURIComponent(sandbox)}`,
      user: MEMBER_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(403);
  });

  test("admin + happy path: inside-sandbox subdir → 200 with entries", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/fs/list?dir=${encodeURIComponent(innerDir)}`,
      user: ADMIN_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(Array.isArray(body)).toBe(true);
    const names = body.map((e: any) => e.name);
    expect(names).toContain("keep.txt");
  });

  test("admin + /etc → 403 outside sandbox", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/fs/list?dir=%2Fetc",
      user: ADMIN_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(403);
    const body = await jsonFromResponse(res);
    // Must not have leaked /etc listing.
    expect(Array.isArray(body)).toBe(false);
    // Must not have leaked passwd etc.
    expect(JSON.stringify(body)).not.toContain("passwd");
  });

  test("admin + $HOME → 403 (pre-fix allowed it)", async () => {
    const home = process.env.HOME ?? "/";
    const event = createMockEvent({
      url: `http://localhost/api/fs/list?dir=${encodeURIComponent(home)}`,
      user: ADMIN_USER,
    });
    const res = await call(GET, event);
    // Unless $HOME coincidentally equals the sandbox, this must be denied.
    // If they happen to match in some sandboxed CI, skip that one assertion.
    if (realpathSync(home) !== sandbox) {
      expect(res.status).toBe(403);
    }
  });

  test("admin + absolute path outside sandbox → 403", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/fs/list?dir=${encodeURIComponent(outsideFile)}`,
      user: ADMIN_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(403);
    const body = await jsonFromResponse(res);
    // Must not have listed "leak.txt".
    expect(JSON.stringify(body)).not.toContain("leak.txt");
  });

  test("admin + relative traversal escape (../../../etc) → 403 or empty", async () => {
    // resolve() will canonicalize this relative to process.cwd(). If the
    // resolved real path is outside the sandbox, the handler must deny.
    const event = createMockEvent({
      url: "http://localhost/api/fs/list?dir=..%2F..%2F..%2F..%2Fetc",
      user: ADMIN_USER,
    });
    const res = await call(GET, event);
    // Either 403 (outside sandbox) or 200 [] (nonexistent) — never a real
    // listing that mentions /etc files.
    expect([200, 403]).toContain(res.status);
    const body = await jsonFromResponse(res);
    expect(JSON.stringify(body)).not.toContain("passwd");
    expect(JSON.stringify(body)).not.toContain("hosts");
  });

  test("admin + symlink escape: <sandbox>/etc-link → 403 via realpath", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/fs/list?dir=${encodeURIComponent(etcSymlink)}`,
      user: ADMIN_USER,
    });
    const res = await call(GET, event);
    // This is the crown jewel of the fix: lexically the path starts with
    // the sandbox prefix and would have been allowed pre-fix (after the
    // pre-fix sandbox was $HOME, but even under a project-root sandbox
    // without realpath, this lexical check would pass). realpath on the
    // symlink resolves to /etc (or tmpdir if /etc symlink was rejected),
    // which is NOT under realSandbox, so the fix must return 403.
    expect(res.status).toBe(403);
  });

  test("admin + no dir param → defaults to sandbox root (200)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/fs/list",
      user: ADMIN_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(Array.isArray(body)).toBe(true);
    // Should include the inner subdir we created.
    const names = body.map((e: any) => e.name);
    expect(names).toContain("inside-dir");
  });
});

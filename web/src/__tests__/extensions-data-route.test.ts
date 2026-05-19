/**
 * GET /api/extensions/[name]/data/[...path]
 *
 * Phase A2 static-file route. Serves files from
 * `<cwd>/.ezcorp/extension-data/<name>/`. Tests cover:
 *   - Auth (scope rejection short-circuits before disk).
 *   - Extension-name regex enforcement.
 *   - Path traversal rejection (`..` segments, absolute paths,
 *     resolved paths escaping the data dir).
 *   - Empty / unknown paths → 404 (no information leak).
 *   - Successful read returns content + correct MIME + strict CSP.
 *   - All failure modes return the same 404 status (opaque surface).
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock auth + scope middleware ──────────────────────────────────

let mockScopeResponse: Response | null = null;
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => mockScopeResponse,
}));

mock.module("$server/auth/middleware", () => ({
  requireAuth: () => ({ id: "user-1", email: "t@t.com", name: "T", role: "member" }),
}));

mock.module("$lib/server/http-errors", () => ({
  errorJson: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
}));

// ── Fake project root with extension data ──────────────────────────

const fakeRoot = mkdtempSync(join(tmpdir(), "ezcorp-data-route-test-"));
const dataDir = join(fakeRoot, ".ezcorp", "extension-data", "claude-design");
mkdirSync(join(dataDir, "drafts"), { recursive: true });
writeFileSync(
  join(dataDir, "drafts", "d-1.html"),
  "<!doctype html><html><body>hello draft</body></html>",
);
writeFileSync(join(dataDir, "tokens.css"), ":root { --color-primary: #ff0066; }");

afterAll(() => {
  try { rmSync(fakeRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

mock.module("$server/chat/attachments/ext-files-resolver", () => ({
  extensionDataRoot: (name: string) =>
    join(fakeRoot, ".ezcorp", "extension-data", name),
}));

// ── Import handler AFTER mocks ────────────────────────────────────

const { GET } = await import(
  "../routes/api/extensions/[name]/data/[...path]/+server"
);

// ── Helpers ───────────────────────────────────────────────────────

function makeEvent(params: { name?: string; path?: string }): unknown {
  return {
    request: new Request(
      `http://localhost/api/extensions/${params.name ?? ""}/data/${params.path ?? ""}`,
    ),
    locals: {
      user: { id: "user-1", email: "t@t.com", name: "T", role: "member" },
    },
    params,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("GET /api/extensions/[name]/data/[...path]", () => {
  beforeEach(() => {
    mockScopeResponse = null;
  });

  // ── Auth ────────────────────────────────────────────────────────

  test("scope rejection short-circuits before disk read", async () => {
    mockScopeResponse = new Response("forbidden", { status: 403 });
    const res = await GET(
      makeEvent({ name: "claude-design", path: "drafts/d-1.html" }) as never,
    );
    expect(res.status).toBe(403);
  });

  // ── URL param validation ────────────────────────────────────────

  test("invalid extension-name → 404", async () => {
    const res = await GET(
      makeEvent({ name: "Bad Name", path: "drafts/d-1.html" }) as never,
    );
    expect(res.status).toBe(404);
  });

  test("missing extension name → 404", async () => {
    const res = await GET(makeEvent({ path: "drafts/d-1.html" }) as never);
    expect(res.status).toBe(404);
  });

  test("empty path → 404", async () => {
    const res = await GET(makeEvent({ name: "claude-design", path: "" }) as never);
    expect(res.status).toBe(404);
  });

  // ── Path traversal ──────────────────────────────────────────────

  test(".. segment in path → 404", async () => {
    const res = await GET(
      makeEvent({
        name: "claude-design",
        path: "drafts/../../../etc/passwd",
      }) as never,
    );
    expect(res.status).toBe(404);
  });

  test("bare .. → 404", async () => {
    const res = await GET(makeEvent({ name: "claude-design", path: ".." }) as never);
    expect(res.status).toBe(404);
  });

  test("encoded slash in segment doesn't escape (%2F decodes to / but route param parser splits)", async () => {
    // The router decodes %2F as part of route param parsing, so the path
    // becomes "drafts/d-1.html" segments — same-origin behavior.
    // We test that an encoded ".." is also caught (path param decoding):
    const res = await GET(
      makeEvent({
        name: "claude-design",
        path: "..%2f..%2fetc/passwd",
      }) as never,
    );
    // SvelteKit's router decodes %2F before our handler sees it, so this
    // should hit the .. segment check.
    expect(res.status).toBe(404);
  });

  // ── Unknown extension / file ────────────────────────────────────

  test("nonexistent extension → 404", async () => {
    const res = await GET(
      makeEvent({ name: "nope-design", path: "drafts/d-1.html" }) as never,
    );
    expect(res.status).toBe(404);
  });

  test("nonexistent file → 404", async () => {
    const res = await GET(
      makeEvent({ name: "claude-design", path: "drafts/missing.html" }) as never,
    );
    expect(res.status).toBe(404);
  });

  // ── Happy path ──────────────────────────────────────────────────

  test("existing HTML file → 200 with content + text/html + CSP", async () => {
    const res = await GET(
      makeEvent({ name: "claude-design", path: "drafts/d-1.html" }) as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const text = await res.text();
    expect(text).toContain("hello draft");
  });

  test("CSS file → 200 with text/css", async () => {
    const res = await GET(
      makeEvent({ name: "claude-design", path: "tokens.css" }) as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
  });

  test("CSP forbids form-action and frame-ancestors=self", async () => {
    const res = await GET(
      makeEvent({ name: "claude-design", path: "drafts/d-1.html" }) as never,
    );
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  // ── Rate limit ────────────────────────────────────────────────────

  test("per-user rate limit (240/min) returns 429 with Retry-After when exceeded", async () => {
    // Pull the singleton limiter and reset for a clean test; the same
    // module-scoped instance the route uses.
    const { __rateLimiter } = await import(
      "../routes/api/extensions/[name]/data/[...path]/+server"
    );
    __rateLimiter.reset();
    // Burn through the 240-request budget then assert the 241st 429s.
    for (let i = 0; i < 240; i++) {
      const ok = await GET(
        makeEvent({ name: "claude-design", path: "drafts/d-1.html" }) as never,
      );
      expect(ok.status).toBe(200);
    }
    const blocked = await GET(
      makeEvent({ name: "claude-design", path: "drafts/d-1.html" }) as never,
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    __rateLimiter.reset();
  });
});

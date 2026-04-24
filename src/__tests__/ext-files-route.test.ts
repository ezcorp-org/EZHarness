import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mockServerAlias, createMockEvent } from "./helpers/mock-request";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mockServerAlias();

// Stub $types so bun can resolve the handler module.
mock.module("../../web/src/routes/api/ext-files/[name]/[...path]/$types", () => ({}));

// Stub auth helpers — the route's security model is tested via the
// `name` allowlist + path traversal, not the cookie flow.
mock.module("$server/auth/middleware", () => ({
  requireAuth: (locals: any) => {
    if (!locals?.user) {
      const res = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      throw res;
    }
  },
}));
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

import { GET } from "../../web/src/routes/api/ext-files/[name]/[...path]/+server";

afterAll(() => {
  restoreModuleMocks();
});

let cwd = "";
const EXT = "openai-image-gen-2";
// Stable location to chdir back to in teardown so sibling test files
// running after this one don't find process.cwd() pointing at a deleted
// tmp dir (the failure mode is node crashing inside any subsequent
// `process.cwd()` or relative-path resolve).
const SAFE_CWD = tmpdir();

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "extfiles-"));
  const dir = join(cwd, ".ezcorp", "extension-data", EXT, "generated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "good.png"), Buffer.from("PNGDATA", "utf8"));
  writeFileSync(join(dir, "other.bin"), Buffer.from("BIN", "utf8"));
  process.chdir(cwd);
});

afterAll(() => {
  process.chdir(SAFE_CWD);
  if (cwd) {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});

function mkEvent(name: string, path: string, authed = true) {
  return createMockEvent({
    url: `http://localhost/api/ext-files/${name}/${path}`,
    params: { name, path },
    user: authed ? { id: "u1", email: "u@x", name: "U", role: "member" } : undefined,
  });
}

describe("GET /api/ext-files/[name]/[...path]", () => {
  test("serves a file from the extension's generated/ dir with correct content-type", async () => {
    const res = await GET(mkEvent(EXT, "generated/good.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("PNGDATA");
  });

  test("returns 404 for an extension not on the allowlist", async () => {
    const res = await GET(mkEvent("not-allowed", "generated/good.png"));
    expect(res.status).toBe(404);
  });

  test("returns 404 for missing files", async () => {
    const res = await GET(mkEvent(EXT, "generated/nonexistent.png"));
    expect(res.status).toBe(404);
  });

  test("rejects path traversal via ../", async () => {
    const res = await GET(mkEvent(EXT, "../../../etc/passwd"));
    expect(res.status).toBe(404);
  });

  test("rejects a traversal hidden inside the path", async () => {
    const res = await GET(mkEvent(EXT, "generated/../../../etc/passwd"));
    expect(res.status).toBe(404);
  });

  test("rejects empty path and bare slash", async () => {
    expect((await GET(mkEvent(EXT, ""))).status).toBe(404);
    expect((await GET(mkEvent(EXT, "/"))).status).toBe(404);
    expect((await GET(mkEvent(EXT, "."))).status).toBe(404);
  });

  test("rejects directory requests (not a file)", async () => {
    const res = await GET(mkEvent(EXT, "generated"));
    expect(res.status).toBe(404);
  });

  test("falls back to application/octet-stream for unknown extensions", async () => {
    const res = await GET(mkEvent(EXT, "generated/other.bin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  test("maps common image extensions to correct content-types", async () => {
    const dir = join(cwd, ".ezcorp", "extension-data", EXT, "generated");
    writeFileSync(join(dir, "a.jpg"), "JPG");
    writeFileSync(join(dir, "b.jpeg"), "JPG2");
    writeFileSync(join(dir, "c.webp"), "WEBP");
    writeFileSync(join(dir, "d.gif"), "GIF");
    expect((await GET(mkEvent(EXT, "generated/a.jpg"))).headers.get("Content-Type")).toBe("image/jpeg");
    expect((await GET(mkEvent(EXT, "generated/b.jpeg"))).headers.get("Content-Type")).toBe("image/jpeg");
    expect((await GET(mkEvent(EXT, "generated/c.webp"))).headers.get("Content-Type")).toBe("image/webp");
    expect((await GET(mkEvent(EXT, "generated/d.gif"))).headers.get("Content-Type")).toBe("image/gif");
  });

  test("returns 401 for unauthenticated requests", async () => {
    try {
      await GET(mkEvent(EXT, "generated/good.png", false));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(401);
    }
  });

  test("sets Cache-Control to private + short max-age", async () => {
    const res = await GET(mkEvent(EXT, "generated/good.png"));
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toContain("private");
    expect(cc).toMatch(/max-age=\d+/);
  });
});

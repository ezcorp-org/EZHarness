import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ezcorp-update-test-"));
  dbPath = join(tempDir, "db");
  delete process.env.EZCORP_CHECK_UPDATES;
  delete process.env.EZCORP_UPDATE_REPO;
  delete process.env.EZCORP_IMAGE_VERSION;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.EZCORP_CHECK_UPDATES;
  delete process.env.EZCORP_UPDATE_REPO;
  delete process.env.EZCORP_IMAGE_VERSION;
});

mock.module("../db/connection", () => ({
  getPglite: () => null,
  getDbPath: () => dbPath,
  getDb: () => null,
  initDb: async () => {},
  closeDb: async () => {},
}));

afterAll(() => restoreModuleMocks());

describe("compareVersions", () => {
  test("equal versions return 0", async () => {
    const { compareVersions } = await import("../update-check");
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("app-v1.2.3", "v1.2.3")).toBe(0);
  });

  test("newer version returns positive, older returns negative", async () => {
    const { compareVersions } = await import("../update-check");
    expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.99.99", "2.0.0")).toBeLessThan(0);
  });

  test("multi-digit segments sort numerically (not string-wise)", async () => {
    const { compareVersions } = await import("../update-check");
    // String compare would put "0.9.0" > "0.10.0"; numeric must not.
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
  });

  test("missing trailing segments default to 0", async () => {
    const { compareVersions } = await import("../update-check");
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
  });

  test("leading v / app-v stripped symmetrically", async () => {
    const { compareVersions } = await import("../update-check");
    expect(compareVersions("v0.1.0", "app-v0.1.1")).toBeLessThan(0);
  });

  test("non-numeric segments treated as 0 (graceful fallback)", async () => {
    const { compareVersions } = await import("../update-check");
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(0);
    expect(compareVersions("v1.2.3", "garbage")).toBeGreaterThan(0);
  });

  test("handles arbitrary prefixes (bun-v, svelte@, pkg@name@, etc.)", async () => {
    // Regression: earlier impl only stripped ^v? / ^app-v? so bun-v1.3.13
    // parsed as [0,0,3,13] and compared WRONG against 0.1.0-verify.
    const { compareVersions } = await import("../update-check");
    expect(compareVersions("bun-v1.3.13", "0.1.0-verify")).toBeGreaterThan(0);
    expect(compareVersions("svelte@5.0.0", "v4.9.0")).toBeGreaterThan(0);
    expect(compareVersions("@org/pkg@2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("release-2.0.0", "release-1.5.0")).toBeGreaterThan(0);
  });

  test("ignores build metadata and pre-release suffixes", async () => {
    const { compareVersions } = await import("../update-check");
    expect(compareVersions("1.2.3+build.42", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-rc.1", "1.2.3-rc.2")).toBe(0); // both parse to 1.2.3
    expect(compareVersions("1.2.4-rc.1", "1.2.3")).toBeGreaterThan(0);
  });

  test("returns 0 if neither side contains any version", async () => {
    const { compareVersions } = await import("../update-check");
    expect(compareVersions("no-version-here", "also-no-version")).toBe(0);
  });
});

describe("getUpdateCheck — disabled modes", () => {
  test("returns source: 'disabled' when EZCORP_CHECK_UPDATES=false", async () => {
    process.env.EZCORP_CHECK_UPDATES = "false";
    process.env.EZCORP_UPDATE_REPO = "owner/repo";
    process.env.EZCORP_IMAGE_VERSION = "0.1.0";
    const { getUpdateCheck } = await import("../update-check");
    const r = await getUpdateCheck();
    expect(r.source).toBe("disabled");
    expect(r.updateAvailable).toBe(false);
    expect(r.latest).toBeNull();
  });

  test("returns source: 'disabled' when EZCORP_UPDATE_REPO unset", async () => {
    process.env.EZCORP_CHECK_UPDATES = "true";
    delete process.env.EZCORP_UPDATE_REPO;
    process.env.EZCORP_IMAGE_VERSION = "0.1.0";
    const { getUpdateCheck } = await import("../update-check");
    const r = await getUpdateCheck();
    expect(r.source).toBe("disabled");
    expect(r.current).toBe("0.1.0");
  });

  test("current falls back to 'dev' when EZCORP_IMAGE_VERSION unset", async () => {
    delete process.env.EZCORP_IMAGE_VERSION;
    process.env.EZCORP_CHECK_UPDATES = "false";
    const { getUpdateCheck } = await import("../update-check");
    const r = await getUpdateCheck();
    expect(r.current).toBe("dev");
  });
});

describe("getUpdateCheck — cache behavior", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.EZCORP_CHECK_UPDATES = "true";
    process.env.EZCORP_UPDATE_REPO = "ezcorp-org/EZcorp";
    process.env.EZCORP_IMAGE_VERSION = "0.1.0";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fresh call without cache hits GitHub and persists the result", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v0.2.0", html_url: "https://example.com/r" }), { status: 200 })) as any;

    const { getUpdateCheck } = await import("../update-check");
    const r = await getUpdateCheck();

    expect(r.source).toBe("github-releases");
    expect(r.latest).toBe("v0.2.0");
    expect(r.updateAvailable).toBe(true);
    expect(r.releaseUrl).toBe("https://example.com/r");

    const cachePath = join(tempDir, ".update-check.json");
    expect(existsSync(cachePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(persisted.latest).toBe("v0.2.0");
    expect(typeof persisted.checkedAt).toBe("string");
  });

  test("cache hit within 24h TTL does not re-hit GitHub", async () => {
    // Seed a fresh cache (checkedAt = now)
    const recent = new Date().toISOString();
    writeFileSync(
      join(tempDir, ".update-check.json"),
      JSON.stringify({ latest: "v0.5.0", releaseUrl: "https://example.com/cached", checkedAt: recent }),
    );

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as any;

    const { getUpdateCheck } = await import("../update-check");
    const r = await getUpdateCheck();

    expect(fetchCalled).toBe(false);
    expect(r.latest).toBe("v0.5.0");
    expect(r.updateAvailable).toBe(true);
    expect(r.checkedAt).toBe(recent);
  });

  test("stale cache (>24h) triggers a refresh", async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(tempDir, ".update-check.json"),
      JSON.stringify({ latest: "v0.1.0", checkedAt: stale }),
    );

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v0.9.0", html_url: "x" }), { status: 200 })) as any;

    const { getUpdateCheck } = await import("../update-check");
    const r = await getUpdateCheck();
    expect(r.latest).toBe("v0.9.0");
  });

  test("GitHub fetch failure falls back to cached latest if any", async () => {
    writeFileSync(
      join(tempDir, ".update-check.json"),
      JSON.stringify({ latest: "v0.3.0", checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }),
    );
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as any;

    const { getUpdateCheck } = await import("../update-check");
    const r = await getUpdateCheck();
    // Fetch failed → cached latest preserved, but checkedAt is refreshed so we
    // don't re-hammer immediately on every request.
    expect(r.latest).toBe("v0.3.0");
    expect(r.source).toBe("github-releases");
  });

  test("GitHub returns non-ok → latest is null, updateAvailable false", async () => {
    globalThis.fetch = (async () => new Response("rate limited", { status: 403 })) as any;
    const { getUpdateCheck } = await import("../update-check");
    const r = await getUpdateCheck();
    expect(r.latest).toBeNull();
    expect(r.updateAvailable).toBe(false);
  });

  test("updateAvailable=false when latest equals current", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "app-v0.1.0" }), { status: 200 })) as any;
    const { getUpdateCheck } = await import("../update-check");
    const r = await getUpdateCheck();
    expect(r.latest).toBe("app-v0.1.0");
    expect(r.updateAvailable).toBe(false);
  });

  test("updateAvailable=false when latest is older than current", async () => {
    process.env.EZCORP_IMAGE_VERSION = "2.0.0";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v1.5.0" }), { status: 200 })) as any;
    const { getUpdateCheck } = await import("../update-check");
    const r = await getUpdateCheck();
    expect(r.updateAvailable).toBe(false);
  });
});

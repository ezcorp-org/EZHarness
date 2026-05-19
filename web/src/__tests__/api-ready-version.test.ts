import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// /api/ready and /api/version endpoint handlers are thin wrappers around
// `$server/readiness` and `$server/update-check`. These tests exercise the
// wrappers: status-code mapping, body shape, and passthrough of disabled mode.

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ezcorp-api-test-"));
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

// /api/version writes a cache under dirname(dbPath); point it at a tempdir.
mock.module("$server/db/connection", () => ({
  getPglite: () => null,
  getDbPath: () => dbPath,
  getDb: () => null,
  initDb: async () => {},
  closeDb: async () => {},
}));

mock.module("@sveltejs/kit", () => ({
  json: (data: unknown, init?: { status?: number }) =>
    new Response(JSON.stringify(data), {
      status: init?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    }),
}));

afterAll(() => mock.restore());

async function invoke(handler: (event: any) => Promise<Response> | Response): Promise<Response> {
  return await handler({} as any);
}

describe("/api/ready", () => {
  test("returns 503 + state 'booting' at cold start", async () => {
    const readiness = await import("$server/readiness");
    readiness.resetReadiness();

    const mod = await import("../routes/api/ready/+server");
    const res = await invoke(mod.GET);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { state: string; since: string };
    expect(body.state).toBe("booting");
    expect(typeof body.since).toBe("string");
  });

  test("returns 200 + state 'ready' when readiness flipped", async () => {
    const readiness = await import("$server/readiness");
    readiness.setReadiness({ state: "ready" });

    const mod = await import("../routes/api/ready/+server");
    const res = await invoke(mod.GET);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("ready");
  });

  test("returns 503 + reason + detail when degraded", async () => {
    const readiness = await import("$server/readiness");
    readiness.setReadiness({
      state: "degraded",
      reason: "migration-blocked",
      detail: { imageSha: "abc", error: "simulated" },
    });

    const mod = await import("../routes/api/ready/+server");
    const res = await invoke(mod.GET);
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.state).toBe("degraded");
    expect(body.reason).toBe("migration-blocked");
    expect(body.detail.imageSha).toBe("abc");
  });

  test("body is JSON content-type", async () => {
    const readiness = await import("$server/readiness");
    readiness.setReadiness({ state: "ready" });
    const mod = await import("../routes/api/ready/+server");
    const res = await invoke(mod.GET);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("/api/version", () => {
  test("returns disabled source when EZCORP_UPDATE_REPO unset", async () => {
    delete process.env.EZCORP_UPDATE_REPO;
    process.env.EZCORP_IMAGE_VERSION = "0.1.0";

    const mod = await import("../routes/api/version/+server");
    const res = await invoke(mod.GET);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.source).toBe("disabled");
    expect(body.current).toBe("0.1.0");
    expect(body.updateAvailable).toBe(false);
  });

  test("returns disabled source when EZCORP_CHECK_UPDATES=false", async () => {
    process.env.EZCORP_CHECK_UPDATES = "false";
    process.env.EZCORP_UPDATE_REPO = "owner/repo";
    process.env.EZCORP_IMAGE_VERSION = "0.1.0";

    const mod = await import("../routes/api/version/+server");
    const res = await invoke(mod.GET);
    const body = (await res.json()) as any;
    expect(body.source).toBe("disabled");
  });

  test("returns github-releases source with update when newer tag exists", async () => {
    process.env.EZCORP_UPDATE_REPO = "owner/repo";
    process.env.EZCORP_IMAGE_VERSION = "0.1.0";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v0.2.0", html_url: "https://rel" }), { status: 200 })) as any;

    try {
      const mod = await import("../routes/api/version/+server");
      const res = await invoke(mod.GET);
      const body = (await res.json()) as any;
      expect(body.source).toBe("github-releases");
      expect(body.latest).toBe("v0.2.0");
      expect(body.updateAvailable).toBe(true);
      expect(body.releaseUrl).toBe("https://rel");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ok response + JSON content-type", async () => {
    process.env.EZCORP_UPDATE_REPO = undefined as any;
    const mod = await import("../routes/api/version/+server");
    const res = await invoke(mod.GET);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

/**
 * Server-handler unit tests for /api/fs/list/+server.ts.
 *
 * Covers the auth + admin-role gates plus the sandbox-escape 403. Real
 * disk access is avoided by mocking node:fs/promises. Tests never read
 * anything outside /tmp.
 */

import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";

const realpath = vi.fn();
const readdir = vi.fn();
vi.mock("node:fs/promises", () => ({
  realpath,
  readdir,
  default: { realpath, readdir },
}));

const { GET } = await import("../routes/api/fs/list/+server");

function makeEvent(opts: {
  dir?: string;
  locals?: Record<string, unknown>;
  hidden?: boolean;
}) {
  const qs = new URLSearchParams();
  if (opts.dir) qs.set("dir", opts.dir);
  if (opts.hidden) qs.set("hidden", "1");
  const s = qs.toString();
  const url = "http://localhost/api/fs/list" + (s ? `?${s}` : "");
  return {
    url: new URL(url),
    locals: opts.locals ?? {},
    request: new Request(url),
  } as any;
}

const adminLocals = {
  user: { id: "a1", email: "a@x", name: "A", role: "admin" },
};
const memberLocals = {
  user: { id: "u1", email: "u@x", name: "U", role: "user" },
};

async function expectThrown(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  let res: Response | undefined;
  try {
    res = await fn();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  expect(res!.status).toBe(status);
  return res!;
}

describe("GET /api/fs/list", () => {
  const originalRoot = process.env.EZCORP_PROJECT_ROOT;

  beforeEach(() => {
    realpath.mockReset();
    readdir.mockReset();
    process.env.EZCORP_PROJECT_ROOT = "/tmp/ezcorp-test-sandbox";
  });

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => GET(makeEvent({})), 401);
  });

  test("returns 403 when caller is not admin", async () => {
    const res = await GET(makeEvent({ locals: memberLocals }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("admin role required");
  });

  test("rejects 403 when API-key lacks 'read' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...adminLocals, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
  });

  test("returns 500 when sandbox root realpath fails", async () => {
    realpath.mockRejectedValueOnce(new Error("boom"));
    const res = await GET(makeEvent({ locals: adminLocals }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Sandbox root unavailable");
  });

  test("returns 403 when real path escapes sandbox", async () => {
    realpath.mockImplementationOnce(async () => "/tmp/ezcorp-test-sandbox");
    realpath.mockImplementationOnce(async () => "/etc");
    const res = await GET(
      makeEvent({ locals: adminLocals, dir: "/tmp/ezcorp-test-sandbox/evil" }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("path outside allowed sandbox");
  });

  test("returns empty array when requested path does not exist", async () => {
    realpath.mockImplementationOnce(async () => "/tmp/ezcorp-test-sandbox");
    realpath.mockImplementationOnce(async () => {
      throw new Error("ENOENT");
    });
    const res = await GET(
      makeEvent({ locals: adminLocals, dir: "/tmp/ezcorp-test-sandbox/ghost" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  test("returns dir listing with dirs first and hidden-files filtered by default", async () => {
    realpath.mockImplementation(async () => "/tmp/ezcorp-test-sandbox");
    readdir.mockResolvedValue([
      { name: "file.txt", isDirectory: () => false },
      { name: ".hidden", isDirectory: () => false },
      { name: "src", isDirectory: () => true },
      { name: "a-dir", isDirectory: () => true },
    ] as any);
    const res = await GET(makeEvent({ locals: adminLocals }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string; isDir: boolean }>;
    expect(body.map((e) => e.name)).toEqual(["a-dir", "src", "file.txt"]);
    expect(body.find((e) => e.name === ".hidden")).toBeUndefined();
  });

  test("includes hidden entries when ?hidden=1", async () => {
    realpath.mockImplementation(async () => "/tmp/ezcorp-test-sandbox");
    readdir.mockResolvedValue([
      { name: ".hidden", isDirectory: () => false },
      { name: "f", isDirectory: () => false },
    ] as any);
    const res = await GET(makeEvent({ locals: adminLocals, hidden: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string }>;
    expect(body.map((e) => e.name)).toEqual([".hidden", "f"]);
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.EZCORP_PROJECT_ROOT;
    else process.env.EZCORP_PROJECT_ROOT = originalRoot;
  });
});

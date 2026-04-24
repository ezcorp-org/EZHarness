/**
 * Server-handler unit tests for /api/extensions (+server.ts).
 *
 * Covers:
 *  - GET 401 when locals.user missing
 *  - POST 401 when locals.user missing (requireRole throws)
 *  - POST 403 when non-admin authenticated
 *  - POST 400 on validation failures (missing source, bad enum, missing path/repo/url)
 *
 * The happy paths hit installFromLocal/installFromGit/installFromGitHub,
 * ExtensionRegistry.reload(), and DB audit-log — all mocked at their
 * module boundaries so we stay off PGlite and the extension runtime.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/extensions", () => ({
  listExtensions: vi.fn(),
}));

vi.mock("$server/extensions/installer", () => ({
  installFromLocal: vi.fn(),
  installFromGitHub: vi.fn(),
  installFromGit: vi.fn(),
}));

vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: vi.fn(async () => undefined) }),
  },
}));

vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { listExtensions } = await import("$server/db/queries/extensions");
const { installFromLocal } = await import("$server/extensions/installer");
const { GET, POST } = await import("../routes/api/extensions/+server.ts");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: string;
}) {
  const href = "http://localhost/api/extensions";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href, {
      method: opts.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const adminUser = { id: "u1", email: "a@x", name: "a", role: "admin" };
const regularUser = { id: "u2", email: "u@x", name: "u", role: "user" };

describe("GET /api/extensions", () => {
  beforeEach(() => {
    vi.mocked(listExtensions).mockReset();
  });

  test("rejects unauthenticated request with 401", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns extensions list for authenticated user", async () => {
    vi.mocked(listExtensions).mockResolvedValue([] as any);
    const res = await GET(makeEvent({ locals: { user: regularUser } }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/extensions", () => {
  beforeEach(() => {
    vi.mocked(installFromLocal).mockReset();
  });

  test("rejects unauthenticated request with 401", async () => {
    const res = await POST(
      makeEvent({ locals: {}, body: { source: "local", path: "/tmp/x" }, method: "POST" }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });

  test("rejects non-admin authenticated user with 403", async () => {
    const res = await POST(
      makeEvent({
        locals: { user: regularUser },
        body: { source: "local", path: "/tmp/x" },
        method: "POST",
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Insufficient permissions");
  });

  test("returns 400 when source is missing", async () => {
    const res = await POST(
      makeEvent({ locals: { user: adminUser }, body: {}, method: "POST" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  test("returns 400 when source is an invalid enum value", async () => {
    const res = await POST(
      makeEvent({
        locals: { user: adminUser },
        body: { source: "bogus" },
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when source=local and path is missing", async () => {
    const res = await POST(
      makeEvent({
        locals: { user: adminUser },
        body: { source: "local" },
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when source=github and repo is missing", async () => {
    const res = await POST(
      makeEvent({
        locals: { user: adminUser },
        body: { source: "github" },
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when source=git and url is missing", async () => {
    const res = await POST(
      makeEvent({
        locals: { user: adminUser },
        body: { source: "git" },
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when source=git and url starts with '-'", async () => {
    const res = await POST(
      makeEvent({
        locals: { user: adminUser },
        body: { source: "git", url: "--upload-pack=/bin/sh" },
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
  });
});

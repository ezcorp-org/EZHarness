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
import { makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/extensions", () => ({
  listExtensions: vi.fn(),
  getExtensionByName: vi.fn(),
  // The GET handler scrubs MCP transport secrets from every served row via
  // redactExtensionSecrets. For non-MCP rows (these fixtures) the real function
  // returns the row unchanged, so an identity stub is faithful here; the
  // store-backed MCP redaction round-trip is covered in
  // src/__tests__/mcp-secrets-query.test.ts.
  redactExtensionSecrets: vi.fn((ext: unknown) => ext),
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

const { listExtensions, getExtensionByName } = await import("$server/db/queries/extensions");
const { installFromLocal } = await import("$server/extensions/installer");
const { GET, POST } = await import("../routes/api/extensions/+server.ts");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: string;
  query?: string;
}) {
  const href = `http://localhost/api/extensions${opts.query ?? ""}`;
  return makeRequestEvent(href, {
    locals: opts.locals ?? {},
    request: {
      method: opts.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    },
  });
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

  test("the LIST branch attaches the derived flags, keyed on a real critical name", async () => {
    // The list branch — not the `?name=` short-circuit below — is what feeds
    // the Extensions page: `loadExtensions()` replaces the SSR rows on mount.
    // Asserting only `status` (as the case above does) leaves
    // `withListFlagsAll` deletable, and with it the extra confirm step before
    // a user turns off a loop-safety built-in.
    //
    // `ask-user` is a REAL `critical: true` catalog entry, so this also pins
    // the derivation end to end rather than restating the mapper's unit test.
    vi.mocked(listExtensions).mockResolvedValue([
      { id: "x", name: "ask-user" },
      { id: "y", name: "scratchpad" },
    ] as any);

    const res = await GET(makeEvent({ locals: { user: regularUser } }));
    const body = (await res.json()) as Array<Record<string, unknown>>;

    expect(body[0]).toMatchObject({ name: "ask-user", isCritical: true });
    expect(typeof body[0]!.criticalConsequence).toBe("string");
    expect(body[1]).toMatchObject({ name: "scratchpad", isCritical: false });
    // Absent, not empty — the page reads its PRESENCE as "needs the confirm".
    expect("criticalConsequence" in body[1]!).toBe(false);
  });

  test("?name= short-circuits to a single-element array on match", async () => {
    const ext = { id: "ext-1", name: "kokoro-tts" } as any;
    vi.mocked(getExtensionByName).mockResolvedValue(ext);
    const res = await GET(
      makeEvent({
        locals: { user: regularUser },
        query: "?name=kokoro-tts",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Same derived flags the full list carries, so the page renders an
    // identical card whichever surface fed it. `isCritical` comes from the
    // bundled catalog (`$lib/server/extensions/list-flags`), which the
    // browser has no business hardcoding.
    expect(body).toEqual([{ ...ext, isCritical: false }]);
    expect(getExtensionByName).toHaveBeenCalledWith("kokoro-tts");
    expect(listExtensions).not.toHaveBeenCalled();
  });

  test("?name= returns empty array when no match", async () => {
    vi.mocked(getExtensionByName).mockResolvedValue(null as any);
    const res = await GET(
      makeEvent({
        locals: { user: regularUser },
        query: "?name=nope",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    expect(listExtensions).not.toHaveBeenCalled();
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

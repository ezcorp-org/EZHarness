/**
 * Server-handler unit tests for /api/extensions/[id]/audit (+server.ts).
 *
 * Phase 52.2 expanded the handler from a governance-only endpoint to
 * a fan-in merger over governance + sdk_capability_calls + resource
 * audit logs. The legacy governance-only shape is preserved behind
 * `?legacy=1` for the existing tooling.
 *
 * Covers:
 *   - 401 / 403 / scope-403 auth gates (regression)
 *   - 404 on unknown extension
 *   - happy path → routes through mergeAuditForExtension by default
 *   - legacy=1 falls back to listAuditForExtension (governance only)
 *   - filter query params (capability, status, since, until, cursor)
 *     are forwarded to the merger.
 *   - unknown capability values are silently dropped (not 500).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/extensions", () => ({
  getExtension: vi.fn(),
}));

vi.mock("$server/db/queries/audit-log", () => ({
  listAuditForExtension: vi.fn(),
}));

vi.mock("$server/db/queries/audit-merge", () => ({
  mergeAuditForExtension: vi.fn(),
  statsForExtension: vi.fn(),
}));

const { getExtension } = await import("$server/db/queries/extensions");
const { listAuditForExtension } = await import("$server/db/queries/audit-log");
const { mergeAuditForExtension } = await import("$server/db/queries/audit-merge");
const { GET } = await import(
  "../routes/api/extensions/[id]/audit/+server.ts"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
  search?: string;
}) {
  const id = opts.id ?? "ext-1";
  const href = `http://localhost/api/extensions/${id}/audit${opts.search ?? ""}`;
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(href),
  } as any;
}

const adminUser = { id: "u1", email: "a@x", name: "a", role: "admin" };
const regularUser = { id: "u2", email: "u@x", name: "u", role: "user" };

describe("GET /api/extensions/[id]/audit", () => {
  beforeEach(() => {
    vi.mocked(getExtension).mockReset();
    vi.mocked(listAuditForExtension).mockReset();
    vi.mocked(mergeAuditForExtension).mockReset();
  });

  test("unauthenticated request throws 401", async () => {
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

  test("non-admin authenticated user throws 403", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ locals: { user: regularUser } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
  });

  test("API-key scope check returns 403 when scope missing", async () => {
    const res = await GET(
      makeEvent({
        locals: { user: adminUser, apiKeyScopes: ["read"] },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("admin");
  });

  test("unknown extension returns 404", async () => {
    vi.mocked(getExtension).mockResolvedValue(null as any);
    const res = await GET(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("happy path: routes through mergeAuditForExtension by default", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    vi.mocked(mergeAuditForExtension).mockResolvedValue({
      entries: [
        { kind: "capability", id: "c1" } as any,
      ],
      nextCursor: "cur-2",
    });

    const res = await GET(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: unknown[];
      nextCursor: string | null;
    };
    expect(body.entries).toHaveLength(1);
    expect(body.nextCursor).toBe("cur-2");
    expect(vi.mocked(mergeAuditForExtension)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listAuditForExtension)).not.toHaveBeenCalled();
  });

  test("legacy=1 falls back to listAuditForExtension (governance only)", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    vi.mocked(listAuditForExtension).mockResolvedValue([
      { id: "a1", action: "extension:install" },
    ] as any);
    const res = await GET(
      makeEvent({
        locals: { user: adminUser },
        search: "?legacy=1&limit=1000&offset=25",
      }),
    );
    expect(res.status).toBe(200);
    // limit is clamped to 500 by the legacy branch
    expect(vi.mocked(listAuditForExtension)).toHaveBeenCalledWith(
      "ext-1",
      { limit: 500, offset: 25 },
    );
    expect(vi.mocked(mergeAuditForExtension)).not.toHaveBeenCalled();
  });

  test("forwards filter query params to mergeAuditForExtension", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    vi.mocked(mergeAuditForExtension).mockResolvedValue({ entries: [], nextCursor: null });

    await GET(
      makeEvent({
        locals: { user: adminUser },
        search: "?capability=llm&status=denial&since=2026-05-01T00:00:00Z&until=2026-05-08T00:00:00Z&cursor=abc&limit=50",
      }),
    );

    expect(vi.mocked(mergeAuditForExtension)).toHaveBeenCalledWith(
      "ext-1",
      expect.objectContaining({
        capability: "llm",
        status: "denial",
        cursor: "abc",
        limit: 50,
      }),
    );
    const opts = vi.mocked(mergeAuditForExtension).mock.calls[0]![1] as {
      since: Date;
      until: Date;
    };
    expect(opts.since).toBeInstanceOf(Date);
    expect(opts.until).toBeInstanceOf(Date);
  });

  test("unknown capability is silently dropped (not 500)", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    vi.mocked(mergeAuditForExtension).mockResolvedValue({ entries: [], nextCursor: null });

    const res = await GET(
      makeEvent({
        locals: { user: adminUser },
        search: "?capability=evilSqlInjection",
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(mergeAuditForExtension)).toHaveBeenCalledWith(
      "ext-1",
      expect.objectContaining({ capability: undefined }),
    );
  });

  test("malformed since/until are dropped (not propagated as Invalid Date)", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    vi.mocked(mergeAuditForExtension).mockResolvedValue({ entries: [], nextCursor: null });

    await GET(
      makeEvent({
        locals: { user: adminUser },
        search: "?since=not-a-date&until=neither-this",
      }),
    );

    const opts = vi.mocked(mergeAuditForExtension).mock.calls[0]![1] as {
      since?: Date | undefined;
      until?: Date | undefined;
    };
    expect(opts.since).toBeUndefined();
    expect(opts.until).toBeUndefined();
  });
});

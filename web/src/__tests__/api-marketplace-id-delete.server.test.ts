/**
 * Server-handler unit tests for /api/marketplace/[id]/delete (+server.ts).
 *
 * Covers admin gating (requireRole throws 401/403) and the 404 path
 * when `deleteListing` returns false. The 404 branch is exercised via
 * a mock so we avoid standing up PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/marketplace", () => ({
  deleteListing: vi.fn(),
}));
vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { deleteListing } = await import("$server/db/queries/marketplace");
const { DELETE } = await import(
  "../routes/api/marketplace/[id]/delete/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  id?: string;
}) {
  const id = opts.id ?? "abc";
  return {
    url: new URL(`http://localhost/api/marketplace/${id}/delete`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/marketplace/${id}/delete`, {
      method: "DELETE",
    }),
  } as any;
}

describe("DELETE /api/marketplace/[id]/delete", () => {
  beforeEach(() => {
    vi.mocked(deleteListing).mockReset();
  });

  test("unauthenticated request throws 401 Response", async () => {
    let res: Response | undefined;
    try {
      await DELETE(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("non-admin authenticated request throws 403 Response", async () => {
    let res: Response | undefined;
    try {
      await DELETE(
        makeEvent({
          locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
  });

  test("missing listing returns 404 via errorJson", async () => {
    vi.mocked(deleteListing).mockResolvedValue(false as any);
    const res = await DELETE(
      makeEvent({
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "admin" },
        },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Listing not found");
  });
});

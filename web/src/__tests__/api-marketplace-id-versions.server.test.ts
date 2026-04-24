/**
 * Server-handler unit tests for /api/marketplace/[id]/versions (+server.ts).
 *
 * Auth gate + happy path. DB is mocked.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/marketplace-versions", () => ({
  listVersions: vi.fn(),
}));

const { listVersions } = await import(
  "$server/db/queries/marketplace-versions"
);
const { GET } = await import(
  "../routes/api/marketplace/[id]/versions/+server.ts"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
}) {
  const id = opts.id ?? "listing-1";
  return {
    url: new URL(`http://localhost/api/marketplace/${id}/versions`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/marketplace/${id}/versions`),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/marketplace/[id]/versions", () => {
  beforeEach(() => {
    vi.mocked(listVersions).mockReset();
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

  test("API-key scope check returns 403 when scope missing", async () => {
    const res = await GET(
      makeEvent({ locals: { user, apiKeyScopes: ["admin"] } }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("read");
  });

  test("happy path: returns versions list", async () => {
    vi.mocked(listVersions).mockResolvedValue([
      { id: "v1", version: "1.0.0" },
    ] as any);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ version: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].version).toBe("1.0.0");
    expect(vi.mocked(listVersions)).toHaveBeenCalledWith("listing-1");
  });
});

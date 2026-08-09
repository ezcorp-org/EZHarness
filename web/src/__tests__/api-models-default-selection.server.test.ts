/**
 * Server-handler unit tests for /api/models/default-selection (+server.ts).
 *
 * The endpoint answers "what does a user with no saved model pick default to?"
 * and is the operator's revert path for routed-by-default traffic, so the two
 * properties that matter are: it is readable by a plain member (NOT admin-only
 * — otherwise a revert would never reach most users), and an absent/garbage
 * settings row degrades to "auto" instead of failing the composer.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(),
}));

const { getSetting } = await import("$server/db/queries/settings");
const { GET } = await import("../routes/api/models/default-selection/+server.ts");

function makeEvent(locals: Record<string, unknown> = {}) {
  return {
    url: new URL("http://localhost/api/models/default-selection"),
    locals,
  } as any;
}

const memberLocals = {
  user: { id: "u1", email: "u@x", name: "u", role: "user" },
};

beforeEach(() => {
  vi.mocked(getSetting).mockReset();
});

describe("GET /api/models/default-selection", () => {
  test("rejects unauthenticated callers with 401", async () => {
    vi.mocked(getSetting).mockResolvedValue(undefined as any);
    let res: Response | undefined;
    try {
      await GET(makeEvent());
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("a plain member (NOT admin) gets the value — the revert must reach everyone", async () => {
    vi.mocked(getSetting).mockResolvedValue("first" as any);
    const res = await GET(makeEvent(memberLocals));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe("first");
    expect(getSetting).toHaveBeenCalledWith("provider:defaultSelection");
  });

  test('an unset setting reads as "auto" (routing is the ship default)', async () => {
    vi.mocked(getSetting).mockResolvedValue(undefined as any);
    const res = await GET(makeEvent(memberLocals));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe("auto");
  });

  test('a malformed row reads as "auto" rather than 500-ing', async () => {
    vi.mocked(getSetting).mockResolvedValue({ mode: "first" } as any);
    const res = await GET(makeEvent(memberLocals));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe("auto");
  });

  test('an explicit "auto" row round-trips', async () => {
    vi.mocked(getSetting).mockResolvedValue("auto" as any);
    const res = await GET(makeEvent(memberLocals));
    expect(((await res.json()) as { value: string }).value).toBe("auto");
  });
});

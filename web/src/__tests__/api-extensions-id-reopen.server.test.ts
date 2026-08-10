/**
 * Server-handler tests for POST /api/extensions/[id]/reopen.
 *
 * Owner-scoped via the shared `reopenInstalledAsDraft` helper.
 * NOT_FOUND_OR_NOT_MODIFIABLE is mapped to an OPAQUE 404 (a caller can
 * never distinguish missing / not-owned / flag-off / bundled). There
 * is no admin-override edit path here.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

// The route does `err instanceof ReopenError`, importing it from this
// same module — so the mock must export the real class and the mock
// helper must throw instances of THAT class.
class ReopenError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReopenError";
    this.code = code;
  }
}
vi.mock("$server/extensions/reopen-extension", () => ({
  reopenInstalledAsDraft: vi.fn(),
  ReopenError,
}));

const { reopenInstalledAsDraft } = await import(
  "$server/extensions/reopen-extension"
);
const { POST } = await import(
  "../routes/api/extensions/[id]/reopen/+server.ts"
);

function makeEvent(opts: { id?: string; locals?: Record<string, unknown> }) {
  const id = opts.id ?? "ext-1";
  return makeRequestEvent(`http://localhost/api/extensions/${id}/reopen`, {
    locals: opts.locals ?? {},
    params: { id },
    request: {
      method: "POST",
    },
  });
}

const owner = { id: "owner-1", email: "o@x", name: "o", role: "member" };

describe("POST /api/extensions/[id]/reopen", () => {
  beforeEach(() => {
    vi.mocked(reopenInstalledAsDraft).mockReset();
  });

  test("unauthenticated → 401", async () => {
    const res = await POST(makeEvent({ locals: {} }));
    expect(res.status).toBe(401);
  });

  test("owner + modifiable → 200 { draftId, name }", async () => {
    vi.mocked(reopenInstalledAsDraft).mockResolvedValue({
      draftId: "draft-9",
      name: "weather",
    });
    const res = await POST(makeEvent({ locals: { user: owner } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draftId: "draft-9", name: "weather" });
    expect(vi.mocked(reopenInstalledAsDraft)).toHaveBeenCalledWith(
      "ext-1",
      owner.id,
    );
  });

  test("NOT_FOUND_OR_NOT_MODIFIABLE → opaque 404", async () => {
    vi.mocked(reopenInstalledAsDraft).mockRejectedValue(
      new ReopenError("NOT_FOUND_OR_NOT_MODIFIABLE", "nope"),
    );
    const res = await POST(makeEvent({ locals: { user: owner } }));
    expect(res.status).toBe(404);
  });

  test("other ReopenError code → 409", async () => {
    vi.mocked(reopenInstalledAsDraft).mockRejectedValue(
      new ReopenError("NO_INSTALL_PATH", "no on-disk source"),
    );
    const res = await POST(makeEvent({ locals: { user: owner } }));
    expect(res.status).toBe(409);
  });

  test("unexpected (non-ReopenError) throw → 500", async () => {
    vi.mocked(reopenInstalledAsDraft).mockRejectedValue(new Error("boom"));
    const res = await POST(makeEvent({ locals: { user: owner } }));
    expect(res.status).toBe(500);
  });
});

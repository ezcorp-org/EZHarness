/**
 * Server-handler unit tests for /api/favicon (+server.ts).
 *
 * Covers auth gating + the missing/invalid-URL guard. The success path
 * (which fans out to https://www.google.com/s2/favicons) is intentionally
 * omitted to keep the suite hermetic.
 */

import { test, expect, describe } from "vitest";
import { GET } from "../routes/api/favicon/+server.ts";

function makeEvent(opts: {
  rawUrl?: string;
  locals?: Record<string, unknown>;
}) {
  const href = opts.rawUrl
    ? `http://localhost/api/favicon?url=${encodeURIComponent(opts.rawUrl)}`
    : "http://localhost/api/favicon";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href),
  } as any;
}

describe("GET /api/favicon", () => {
  test("unauthenticated request throws 401 Response", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ rawUrl: "https://example.com", locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });

  test("missing url query parameter returns 400", async () => {
    const res = await GET(
      makeEvent({
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("url parameter required");
  });

  test("malformed url returns 400 'Invalid URL'", async () => {
    // A value that starts with "http" skips the auto-prefix branch and is
    // passed verbatim to the URL constructor — "http://" alone has no host
    // and raises TypeError, which the handler maps to 400 Invalid URL.
    const res = await GET(
      makeEvent({
        rawUrl: "http://",
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid URL");
  });
});

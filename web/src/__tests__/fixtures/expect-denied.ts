/**
 * Assert that a `+server.ts` handler denied a request by RETURNING its Response.
 *
 * WHY THIS EXISTS
 *
 * SvelteKit does not recognise a `Response` THROWN from a route handler. It
 * treats it as an unhandled error, runs `handleError`, and answers the caller
 * with a generic 500 `{"message":"Internal Error"}`. So a denial that throws is
 * a bug even though the thrown object carries status 401/403 — the status the
 * client actually sees is 500.
 *
 * Every admin-gated route suite in this directory used to assert denial with
 * some variant of
 *
 *     try {
 *       await POST(event);
 *       expect.fail("should have thrown");
 *     } catch (thrown) {
 *       expect(thrown).toBeInstanceOf(Response);
 *       res = thrown as Response;
 *     }
 *     expect(res!.status).toBe(403);
 *
 * which reads like a 403 assertion but actually PINS THE BUG: it passes only
 * while the handler throws, and would fail if the handler were fixed. That is
 * why `POST /api/extensions/[id]/reapprove-drift` shipped returning 500 to
 * every non-admin caller with a fully green suite.
 *
 * `expectDenied` inverts the contract: the handler must RETURN, and a thrown
 * Response fails loudly with the real-world symptom spelled out.
 *
 * Lives under `__tests__/` so the coverage gates treat it as test scaffolding
 * (`**\/__tests__\/**` is in NON_SOURCE_GLOBS), not gated product code.
 */
import { expect } from "vitest";

/**
 * Invoke a route handler that is expected to deny the request.
 *
 * @param invoke  Thunk calling the handler (so the throw happens in here).
 * @param status  The HTTP status the caller must actually receive.
 * @returns       The returned denial Response, for further body assertions.
 */
export async function expectDenied(
  invoke: () => unknown,
  status: number,
): Promise<Response> {
  let result: unknown;
  try {
    result = await invoke();
  } catch (thrown) {
    if (thrown instanceof Response) {
      expect.fail(
        `handler THREW its ${thrown.status} Response instead of returning it. ` +
          "SvelteKit surfaces a thrown Response as a 500 \"Internal Error\", so " +
          `the caller never sees ${status}. Gate the route with checkRole() or ` +
          "requireAdmin(), which RETURN the denial Response.",
      );
    }
    throw thrown;
  }
  expect(result).toBeInstanceOf(Response);
  const res = result as Response;
  expect(res.status).toBe(status);
  return res;
}

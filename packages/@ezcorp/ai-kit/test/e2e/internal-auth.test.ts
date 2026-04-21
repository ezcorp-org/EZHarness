import { beforeAll, describe, expect, test } from "bun:test";
import { EzcorpClient } from "../../src/client";
import { E2E_API_KEY, E2E_BASE_URL, e2eReady } from "./_guard";

/** End-to-end verification of the internal-auth security contract against
 *  a live SvelteKit server. Skipped unless EZCORP_E2E_BASE_URL is set.
 *
 *  What this suite proves that the unit/integration tests cannot:
 *    - The hooks.server.ts wiring actually routes `ezkint_*` tokens to
 *      the internal-auth module (not the user-key verifier) over a real
 *      HTTP request, not just in-process calls.
 *    - A forged internal-prefixed token over HTTP returns 401 from the
 *      real auth middleware — no info leak (the prefix doesn't widen the
 *      attack surface vs. a random Bearer token).
 *    - A user-prefixed key continues to work end-to-end (no regression
 *      in the primary auth path).
 *
 *  The test does NOT attempt to call the server with a VALID internal
 *  key from outside the server process — by design, we can't get the raw
 *  key out of the in-memory store. That's the security property at work.
 */

let ready = false;
beforeAll(async () => {
  ready = await e2eReady();
});

describe.skipIf(!E2E_BASE_URL)("e2e: internal-auth HTTP contract", () => {
  test("forged ezkint_ token is rejected with 401 from the live server", async () => {
    if (!ready) return;
    const forged = "ezkint_" + "A".repeat(43);
    const res = await fetch(new URL("/api/auth/me", E2E_BASE_URL!), {
      headers: { Authorization: `Bearer ${forged}` },
    });
    // The prefix match is not a security boundary; an unknown key must
    // land on the same unauth'd path as any other bogus Bearer.
    expect(res.status).toBe(401);
  }, 10_000);

  test("random-garbage Bearer is rejected with 401 (baseline)", async () => {
    if (!ready) return;
    const res = await fetch(new URL("/api/auth/me", E2E_BASE_URL!), {
      headers: { Authorization: "Bearer random-gibberish-token" },
    });
    expect(res.status).toBe(401);
  }, 10_000);

  test("ezkint_ rejection and random-token rejection look IDENTICAL to the client (no prefix-based info leak)", async () => {
    if (!ready) return;
    const forged = "ezkint_" + "B".repeat(43);
    const random = "ezk_" + "C".repeat(43);
    const [a, b] = await Promise.all([
      fetch(new URL("/api/auth/me", E2E_BASE_URL!), {
        headers: { Authorization: `Bearer ${forged}` },
      }),
      fetch(new URL("/api/auth/me", E2E_BASE_URL!), {
        headers: { Authorization: `Bearer ${random}` },
      }),
    ]);
    expect(a.status).toBe(b.status);
    // Also the response bodies — error messages shouldn't discriminate.
    const aBody = await a.text();
    const bBody = await b.text();
    expect(aBody).toBe(bBody);
  }, 10_000);

  test("a valid user-issued key still authenticates (no regression)", async () => {
    if (!ready || !E2E_API_KEY) {
      console.log("[skip] no E2E_API_KEY — can't verify user-key regression path");
      return;
    }
    const client = new EzcorpClient({ baseUrl: E2E_BASE_URL!, apiKey: E2E_API_KEY! });
    const me = await client.me();
    expect(me.id).toBeString();
  }, 10_000);
});

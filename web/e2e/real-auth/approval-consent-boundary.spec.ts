/**
 * e2e: a leaked API key cannot answer a workflow approval (R-4).
 *
 * A workflow run parks on an `approval` step precisely so that a PERSON
 * decides. Answering one is therefore the consent boundary. This route used to
 * gate on `requireScope(locals, "chat")` — which passes for any `chat`-scoped
 * key — so a leaked key was a CONSENT-MINTING key and the approval mechanism
 * was decorative against exactly the threat it exists for.
 *
 * Proven here against a real previewed server (playwright.real.config), with
 * real keys minted over HTTP and driven cookielessly:
 *
 *   1. Mint a `chat` key and a maximum-authority (admin-role, all-scopes) key
 *      as the bootstrapped admin.
 *   2. As a PURE bearer client (raw `fetch`, NO cookie), POST an answer:
 *      both get 403 `Interactive session required`.
 *   3. The SAME request with the admin's session COOKIE gets 404 — the
 *      approval id is fabricated, so 404 is the "past the gate" signal.
 *
 * 403-vs-404 is what makes this a real assertion rather than a tautology.
 * A refused caller never reaches `answerApproval`, so it CANNOT learn that
 * the approval does not exist; a caller that got through would be told 404 by
 * the chokepoint. The fabricated id is deliberate: it needs no parked run, and
 * it means a regression shows up as 404 (got in) rather than as a silent pass.
 *
 * Raw `fetch` for the bearer calls so the admin session cookie is provably
 * absent — the ONLY authority is the key, which is the whole claim.
 */
import { test, expect } from "../fixtures/hydration.js";

// A syntactically fine approval id that certainly does not exist. Reaching
// `answerApproval` with it yields `not-found` → 404.
const ABSENT_APPROVAL = "e2e-no-such-approval-0000";

const ANSWER_BODY = JSON.stringify({ choice: "approve" });

test.describe("the workflow approval consent boundary is session-only", () => {
  test("no API key can answer an approval; the human's cookie still can", async ({
    request,
    baseURL,
  }) => {
    // 1. Mint keys with the admin session cookie (storageState).
    const chatKeyRes = await request.post("/api/settings/developer/api-keys", {
      data: { name: "e2e-consent-chat", scopes: ["chat"] },
    });
    expect(chatKeyRes.status(), await chatKeyRes.text()).toBe(201);
    const chatKey = ((await chatKeyRes.json()) as { key: string }).key;

    // The maximum-authority key the system can mint: admin ROLE plus every
    // SCOPE. `answerApproval`'s ownership branch short-circuits on `isAdmin`,
    // so if any key were going to get through, it would be this one.
    const superKeyRes = await request.post("/api/settings/developer/api-keys", {
      data: {
        name: "e2e-consent-super",
        scopes: ["read", "chat", "extensions", "admin"],
        role: "admin",
      },
    });
    expect(superKeyRes.status(), await superKeyRes.text()).toBe(201);
    const superKeyBody = (await superKeyRes.json()) as { key: string; role: string };
    expect(superKeyBody.role).toBe("admin");

    // Cookieless bearer helper — raw fetch, the ONLY authority is the key.
    const call = (key: string, path: string, init: RequestInit = {}) =>
      fetch(`${baseURL}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}` },
      });

    // Sanity: both keys genuinely AUTHENTICATE. Without this the 403s below
    // would be unfalsifiable — a key that failed to verify is also refused,
    // and for entirely the wrong reason.
    for (const key of [chatKey, superKeyBody.key]) {
      const me = await call(key, "/api/auth/me");
      expect(me.status).toBe(200);
    }

    const answerAs = (key: string) =>
      call(key, `/api/workflows/approvals/${ABSENT_APPROVAL}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: ANSWER_BODY,
      });

    // 2. The R-4 attack. A `chat` key satisfied the OLD gate outright.
    const chatAnswer = await answerAs(chatKey);
    const chatText = await chatAnswer.text();
    expect(chatAnswer.status, chatText).toBe(403);
    expect(chatText).toContain("Interactive session required");

    // Not even the maximum-authority key. Role is a different axis: an
    // admin-role key that got through could clear ANY user's gate on ANY run.
    const superAnswer = await answerAs(superKeyBody.key);
    const superText = await superAnswer.text();
    expect(superAnswer.status, superText).toBe(403);
    expect(superText).toContain("Interactive session required");

    // An unauthenticated caller is 401, not 403 — so the 403s above are a
    // decision about the PRINCIPAL, not the generic "no auth" response.
    const anon = await fetch(`${baseURL}/api/workflows/approvals/${ABSENT_APPROVAL}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ANSWER_BODY,
    });
    expect(anon.status).toBe(401);

    // 3. The control, and the half that proves the route is closed rather
    // than broken: the SAME user, at a browser, gets past the gate and is
    // answered by the chokepoint — which reports the fabricated id as 404.
    const human = await request.post(`/api/workflows/approvals/${ABSENT_APPROVAL}`, {
      data: { choice: "approve" },
    });
    expect(human.status(), await human.text()).toBe(404);
  });
});

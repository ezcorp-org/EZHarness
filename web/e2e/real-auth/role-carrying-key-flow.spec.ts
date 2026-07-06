/**
 * e2e: role-carrying API keys drive a `requireRole(admin)` route.
 *
 * Proves the two-axis auth model end-to-end against a real previewed server
 * (see playwright.real.config):
 *
 *   1. As the bootstrapped admin (cookie), mint an admin-ROLE key and a
 *      member-role key — both carrying the `admin` SCOPE.
 *   2. As a PURE bearer client (raw fetch, NO cookie), hit GET
 *      /api/settings/:key (a role-gated route): the admin-role key reaches
 *      the handler (404 for an unset key), the member-role key is refused
 *      with a clean 403 — NOT a 500, and NOT a leak.
 *   3. Anti-escalation over HTTP: the member-role key (admin scope) cannot
 *      mint itself an admin-role key (403), but can still mint a member key.
 *
 * The role wall is what made these routes unreachable by ANY key before
 * role-carrying keys existed; this spec pins that they are reachable now, and
 * only by an explicitly minted admin-role key.
 *
 * Raw `fetch` (not a Playwright request context) is used for the bearer calls
 * so the admin session cookie is provably absent — the ONLY authority is the
 * key, which is what proves role resolution comes from the key.
 */
import { test, expect } from "@playwright/test";

// An unset, non-sensitive settings key: a role-gated GET returns 404 once the
// caller is past requireRole, so 404 (not 403) proves the admin-role key
// cleared the role wall.
const PROBE_KEY = "zz:e2e:role-probe";

test.describe("role-carrying API keys — requireRole route access", () => {
  test("admin-role key reaches a role-gated route; member key gets 403", async ({
    request,
    baseURL,
  }) => {
    // 1. Mint both keys with the admin session cookie (storageState).
    const adminKeyRes = await request.post("/api/settings/developer/api-keys", {
      data: { name: "e2e-admin-role", scopes: ["read", "admin"], role: "admin" },
    });
    expect(adminKeyRes.status(), await adminKeyRes.text()).toBe(201);
    const adminKeyBody = (await adminKeyRes.json()) as { key: string; role: string };
    expect(adminKeyBody.role).toBe("admin");

    const memberKeyRes = await request.post("/api/settings/developer/api-keys", {
      // role omitted → defaults to member, even though it holds the admin scope.
      data: { name: "e2e-member-role", scopes: ["read", "admin"] },
    });
    expect(memberKeyRes.status(), await memberKeyRes.text()).toBe(201);
    const memberKeyBody = (await memberKeyRes.json()) as { key: string; role: string };
    expect(memberKeyBody.role).toBe("member");

    // Cookieless bearer helper — raw fetch, the ONLY authority is the key.
    const call = (key: string, path: string, init: RequestInit = {}) =>
      fetch(`${baseURL}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}` },
      });

    // Sanity: the principal's role is resolved FROM THE KEY, not the owning
    // user (both keys are owned by the admin user).
    const adminMe = await call(adminKeyBody.key, "/api/auth/me");
    expect(adminMe.status).toBe(200);
    expect(((await adminMe.json()) as { user: { role: string } }).user.role).toBe("admin");

    const memberMe = await call(memberKeyBody.key, "/api/auth/me");
    expect(memberMe.status).toBe(200);
    expect(((await memberMe.json()) as { user: { role: string } }).user.role).toBe("member");

    // A garbage bearer is unauthenticated → 401 (proves 404 below is a
    // past-the-role-wall signal, not an unauth response).
    const bogus = await call("ezk_not-a-real-key", `/api/settings/${PROBE_KEY}`);
    expect(bogus.status).toBe(401);

    // Admin-ROLE key clears the role wall → 404 for the unset probe key.
    const adminGet = await call(adminKeyBody.key, `/api/settings/${PROBE_KEY}`);
    expect(adminGet.status).toBe(404);

    // Member-role key (admin scope, member role) → clean 403, never 500.
    const memberGet = await call(memberKeyBody.key, `/api/settings/${PROBE_KEY}`);
    expect(memberGet.status).toBe(403);

    // Anti-escalation: member key can't mint an admin-role key…
    const escalate = await call(memberKeyBody.key, "/api/settings/developer/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "escalate", scopes: ["read"], role: "admin" }),
    });
    expect(escalate.status).toBe(403);

    // …but CAN still mint a member-role key (unchanged posture).
    const memberMint = await call(memberKeyBody.key, "/api/settings/developer/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "member-ok", scopes: ["read"] }),
    });
    const mintedText = await memberMint.text();
    expect(memberMint.status, mintedText).toBe(201);
    expect((JSON.parse(mintedText) as { role: string }).role).toBe("member");
  });
});

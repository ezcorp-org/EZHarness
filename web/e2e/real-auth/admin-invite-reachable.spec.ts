/**
 * e2e (real tier): the admin invite API is reachable over real HTTP, and the
 * token sub-path stays anonymous.
 *
 * F5: `/api/auth/invite` sat in `PUBLIC_PATHS` in `web/src/hooks.server.ts`,
 * and `isPublic` matches an entry exactly OR as a prefix. `event.locals.user`
 * is only assigned INSIDE the `if (!isPublic)` block, so the bare path
 * skipped auth, `locals.user` stayed undefined, and the admin create/list
 * handlers (`requireRole(locals, "admin")`) always 401'd.
 *
 * This has to be the REAL tier. The mock tier stubs `/api/auth/invite` at the
 * network layer (`web/e2e/teams.spec.ts`), so the request never reaches
 * `hooks.server.ts` — which is precisely why the bug survived: the stub
 * answers before the broken code runs.
 */
import { test, expect } from "../fixtures/hydration.js";

test.describe("admin invite API reachability (F5)", () => {
  test("bare path is admin-authenticated; :token path stays anonymous", async ({
    request,
    baseURL,
  }) => {
    // `request` carries the bootstrapped admin session cookie (storageState).
    // Pre-fix this returned 401 no matter who asked.
    const list = await request.get("/api/auth/invite");
    expect(list.status(), await list.text()).toBe(200);
    const listBody = (await list.json()) as { invites?: unknown[] };
    expect(Array.isArray(listBody.invites)).toBe(true);

    // The write half of the admin surface, also previously unreachable.
    const created = await request.post("/api/auth/invite", {
      data: { email: `e2e-invite-${Date.now()}@example.com`, role: "member" },
    });
    expect(created.status(), await created.text()).toBe(201);
    const invite = (await created.json()) as {
      invite: { id: string; token: string };
    };
    expect(invite.invite.token).toBeTruthy();

    // Cookieless raw fetch — proves the bare path is genuinely gated and not
    // merely passing because the browser context happens to be authed.
    const anon = await fetch(`${baseURL}/api/auth/invite`);
    expect(anon.status).toBe(401);

    // Direction 2: the token sub-path must still be reachable with NO auth at
    // all — that is the invitee's entire flow.
    const anonToken = await fetch(`${baseURL}/api/auth/invite/${invite.invite.token}`);
    expect(anonToken.status).toBe(200);
    expect(((await anonToken.json()) as { valid: boolean }).valid).toBe(true);

    // An unknown token is a 404 from the handler, NOT a 401 from the hook —
    // proving the sub-path reaches the route rather than the auth gate.
    const anonBadToken = await fetch(`${baseURL}/api/auth/invite/not-a-real-token`);
    expect(anonBadToken.status).toBe(404);
  });
});

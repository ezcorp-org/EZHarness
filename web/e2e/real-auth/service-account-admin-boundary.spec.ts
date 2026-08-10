/**
 * e2e: no API key can mint a service account, and the reach warning reaches
 * the client (C3 phase 2, spec §6.4 + §6.5).
 *
 * Two claims, both end-to-end against a real previewed server with a real DB:
 *
 *  1. **The route is session-only.** A service account is a principal that
 *     OTHER people's scheduled jobs will later run as, and its scope ceiling is
 *     the creating admin's. Minting one from a long-lived bearer key would mean
 *     a leaked key mints durable authority. The gate is the positively-stamped
 *     `locals.authMethod === "session"` allowlist, so even the
 *     maximum-authority key the system can issue — admin ROLE plus every SCOPE
 *     — is refused. The unit suites pin the gate function; this pins the
 *     WIRING, which is where a session-only route actually fails.
 *
 *  2. **The `system`-only reach warning is on the wire.** Spec §6.5 requires an
 *     admin to learn AT CREATION that a service account can only be delegated
 *     `system`-visible workflows. The creation UI is a later phase, so the
 *     warning ships machine-readable on the response and this spec is what
 *     stops it being dropped before that UI exists.
 *
 * 403-vs-201 is what makes claim 1 an assertion rather than a tautology: the
 * admin's own cookie, same body, same route, succeeds. A deny-everyone
 * regression fails the control half.
 *
 * Raw `fetch` for the bearer calls so the admin session cookie is provably
 * absent — the only authority is the key, which is the whole claim.
 */
import { test, expect } from "../fixtures/hydration.js";

const ACCOUNT_NAME = "e2e-nightly-runner";

test.describe("the service-account admin route is session-only", () => {
  test("no API key can mint one; the admin's cookie can, and is warned about reach", async ({
    request,
    baseURL,
  }) => {
    // The maximum-authority key the system can mint: admin ROLE plus every
    // SCOPE. If any key were going to get through an admin route, it is this.
    const superKeyRes = await request.post("/api/settings/developer/api-keys", {
      data: {
        name: "e2e-sa-super",
        scopes: ["read", "write", "chat", "extensions", "admin"],
        role: "admin",
      },
    });
    expect(superKeyRes.status(), await superKeyRes.text()).toBe(201);
    const superKey = (await superKeyRes.json()) as { key: string; role: string };
    expect(superKey.role).toBe("admin");

    // Cookieless bearer helper — raw fetch, the ONLY authority is the key.
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${baseURL}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${superKey.key}` },
      });

    // Sanity: the key genuinely AUTHENTICATES. Without this the 403s below
    // would be unfalsifiable — a key that failed to verify is also refused,
    // and for entirely the wrong reason.
    expect((await call("/api/auth/me")).status).toBe(200);

    const createBody = JSON.stringify({ name: ACCOUNT_NAME, maxTokensPerDay: 50_000 });
    const keyCreate = await call("/api/service-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: createBody,
    });
    const keyCreateText = await keyCreate.text();
    expect(keyCreate.status, keyCreateText).toBe(403);
    expect(keyCreateText).toContain("Interactive session required");

    // Reading the list is refused on the SESSION axis, and that is worth
    // saying since the read was widened: it now answers any authenticated
    // SESSION with a two-field projection, and it still answers no KEY at
    // all. Widening the read to non-admin humans did not widen it to bearer
    // tokens — a leaked read-scoped key still cannot enumerate the
    // instance's non-human principals.
    expect((await call("/api/service-accounts")).status).toBe(403);

    // The daily-cap route is on the same axis. It writes the number that
    // bounds how much unattended LLM spend a whole family of jobs may make
    // in a day, so a leaked key must not reach it either.
    const keyCap = await call("/api/service-accounts/whatever/daily-cap", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxTokensPerDay: 999_999 }),
    });
    expect(keyCap.status).toBe(403);
    expect(await keyCap.text()).toContain("Interactive session required");

    // An unauthenticated caller is 401, not 403 — so the 403s above are a
    // decision about the PRINCIPAL, not the generic "no auth" response.
    const anon = await fetch(`${baseURL}/api/service-accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: createBody,
    });
    expect(anon.status).toBe(401);

    // ── the control: the same human, at a browser ────────────────────────
    const human = await request.post("/api/service-accounts", {
      data: { name: ACCOUNT_NAME, maxTokensPerDay: 50_000, description: "nightly jobs" },
    });
    expect(human.status(), await human.text()).toBe(201);
    const created = (await human.json()) as {
      account: { id: string; name: string; maxTokensPerDay: number; enabled: boolean };
      droppedScopes: string[];
      reach: { code: string; runnableVisibilities: string[]; message: string };
    };
    expect(created.account.name).toBe(ACCOUNT_NAME);
    expect(created.account.maxTokensPerDay).toBe(50_000);
    expect(created.account.enabled).toBe(true);
    expect(created.droppedScopes).toEqual([]);

    // Spec §6.5 — the reach warning, machine-readable, at creation time.
    expect(created.reach.code).toBe("SERVICE_ACCOUNT_SYSTEM_ONLY");
    expect(created.reach.runnableVisibilities).toEqual(["system"]);
    expect(created.reach.message).toContain("system");

    // RULING 3 — tokens are the enforced bound and there is no cents field.
    // A body that names one is refused rather than silently ignored, so a
    // caller cannot believe it set a cap it did not set.
    const cents = await request.post("/api/service-accounts", {
      data: { name: "e2e-cents", maxTokensPerDay: 10, maxCostCentsPerDay: 500 },
    });
    expect(cents.status()).toBe(400);
    expect(await cents.text()).toContain("maxTokensPerDay");

    // The account is visible on the list, with the same warning alongside.
    const list = await request.get("/api/service-accounts");
    expect(list.status()).toBe(200);
    const listed = (await list.json()) as {
      accounts: Array<{ id: string; name: string }>;
      reach: { runnableVisibilities: string[] };
    };
    expect(listed.accounts.map((a) => a.name)).toContain(ACCOUNT_NAME);
    expect(listed.reach.runnableVisibilities).toEqual(["system"]);

    // ── the D10 remedy, end to end ───────────────────────────────────────
    //
    // Rung D10 refuses a delegated fire once the owning account has spent
    // `max_tokens_per_day` and names raising that cap as the remedy. Until
    // this route existed the remedy was unreachable: POST wrote the number
    // once at mint time and nothing moved it.
    const raised = await request.patch(`/api/service-accounts/${created.account.id}/daily-cap`, {
      data: { maxTokensPerDay: 250_000 },
    });
    expect(raised.status(), await raised.text()).toBe(200);
    const afterRaise = (await raised.json()) as {
      account: { maxTokensPerDay: number; enabled: boolean; scopes: string[] };
    };
    expect(afterRaise.account.maxTokensPerDay).toBe(250_000);
    // It moved ONE number: the account is still live and its ceiling is
    // untouched.
    expect(afterRaise.account.enabled).toBe(true);
    expect(afterRaise.account.scopes).toEqual([]);

    // Strict body, on the wire: RULING 3's cents cap is a 400 here too, and
    // so is smuggling `enabled` through a route whose subject is a number.
    for (const bad of [
      { maxTokensPerDay: 10, maxCostCentsPerDay: 500 },
      { maxTokensPerDay: 10, enabled: false },
      { maxTokensPerDay: 0 },
      {},
    ]) {
      const res = await request.patch(`/api/service-accounts/${created.account.id}/daily-cap`, {
        data: bad,
      });
      expect(res.status(), JSON.stringify(bad)).toBe(400);
    }
    // …and the cap really is unchanged by all four refusals.
    const stillRaised = await request.get("/api/service-accounts");
    const row = (
      (await stillRaised.json()) as {
        accounts: Array<{ id: string; maxTokensPerDay: number }>;
      }
    ).accounts.find((a) => a.id === created.account.id);
    expect(row?.maxTokensPerDay).toBe(250_000);

    // An unknown account is a 404, not a silent 200.
    const missing = await request.patch(
      "/api/service-accounts/00000000-0000-4000-8000-000000000000/daily-cap",
      { data: { maxTokensPerDay: 1 } },
    );
    expect(missing.status()).toBe(404);

    // Disable, then remove — the lifecycle an admin actually has. No live
    // delegation names this account, so the delete is permitted (409 is the
    // answer when one does; that path is covered against a real DB in
    // src/__tests__/service-accounts-queries.test.ts).
    const disabled = await request.patch(`/api/service-accounts/${created.account.id}`, {
      data: { enabled: false, disabledReason: "e2e teardown" },
    });
    expect(disabled.status(), await disabled.text()).toBe(200);
    expect(
      ((await disabled.json()) as { account: { disabledReason: string } }).account.disabledReason,
    ).toBe("e2e teardown");

    const removed = await request.delete(`/api/service-accounts/${created.account.id}`);
    expect(removed.status()).toBe(204);
    const afterDelete = await request.delete(`/api/service-accounts/${created.account.id}`);
    expect(afterDelete.status()).toBe(404);
  });
});

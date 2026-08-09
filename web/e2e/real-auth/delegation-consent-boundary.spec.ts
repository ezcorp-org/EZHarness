/**
 * e2e: C3's delegation consent surface is session-only, and a real
 * consent round-trips (T14 + the CRUD).
 *
 * Consenting to a delegation mints STANDING, unattended authority: an
 * extension job may run one workflow, as a chosen principal, on a
 * schedule, until somebody revokes it. That is a strictly stronger act
 * than answering one approval — which is already session-only for the
 * same reason (`approval-consent-boundary.spec.ts`, R-4). A leaked
 * `chat` key that could mint a delegation would be a key that runs a
 * workflow forever rather than once.
 *
 * Proven against a real previewed server (playwright.real.config), with
 * real keys minted over HTTP and driven cookielessly:
 *
 *   1. Mint a `chat` key and a maximum-authority (admin-role, every
 *      scope) key as the bootstrapped admin.
 *   2. As a PURE bearer client (raw `fetch`, NO cookie), call all four
 *      verbs: every one is 403 `Interactive session required`.
 *   3. Anonymous is 401, so the 403s are a decision about the PRINCIPAL
 *      rather than the generic "no auth" answer.
 *   4. The SAME admin, at a browser, gets past the gate on all four —
 *      and the write half actually round-trips: consent → list → revoke,
 *      and (phase 8a) consent → PATCH the token ceiling → list.
 *
 * The control in step 4 is what makes this an assertion rather than a
 * tautology. Without it a route that refused everyone would pass steps
 * 1–3 perfectly.
 *
 * `PATCH` is the fourth verb and the one that closes C3's permanent-DoS
 * shape: `RESUME_RULES["budget-exceeded"]` names raising
 * `max_tokens_per_run` as the only way a parked delegated run continues,
 * and until phase 8a nothing could raise it — the consent route was the
 * sole writer and its supersede tombstones the row that rule re-reads.
 */
import { test, expect } from "../fixtures/hydration.js";

const ABSENT_DELEGATION = "e2e-no-such-delegation-0000";

function consentBody(extensionId: string, workflowName: string, jobRef: string) {
  return {
    extensionId,
    jobRef,
    workflowName,
    ownerKind: "user" as const,
    triggerKind: "cron",
    triggerSpec: { expr: "0 3 * * *" },
    maxTokensPerRun: 5000,
    maxRunsPerDay: 24,
  };
}

test.describe("the delegation consent surface is session-only", () => {
  test("no API key can mint, list or revoke a delegation", async ({ request, baseURL }) => {
    const chatKeyRes = await request.post("/api/settings/developer/api-keys", {
      data: { name: "e2e-deleg-chat", scopes: ["chat"] },
    });
    expect(chatKeyRes.status(), await chatKeyRes.text()).toBe(201);
    const chatKey = ((await chatKeyRes.json()) as { key: string }).key;

    // The maximum-authority key the system can mint. If any key were
    // going to get through a consent gate, it would be this one.
    const superKeyRes = await request.post("/api/settings/developer/api-keys", {
      data: {
        name: "e2e-deleg-super",
        scopes: ["read", "write", "chat", "extensions", "admin"],
        role: "admin",
      },
    });
    expect(superKeyRes.status(), await superKeyRes.text()).toBe(201);
    const superKey = ((await superKeyRes.json()) as { key: string }).key;

    const call = (key: string, path: string, init: RequestInit = {}) =>
      fetch(`${baseURL}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}` },
      });

    // Sanity: both keys genuinely AUTHENTICATE. Without this the 403s
    // below would be unfalsifiable — a key that failed to verify is also
    // refused, and for entirely the wrong reason.
    for (const key of [chatKey, superKey]) {
      expect((await call(key, "/api/auth/me")).status).toBe(200);
    }

    for (const key of [chatKey, superKey]) {
      const listed = await call(key, "/api/workflows/delegations");
      const listedText = await listed.text();
      expect(listed.status, listedText).toBe(403);
      expect(listedText).toContain("Interactive session required");

      const minted = await call(key, "/api/workflows/delegations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(consentBody("ext-anything", "anything", "job-1")),
      });
      const mintedText = await minted.text();
      expect(minted.status, mintedText).toBe(403);
      expect(mintedText).toContain("Interactive session required");

      const revoked = await call(key, `/api/workflows/delegations/${ABSENT_DELEGATION}`, {
        method: "DELETE",
      });
      const revokedText = await revoked.text();
      expect(revoked.status, revokedText).toBe(403);
      expect(revokedText).toContain("Interactive session required");

      // The spend bounds are the numbers that decide how much unattended
      // LLM spend somebody's job may make, and how often it may make it. A
      // key that could move either would be a key that lifts a bound it
      // never consented to. BOTH are asserted: `maxRunsPerDay` joined this
      // route later than `maxTokensPerRun`, and a field added to a schema
      // without its own boundary assertion is a field whose gate nobody
      // re-checked.
      for (const body of [{ maxTokensPerRun: 999_999 }, { maxRunsPerDay: 999 }]) {
        const patched = await call(key, `/api/workflows/delegations/${ABSENT_DELEGATION}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const patchedText = await patched.text();
        expect(patched.status, patchedText).toBe(403);
        expect(patchedText).toContain("Interactive session required");
      }
    }

    // An unauthenticated caller is 401, so the 403s above are about the
    // PRINCIPAL and not about the absence of one.
    const anon = await fetch(`${baseURL}/api/workflows/delegations`);
    expect(anon.status).toBe(401);
  });

  test("the human at a browser consents, sees it listed, and revokes it", async ({ request }) => {
    // A workflow of the admin's own, so the delegation's principal (the
    // admin, `ownerKind: "user"`) can genuinely run it. `POST
    // /api/workflows` defaults a new row to `system` visibility.
    const workflowName = `e2e-deleg-wf-${Date.now()}`;
    const created = await request.post("/api/workflows", {
      data: {
        name: workflowName,
        description: "delegation consent e2e",
        steps: [{ name: "s1", kind: "transform", input: {}, output: { ok: "true" } }],
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    // A real, registry-resolved extension id: the consent route takes the
    // extension NAME from the registry and never from the body, so this
    // has to be an extension the host actually has.
    const extensionsRes = await request.get("/api/extensions");
    expect(extensionsRes.status(), await extensionsRes.text()).toBe(200);
    // `GET /api/extensions` serves a bare array of rows.
    const installed = (await extensionsRes.json()) as Array<{ id: string }>;
    const extensionId = installed[0]?.id;
    expect(extensionId, "the real tier must bootstrap at least one extension").toBeTruthy();

    const jobRef = `e2e-job-${Date.now()}`;
    const consent = await request.post("/api/workflows/delegations", {
      data: consentBody(extensionId!, workflowName, jobRef),
    });
    expect(consent.status(), await consent.text()).toBe(201);
    const body = (await consent.json()) as {
      delegation: { id: string; ownerId: string; workflowName: string };
      supersededId: string | null;
      material: { workflowName: string };
    };
    expect(body.delegation.workflowName).toBe(workflowName);
    expect(body.supersededId).toBeNull();
    // The owner came from the SESSION, never from the body — the body
    // never named one.
    expect(body.delegation.ownerId).toBeTruthy();
    // The material is returned so a dialog reads the object the hash was
    // taken over rather than deriving a second one.
    expect(body.material.workflowName).toBe(workflowName);

    const listed = await request.get("/api/workflows/delegations");
    expect(listed.status(), await listed.text()).toBe(200);
    const rows = (await listed.json()) as { delegations: Array<{ id: string }> };
    expect(rows.delegations.map((d) => d.id)).toContain(body.delegation.id);

    // Re-consenting the same (extension, job) supersedes rather than
    // colliding with the partial unique index.
    const again = await request.post("/api/workflows/delegations", {
      data: consentBody(extensionId!, workflowName, jobRef),
    });
    expect(again.status(), await again.text()).toBe(201);
    const second = (await again.json()) as {
      delegation: { id: string };
      supersededId: string;
    };
    expect(second.supersededId).toBe(body.delegation.id);

    // The superseded row is already a tombstone, so revoking it is a
    // no-op — reported honestly rather than claimed as a fresh
    // revocation.
    const stale = await request.delete(`/api/workflows/delegations/${body.delegation.id}`);
    expect(stale.status(), await stale.text()).toBe(200);
    expect(await stale.json()).toEqual({ revoked: false });

    // The LIVE row revokes for real, and leaves the list.
    const revoke = await request.delete(`/api/workflows/delegations/${second.delegation.id}`);
    expect(revoke.status(), await revoke.text()).toBe(200);
    expect(await revoke.json()).toEqual({ revoked: true });
    const after = await request.get("/api/workflows/delegations");
    const remaining = (await after.json()) as { delegations: Array<{ id: string }> };
    expect(remaining.delegations.map((d) => d.id)).not.toContain(second.delegation.id);

    const unknown = await request.delete(`/api/workflows/delegations/${ABSENT_DELEGATION}`);
    expect(unknown.status(), await unknown.text()).toBe(404);
  });

  test("the human adjusts the spend bounds in place, and only those", async ({ request }) => {
    // ── Phase 8a, over real HTTP ────────────────────────────────────
    //
    // `RESUME_RULES["budget-exceeded"]` names raising this cap as the
    // ONLY way a parked delegated run continues, and before this route
    // nothing could raise it: the sole writer was the consent route,
    // whose supersede tombstones the row that rule re-reads. So the
    // remedy existed in prose and nowhere else.
    //
    // What this proves that a handler test cannot: the verb survives the
    // real router and the real hooks, the strict schema refuses over the
    // wire, and the adjusted row is what `GET` then serves back.
    const workflowName = `e2e-deleg-patch-wf-${Date.now()}`;
    const created = await request.post("/api/workflows", {
      data: {
        name: workflowName,
        description: "delegation PATCH e2e",
        steps: [{ name: "s1", kind: "transform", input: {}, output: { ok: "true" } }],
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    const extensionsRes = await request.get("/api/extensions");
    const installed = (await extensionsRes.json()) as Array<{ id: string }>;
    const extensionId = installed[0]?.id;
    expect(extensionId, "the real tier must bootstrap at least one extension").toBeTruthy();

    const jobRef = `e2e-patch-job-${Date.now()}`;
    const consent = await request.post("/api/workflows/delegations", {
      data: consentBody(extensionId!, workflowName, jobRef),
    });
    expect(consent.status(), await consent.text()).toBe(201);
    const { delegation } = (await consent.json()) as {
      delegation: { id: string; maxTokensPerRun: number; maxRunsPerDay: number };
    };
    expect(delegation.maxTokensPerRun).toBe(5000);
    expect(delegation.maxRunsPerDay).toBe(24);

    const patch = await request.patch(`/api/workflows/delegations/${delegation.id}`, {
      data: { maxTokensPerRun: 250_000 },
    });
    expect(patch.status(), await patch.text()).toBe(200);
    const patched = (await patch.json()) as {
      delegation: { id: string; maxTokensPerRun: number; workflowName: string };
    };
    // IN PLACE — the same row id. A supersede would have minted another
    // and tombstoned this one, which is what stranded parked runs.
    expect(patched.delegation.id).toBe(delegation.id);
    expect(patched.delegation.maxTokensPerRun).toBe(250_000);
    expect(patched.delegation.workflowName).toBe(workflowName);

    // The list agrees, and still shows exactly one live row for this job.
    const listed = await request.get("/api/workflows/delegations");
    const rows = (await listed.json()) as {
      delegations: Array<{ id: string; jobRef: string; maxTokensPerRun: number }>;
    };
    const mine = rows.delegations.filter((d) => d.jobRef === jobRef);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe(delegation.id);
    expect(mine[0]?.maxTokensPerRun).toBe(250_000);

    // Ruling 2 over the wire: anything that is part of what the human
    // APPROVED is a 400, not a silently-ignored field. `maxRunsPerDay` is
    // deliberately NOT in this list — see the positive case below.
    for (const forbidden of [
      { maxTokensPerRun: 10, workflowName: "something-else" },
      { maxTokensPerRun: 10, ownerKind: "service" },
      { maxTokensPerRun: 10, consentHash: "forged" },
      { maxTokensPerRun: 10, projectId: "some-project" },
      { maxTokensPerRun: 10, enabled: true },
      { maxTokensPerRun: 10, disabledReason: null },
      { maxTokensPerRun: 10, triggerKind: "webhook" },
      { maxTokensPerRun: 0 },
      { maxRunsPerDay: 0 },
      {},
    ]) {
      const bad = await request.patch(`/api/workflows/delegations/${delegation.id}`, {
        data: forbidden,
      });
      expect(bad.status(), JSON.stringify(forbidden)).toBe(400);
    }
    // …and nothing moved.
    const after = await request.get("/api/workflows/delegations");
    const afterRows = (await after.json()) as {
      delegations: Array<{ jobRef: string; maxTokensPerRun: number; maxRunsPerDay: number }>;
    };
    expect(afterRows.delegations.find((d) => d.jobRef === jobRef)?.maxTokensPerRun).toBe(250_000);
    expect(afterRows.delegations.find((d) => d.jobRef === jobRef)?.maxRunsPerDay).toBe(24);

    // The OTHER spend bound is adjustable in place too, and this is the
    // line the route moved on purpose. `maxRunsPerDay` was a 400 here
    // until `feat(c3): maxRunsPerDay joins the in-place delegation PATCH
    // surface`: Ruling 2 governs approved MATERIAL, and neither bound is
    // material — they cap what the approved job may SPEND, not what it may
    // DO. Sending someone through a full re-consent (a new row, the old
    // one tombstoned, a dialog re-approving an unchanged capability set)
    // to make a nightly job run twice is what teaches people to click
    // through consent dialogs.
    //
    // Asserted as ONE request carrying BOTH bounds, which is precisely the
    // payload the forbidden list above used to contain.
    const both = await request.patch(`/api/workflows/delegations/${delegation.id}`, {
      data: { maxTokensPerRun: 300_000, maxRunsPerDay: 96 },
    });
    expect(both.status(), await both.text()).toBe(200);
    const bothBody = (await both.json()) as {
      delegation: { id: string; maxTokensPerRun: number; maxRunsPerDay: number };
    };
    // Still IN PLACE: the same row id, so raising a quota did not tombstone
    // and re-mint the delegation a parked run re-reads.
    expect(bothBody.delegation.id).toBe(delegation.id);
    expect(bothBody.delegation.maxTokensPerRun).toBe(300_000);
    expect(bothBody.delegation.maxRunsPerDay).toBe(96);

    // …and GET serves both back, so the write reached the row rather than
    // only the response body.
    const widened = await request.get("/api/workflows/delegations");
    const widenedRows = (await widened.json()) as {
      delegations: Array<{ id: string; jobRef: string; maxRunsPerDay: number }>;
    };
    const stillOne = widenedRows.delegations.filter((d) => d.jobRef === jobRef);
    expect(stillOne).toHaveLength(1);
    expect(stillOne[0]?.id).toBe(delegation.id);
    expect(stillOne[0]?.maxRunsPerDay).toBe(96);

    // Not an existence oracle — same 404 the DELETE gives.
    const missing = await request.patch(`/api/workflows/delegations/${ABSENT_DELEGATION}`, {
      data: { maxTokensPerRun: 10 },
    });
    expect(missing.status(), await missing.text()).toBe(404);

    // A tombstone has no budget to adjust.
    const revoke = await request.delete(`/api/workflows/delegations/${delegation.id}`);
    expect(revoke.status(), await revoke.text()).toBe(200);
    const dead = await request.patch(`/api/workflows/delegations/${delegation.id}`, {
      data: { maxTokensPerRun: 10 },
    });
    expect(dead.status(), await dead.text()).toBe(409);
    expect(await dead.text()).toContain("revoked");
  });
});

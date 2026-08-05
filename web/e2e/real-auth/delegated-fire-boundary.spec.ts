/**
 * e2e: C3 phase 6 — what the `runFor` ladder looks like from OUTSIDE the
 * host, over real HTTP, against a real database.
 *
 * ## The honest scope of this spec, stated up front
 *
 * A delegated fire has **no HTTP surface at all**. It arrives as an
 * `ezcorp/workflows-delegated` reverse-RPC frame from a SANDBOXED
 * extension subprocess, and the SDK verb that emits it (`ctx.workflows.runFor`)
 * is phase 7. So this spec cannot fire one, and does not pretend to — the
 * ladder itself is proven end to end, through the real handler and the
 * real executor, in `src/extensions/__tests__/workflows-delegated-ladder.test.ts`
 * and `src/__tests__/workflow-delegated-ceiling-e2e.test.ts`.
 *
 * What it CAN prove, and what would silently break without it:
 *
 *  1. **That absence is a property, not an oversight.** Nothing under
 *     `/api/workflows/**` will accept a job ref and start a run on a
 *     delegation's behalf — not even the bootstrapped admin at a browser
 *     with a live delegation of their own. §4's whole argument is that
 *     "invent an owner" is inexpressible; a route that took a `jobRef`
 *     would make it expressible again, from a surface an API key can
 *     reach.
 *  2. **The consent-time refusal D7 re-asks at every fire** (§6.1). A
 *     `service` delegation for a non-`system` workflow is refused NOW,
 *     with a message naming the reason and the remedy, rather than
 *     silently at the first cron tick.
 *  3. **`enabled` + `disabledReason` reach the client.** They are the
 *     entire remedy path for D7's
 *     `DELEGATION_OWNER_LOST_WORKFLOW_ACCESS`: the rung disables the row
 *     with a stated reason so the human sees "this job stopped, here is
 *     why" instead of watching `consecutive_failures` climb to the
 *     auto-disable threshold. If the list route ever stops carrying
 *     them, the rung still fires and nobody is ever told.
 *
 * Every refusal below is paired with the same call succeeding for the
 * legitimate shape, because a route that refused everything would satisfy
 * the first half of all three.
 */
import { test, expect } from "@playwright/test";

const STAMP = Date.now();

interface DelegationWire {
  id: string;
  workflowName: string;
  ownerKind: string;
  ownerId: string;
  enabled: boolean;
  disabledReason: string | null;
}

test.describe("the delegated fire has no HTTP surface, and consent refuses what D7 would", () => {
  test("no route accepts a job ref, and a service delegation for a project workflow is refused", async ({
    request,
    baseURL,
  }) => {
    // ── fixtures: one `system` workflow and one `project` workflow ──────
    //
    // `POST /api/workflows` defaults a new row to `system`; FORK stamps
    // `project`, which is C3's headline use case and exactly the
    // combination §6.1 refuses for a service account.
    const systemName = `e2e-runfor-sys-${STAMP}`;
    const created = await request.post("/api/workflows", {
      data: {
        name: systemName,
        description: "runFor e2e",
        steps: [{ name: "s1", kind: "transform", input: {}, output: { ok: "true" } }],
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    // A fork is never NAMED by its caller: `workflow_definitions.name` is
    // globally unique, and `pickForkName` absorbs the collision server-side
    // so two callers cannot race for one name. The route's body is
    // `.strict()` with `projectId` alone, and it RETURNS the name it chose.
    const forked = await request.post(`/api/workflows/${systemName}/fork`, { data: {} });
    expect(forked.status(), await forked.text()).toBe(201);
    const forkBody = (await forked.json()) as { name: string; forkedFrom: string };
    // The premise of every refusal below is that `projectName` is a
    // DIFFERENT, `project`-visibility row cloned from our `system` one. If
    // the fork ever silently handed back the source, claim 2 would be
    // asserting `system`-vs-`system` and would pass for the wrong reason.
    expect(forkBody.forkedFrom).toBe(systemName);
    expect(forkBody.name).not.toBe(systemName);
    const projectName = forkBody.name;

    const extensionsRes = await request.get("/api/extensions");
    expect(extensionsRes.status(), await extensionsRes.text()).toBe(200);
    const installed = (await extensionsRes.json()) as Array<{ id: string }>;
    const extensionId = installed[0]?.id;
    expect(extensionId, "the real tier must bootstrap at least one extension").toBeTruthy();

    const account = await request.post("/api/service-accounts", {
      data: { name: `e2e-runfor-acct-${STAMP}`, maxTokensPerDay: 50_000 },
    });
    expect(account.status(), await account.text()).toBe(201);
    const accountId = ((await account.json()) as { account: { id: string } }).account.id;

    // The REQUEST names the column (`ownerServiceAccountId`); the
    // RESPONSE flattens both owner columns into one `ownerId`
    // (`toWorkflowDelegationView`, via the schema's keyed lookup). They
    // are deliberately different names and are asserted as such below —
    // sending the response's name on the request is a `.strict()` 400.
    const consentBody = (
      workflowName: string,
      ownerKind: "user" | "service",
      jobRef: string,
    ) => ({
      extensionId: extensionId!,
      jobRef,
      workflowName,
      ownerKind,
      ...(ownerKind === "service" ? { ownerServiceAccountId: accountId } : {}),
      triggerKind: "cron",
      triggerSpec: { expr: "0 3 * * *" },
      maxTokensPerRun: 5_000,
      maxRunsPerDay: 24,
    });

    // ── claim 2 — §6.1's consent-time refusal, which D7 re-asks ─────────
    //
    // A service account carries `userId: null`, so it satisfies
    // `visibility: 'system'` and nothing else. The fork is `project`.
    const refused = await request.post("/api/workflows/delegations", {
      data: consentBody(projectName, "service", `e2e-job-svc-${STAMP}`),
    });
    const refusedText = await refused.text();
    expect(refused.status(), refusedText).toBe(403);
    // The message names the REASON and the REMEDY, not a generic 403 — a
    // user who picked the wrong principal must learn it here rather than
    // three days later from an audit row.
    expect(refusedText).toContain("system-visible");
    expect(refusedText).toContain("run as me");

    // The control, and it is what makes the refusal an assertion about
    // the PRINCIPAL rather than about the workflow: the same fork, the
    // same route, consented as the human — who may run every
    // `project`-visible workflow on the instance — succeeds.
    const asMe = await request.post("/api/workflows/delegations", {
      data: consentBody(projectName, "user", `e2e-job-user-${STAMP}`),
    });
    expect(asMe.status(), await asMe.text()).toBe(201);
    const liveId = ((await asMe.json()) as { delegation: { id: string } }).delegation.id;

    // …and the second control: the SAME service account CAN hold a
    // delegation, as long as the workflow is `system`-visible. Without
    // this, "service accounts are refused" would read as the rule.
    const svcOnSystem = await request.post("/api/workflows/delegations", {
      data: consentBody(systemName, "service", `e2e-job-svc-ok-${STAMP}`),
    });
    expect(svcOnSystem.status(), await svcOnSystem.text()).toBe(201);
    const svcId = ((await svcOnSystem.json()) as { delegation: { id: string } }).delegation.id;

    // ── claim 3 — the remedy path reaches the client ────────────────────
    const listed = await request.get("/api/workflows/delegations");
    expect(listed.status(), await listed.text()).toBe(200);
    const rows = ((await listed.json()) as { delegations: DelegationWire[] }).delegations;
    const mine = rows.find((d) => d.id === liveId);
    expect(mine, "the delegation just consented to must be listed").toBeTruthy();
    // A live row: on, with nothing to explain. `disabledReason` is the
    // field D7 writes, and a projection that dropped it would make the
    // rung's whole point invisible.
    expect(mine!.enabled).toBe(true);
    expect(mine!.disabledReason).toBeNull();
    expect(mine!.ownerKind).toBe("user");
    expect(rows.find((d) => d.id === svcId)?.ownerKind).toBe("service");
    // The principal actually BOUND, read back off the wire. This is what
    // makes the two controls above assertions about WHO rather than about
    // a string the route echoed: the service row carries the account, and
    // the user row carries the consenting human — never each other's.
    expect(rows.find((d) => d.id === svcId)?.ownerId).toBe(accountId);
    expect(mine!.ownerId).not.toBe(accountId);

    // ── claim 1 — a job ref buys nothing over HTTP ──────────────────────
    //
    // The admin holds a LIVE delegation (`liveId`) whose job ref is known
    // to them. Every plausible shape of "fire it" is tried, and none of
    // them exists: the only caller of the ladder is a sandboxed extension
    // over reverse-RPC, keyed on a REGISTRY-resolved extension id that a
    // browser cannot present.
    const jobRef = `e2e-job-user-${STAMP}`;
    const smuggled = { op: "runFor", jobRef, delegationId: liveId, extensionId: extensionId! };

    // (a) There is no delegation-fire route to call. Two plausible shapes
    //     a future refactor might reach for, both absent.
    for (const path of [
      `/api/workflows/delegations/${liveId}/run`,
      "/api/workflows/delegations/run",
    ]) {
      const res = await request.post(path, { data: smuggled });
      const text = await res.text();
      expect([404, 405], `${path} answered ${res.status()}: ${text}`).toContain(res.status());
    }

    // (b) The ORDINARY run route does exist, and the delegated payload
    //     buys nothing there. `postBodySchema` is `.loose()`, so these
    //     fields flow through as workflow INPUT — data, never authority.
    //     The run happens on the SESSION's own right to run the fork.
    const ranAsMe = await request.post(`/api/workflows/${projectName}/run`, {
      data: smuggled,
    });
    expect([200, 202], await ranAsMe.text()).toContain(ranAsMe.status());

    // (c) …and THIS is what makes (b) an assertion rather than a shrug:
    //     the identical body, from a caller with NO session at all, is
    //     401. Raw `fetch` so the admin cookie is provably absent. The
    //     job ref is not a credential — it carried no authority in (b),
    //     and it carries none on its own.
    const cookieless = await fetch(`${baseURL}/api/workflows/${projectName}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(smuggled),
    });
    expect([401, 403]).toContain(cookieless.status);

    // ── teardown ────────────────────────────────────────────────────────
    for (const id of [liveId, svcId]) {
      const revoked = await request.delete(`/api/workflows/delegations/${id}`);
      expect(revoked.status()).toBe(200);
    }
    expect((await request.delete(`/api/service-accounts/${accountId}`)).status()).toBe(204);
  });
});

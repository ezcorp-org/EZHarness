/**
 * C3 phase 4 — `workflow_delegations` persistence.
 *
 * Three properties this file exists to pin, in order of how expensive
 * they are to get wrong:
 *
 *  1. **Owner resolution is keyed, not switched.** The write sets exactly
 *     one owner column and explicitly NULLs every other, and the read
 *     finds it again without knowing which arm it is on.
 *  2. **`listPinnedDelegationVersionIds` actually protects a version.**
 *     Asserted end-to-end through the real sweep, because the failure
 *     mode is a `warn` log line in a daemon and nothing else.
 *  3. **Revocation is a tombstone**, so re-consenting the same
 *     `(extension, job)` works and the partial unique index never fires.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  carryDelegationConsentForward,
  createWorkflowDelegation,
  delegationOwnerId,
  disableWorkflowDelegation,
  findLiveWorkflowDelegation,
  getWorkflowDelegation,
  listPinnedDelegationVersionIds,
  listWorkflowDelegationsConsentedBy,
  revokeWorkflowDelegation,
  setDelegationRunBounds,
  toWorkflowDelegationView,
} = await import("../db/queries/workflow-delegations");
const { listDelegatedRunsForConsenter } = await import("../db/queries/workflow-runs");
const { createUser } = await import("../db/queries/users");
const { createWorkflow } = await import("../db/queries/workflows");
const { ensureWorkflowVersion, sweepWorkflowDefinitionVersions, listWorkflowVersions } =
  await import("../db/queries/workflow-versions");
const { getDb } = await import("../db/connection");
const { extensions, serviceAccounts, workflowRuns } = await import("../db/schema");
const { eq } = await import("drizzle-orm");

const CONSENTER = "user-consenter";
const OTHER = "user-other";
const EXT = "ext-1";

async function freshDb() {
  await setupTestDb();
  await createUser({ id: CONSENTER, email: "c@x", passwordHash: "h", name: "C" });
  await createUser({ id: OTHER, email: "o@x", passwordHash: "h", name: "O" });
  await getDb()
    .insert(extensions)
    .values({
      id: EXT,
      name: "ext",
      version: "1.0.0",
      description: "ext",
      manifest: { schemaVersion: 2, name: "ext" } as never,
      source: "test:ext",
      installPath: "/tmp/ext",
      enabled: true,
    } as never);
}

async function serviceAccount(id: string, enabled = true): Promise<string> {
  const [row] = await getDb()
    .insert(serviceAccounts)
    .values({
      id,
      name: `svc-${id}`,
      createdByUserId: CONSENTER,
      maxTokensPerDay: 1000,
      enabled,
    })
    .returning();
  return row!.id;
}

function consentInput(overrides: Record<string, unknown> = {}) {
  return {
    extensionId: EXT,
    jobRef: "job-1",
    ownerKind: "user" as const,
    ownerId: CONSENTER,
    workflowName: "w",
    definitionVersionId: null,
    projectId: null,
    triggerKind: "cron",
    triggerSpec: { expr: "0 * * * *" },
    consentHash: "hash-1",
    definitionHash: "def-1",
    capabilitySet: [{ kind: "agent", value: "writer" }],
    maxTokensPerRun: 5000,
    maxRunsPerDay: 24,
    consentedByUserId: CONSENTER,
    ...overrides,
  };
}

describe("owner resolution goes through the schema's keyed lookup", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("a user delegation populates owner_user_id and NULLs the other arm", async () => {
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.delegation.ownerUserId).toBe(CONSENTER);
    expect(created.delegation.ownerServiceAccountId).toBeNull();
    expect(delegationOwnerId(created.delegation)).toBe(CONSENTER);
  });

  test("a service delegation populates the OTHER column, and the read finds it", async () => {
    const svc = await serviceAccount("svc-1");
    const created = await createWorkflowDelegation(
      consentInput({ ownerKind: "service", ownerId: svc }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.delegation.ownerUserId).toBeNull();
    expect(created.delegation.ownerServiceAccountId).toBe(svc);
    // The whole point of the keyed lookup: the caller never named a
    // column, and the read did not switch on the kind either.
    expect(delegationOwnerId(created.delegation)).toBe(svc);
  });

  test("re-consenting onto the OTHER arm clears the first arm", async () => {
    // A row naming both a user and a service account is exactly as
    // ambiguous as one naming neither, so the supersede writes every
    // owner column explicitly rather than only the one it wants.
    const svc = await serviceAccount("svc-1");
    await createWorkflowDelegation(consentInput());
    const second = await createWorkflowDelegation(
      consentInput({ ownerKind: "service", ownerId: svc }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.delegation.ownerUserId).toBeNull();
    expect(second.delegation.ownerServiceAccountId).toBe(svc);
  });
});

describe("consent, supersede, and whose consent it is", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("re-consenting supersedes MY live row and tombstones it", async () => {
    const first = await createWorkflowDelegation(consentInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await createWorkflowDelegation(consentInput({ consentHash: "hash-2" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.supersededId).toBe(first.delegation.id);
    expect(second.delegation.id).not.toBe(first.delegation.id);
    // The old row survives as history with a revocation stamp…
    const old = await getWorkflowDelegation(first.delegation.id);
    expect(old?.revokedAt).not.toBeNull();
    // …and the live lookup returns exactly the new one.
    const live = await findLiveWorkflowDelegation(EXT, "job-1");
    expect(live?.id).toBe(second.delegation.id);
    expect(live?.consentHash).toBe("hash-2");
  });

  test("the first consent supersedes nothing", async () => {
    const first = await createWorkflowDelegation(consentInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.supersededId).toBeNull();
  });

  test("another user's live consent is REFUSED, not silently taken over", async () => {
    // `consented_by_user_id` names the human who may answer a
    // service-account run's approvals, so reassigning it would move one
    // user's answering authority to another.
    await createWorkflowDelegation(consentInput());
    const stolen = await createWorkflowDelegation(consentInput({ consentedByUserId: OTHER }));
    expect(stolen).toEqual({
      ok: false,
      code: "DELEGATION_CONSENT_NOT_YOURS",
      message:
        "Another user already consented to this job. " +
        "Ask them to revoke their delegation before consenting to it yourself.",
    });
    // …and the refusal wrote nothing: the original is untouched.
    const live = await findLiveWorkflowDelegation(EXT, "job-1");
    expect(live?.consentedByUserId).toBe(CONSENTER);
  });

  test("after the first user revokes, the second user MAY consent", async () => {
    // The paired success. Without it, a "refuse everyone" bug passes the
    // test above.
    const first = await createWorkflowDelegation(consentInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await revokeWorkflowDelegation(first.delegation.id)).toBe(true);
    const second = await createWorkflowDelegation(consentInput({ consentedByUserId: OTHER }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.delegation.consentedByUserId).toBe(OTHER);
    // The partial unique index tolerated two rows for one (ext, job)
    // because only one of them is live.
    expect(second.supersededId).toBeNull();
  });
});

describe("revocation is a tombstone", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("a revoked delegation drops out of the live lookup but survives by id", async () => {
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await revokeWorkflowDelegation(created.delegation.id)).toBe(true);
    expect(await findLiveWorkflowDelegation(EXT, "job-1")).toBeUndefined();
    expect((await getWorkflowDelegation(created.delegation.id))?.id).toBe(created.delegation.id);
  });

  test("a second revoke returns false and does NOT move the timestamp", async () => {
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await revokeWorkflowDelegation(created.delegation.id);
    const first = (await getWorkflowDelegation(created.delegation.id))?.revokedAt;
    expect(await revokeWorkflowDelegation(created.delegation.id)).toBe(false);
    expect((await getWorkflowDelegation(created.delegation.id))?.revokedAt).toEqual(first!);
  });

  test("revoking an unknown id is false, not a throw", async () => {
    expect(await revokeWorkflowDelegation(crypto.randomUUID())).toBe(false);
  });

  test("the list is scoped to the consenting human and hides revoked rows", async () => {
    const mine = await createWorkflowDelegation(consentInput());
    const theirs = await createWorkflowDelegation(
      consentInput({ jobRef: "job-2", consentedByUserId: OTHER, ownerId: OTHER }),
    );
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;

    expect((await listWorkflowDelegationsConsentedBy(CONSENTER)).map((r) => r.id)).toEqual([
      mine.delegation.id,
    ]);
    expect((await listWorkflowDelegationsConsentedBy(OTHER)).map((r) => r.id)).toEqual([
      theirs.delegation.id,
    ]);
    await revokeWorkflowDelegation(mine.delegation.id);
    expect(await listWorkflowDelegationsConsentedBy(CONSENTER)).toEqual([]);
  });
});

describe("a supersede carries PARKED runs forward onto the new authority", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  /** A `workflow_runs` row in one status, pointed at one delegation. */
  async function run(id: string, status: string, delegationId: string): Promise<void> {
    await getDb()
      .insert(workflowRuns)
      .values({
        id,
        workflowName: "w",
        status,
        input: {},
        startedAt: new Date(),
        delegationId,
        runAsKind: "user",
        runAs: CONSENTER,
      } as never);
  }

  async function delegationOf(id: string): Promise<string | null> {
    const [row] = await getDb()
      .select({ delegationId: workflowRuns.delegationId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, id));
    return row?.delegationId ?? null;
  }

  test("a SUSPENDED run moves; terminal and running rows do NOT", async () => {
    // Without this the two C3 resume rules are unsatisfiable in practice
    // and every parked delegated run is stuck forever. Re-consent is this
    // function, and it tombstones; both `RESUME_RULES` predicates read
    // the RUN's own `delegation_id` and refuse a revoked row, so the
    // remedies their own prose names ("only raising that cap lets it
    // continue", "only a fresh consent lets it continue") were
    // unreachable. Phase 8a added a second way out for the FIRST of those
    // two — `setDelegationRunBounds`, pinned in its own block below —
    // and this carry-forward remains the only one for `consent-stale`,
    // whose predicate demands a fresh `consented_at`.
    const first = await createWorkflowDelegation(consentInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const old = first.delegation.id;
    await run("r-parked", "suspended", old);
    await run("r-done", "success", old);
    await run("r-live", "running", old);

    const second = await createWorkflowDelegation(consentInput({ consentHash: "hash-2" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.supersededId).toBe(old);

    // The parked run now names the authority that can actually admit it.
    expect(await delegationOf("r-parked")).toBe(second.delegation.id);
    // History does not move: a terminal run names the authority it really
    // executed under…
    expect(await delegationOf("r-done")).toBe(old);
    // …and a RUNNING run belongs to the process holding its lease, whose
    // boundary check re-reads this column mid-flight.
    expect(await delegationOf("r-live")).toBe(old);
  });

  test("the audit SNAPSHOT of the principal is untouched by the move", async () => {
    // `delegation_id` is the live FK and is what moves; `run_as_kind` /
    // `run_as` are the record of who the run executed as and must survive
    // both revocation and owner deletion.
    const first = await createWorkflowDelegation(consentInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await run("r-parked", "suspended", first.delegation.id);

    await createWorkflowDelegation(consentInput({ consentHash: "hash-2" }));

    const [row] = await getDb()
      .select({ runAsKind: workflowRuns.runAsKind, runAs: workflowRuns.runAs })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, "r-parked"));
    expect(row).toEqual({ runAsKind: "user", runAs: CONSENTER });
  });

  test("a REVOKE leaves a parked run parked — there is no successor to move it to", async () => {
    // Withdrawing authority must not free a run the authority was holding.
    const first = await createWorkflowDelegation(consentInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await run("r-parked", "suspended", first.delegation.id);

    expect(await revokeWorkflowDelegation(first.delegation.id)).toBe(true);

    expect(await delegationOf("r-parked")).toBe(first.delegation.id);
  });

  test("another delegation's parked run is not dragged along", async () => {
    const mine = await createWorkflowDelegation(consentInput());
    const other = await createWorkflowDelegation(consentInput({ jobRef: "job-2" }));
    expect(mine.ok && other.ok).toBe(true);
    if (!mine.ok || !other.ok) return;
    await run("r-mine", "suspended", mine.delegation.id);
    await run("r-other", "suspended", other.delegation.id);

    const again = await createWorkflowDelegation(consentInput({ consentHash: "hash-2" }));
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    expect(await delegationOf("r-mine")).toBe(again.delegation.id);
    expect(await delegationOf("r-other")).toBe(other.delegation.id);
  });
});

describe("setDelegationRunBounds — adjust the bounds, touch NOTHING else", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  /**
   * Every column this update must leave byte-identical, read straight off
   * the row rather than re-listed here — so a NEW column added to the
   * table is covered the day it lands, instead of the day somebody
   * remembers to extend a hard-coded list.
   *
   * `updated_at` always moves; `moved` names the bound(s) the call under
   * test was allowed to write. Everything else must survive.
   *
   * Returns the verdict; the caller asserts. A helper that asserted
   * internally would read as an assertion-free test to `Gate integrity`
   * and, worse, would let a caller "pass" by never reaching it.
   */
  function frozenFields(
    row: Record<string, unknown>,
    moved: readonly string[] = [],
  ): Record<string, unknown> {
    const rest = { ...row };
    for (const key of ["updatedAt", ...moved]) delete rest[key];
    return rest;
  }

  test("the token cap moves and every other column is byte-identical", async () => {
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = created.delegation;

    const updated = await setDelegationRunBounds(before.id, { maxTokensPerRun: 99_000 });
    expect(updated?.maxTokensPerRun).toBe(99_000);

    // THE proof that this cannot change the workflow, the owner kind or
    // the consent hash — not a comment saying so, and not a list of the
    // three fields anyone happened to think of. Everything but the cap
    // and the timestamp is compared as one object.
    expect(
      frozenFields(updated as unknown as Record<string, unknown>, ["maxTokensPerRun"]),
    ).toEqual(frozenFields(before as unknown as Record<string, unknown>, ["maxTokensPerRun"]));
    // Named individually as well, because the three the brief singles out
    // are the ones a future refactor is most likely to "helpfully" widen
    // this function to accept, and a failure should say which broke.
    expect(updated?.workflowName).toBe(before.workflowName);
    expect(updated?.ownerKind).toBe(before.ownerKind);
    expect(updated?.consentHash).toBe(before.consentHash);
    expect(updated?.consentedByUserId).toBe(before.consentedByUserId);
    expect(updated?.consentedAt).toEqual(before.consentedAt);
    // A tokens-only patch leaves the OTHER bound alone — the branch that
    // would break if the builder spread the argument wholesale.
    expect(updated?.maxRunsPerDay).toBe(before.maxRunsPerDay);
    expect(updated?.capabilitySet).toEqual(before.capabilitySet);
  });

  test("the DAILY RUN quota moves on its own, and the token cap does not", async () => {
    // D8's throttle. Before this it was a 400 on the route and a full
    // re-consent was the only way to change it — which tombstoned the row
    // and re-asked for approval of a capability set that had not moved.
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = created.delegation;

    const updated = await setDelegationRunBounds(before.id, { maxRunsPerDay: 96 });
    expect(updated?.maxRunsPerDay).toBe(96);
    expect(updated?.maxTokensPerRun).toBe(before.maxTokensPerRun);
    expect(frozenFields(updated as unknown as Record<string, unknown>, ["maxRunsPerDay"])).toEqual(
      frozenFields(before as unknown as Record<string, unknown>, ["maxRunsPerDay"]),
    );
  });

  test("BOTH at once is one write, and still touches nothing else", async () => {
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = created.delegation;

    const updated = await setDelegationRunBounds(before.id, {
      maxTokensPerRun: 7,
      maxRunsPerDay: 3,
    });
    expect(updated?.maxTokensPerRun).toBe(7);
    expect(updated?.maxRunsPerDay).toBe(3);
    expect(updated?.consentHash).toBe(before.consentHash);
    // `consented_at` is NOT re-stamped: it records when a human last looked
    // at the material, and moving it would make a grant nobody re-read look
    // freshly reviewed.
    expect(updated?.consentedAt).toEqual(before.consentedAt);
    expect(
      frozenFields(updated as unknown as Record<string, unknown>, [
        "maxTokensPerRun",
        "maxRunsPerDay",
      ]),
    ).toEqual(
      frozenFields(before as unknown as Record<string, unknown>, [
        "maxTokensPerRun",
        "maxRunsPerDay",
      ]),
    );
  });

  test("it does NOT supersede: the same row id, and still the live one", async () => {
    // The whole difference from re-consent. A supersede would tombstone
    // this id and mint another, which is precisely what left every parked
    // run stranded.
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await setDelegationRunBounds(created.delegation.id, { maxTokensPerRun: 42 });
    expect(updated?.id).toBe(created.delegation.id);
    expect(updated?.revokedAt).toBeNull();
    expect((await findLiveWorkflowDelegation(EXT, "job-1"))?.id).toBe(created.delegation.id);
    expect((await findLiveWorkflowDelegation(EXT, "job-1"))?.maxTokensPerRun).toBe(42);
  });

  test("LOWERING is allowed too — the boundary check re-reads it every time", async () => {
    // Not merely symmetry. `enforceDelegatedTokenBudget` reads both
    // numbers out of the database at every boundary precisely so a
    // change takes effect on a run already in flight; a route that could
    // only raise would be a one-way ratchet on unattended spend.
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(
      (await setDelegationRunBounds(created.delegation.id, { maxTokensPerRun: 1 }))
        ?.maxTokensPerRun,
    ).toBe(1);
  });

  test("a REVOKED delegation is refused — a tombstone has no budget to adjust", async () => {
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await revokeWorkflowDelegation(created.delegation.id);

    expect(
      await setDelegationRunBounds(created.delegation.id, { maxTokensPerRun: 99_000 }),
    ).toBeUndefined();
    // …and the refusal wrote nothing.
    expect((await getWorkflowDelegation(created.delegation.id))?.maxTokensPerRun).toBe(5000);
  });

  test("a DISABLED delegation is refused, and its reason survives", async () => {
    // The decision, pinned: raising a token cap does not repair a
    // delegation the PLATFORM switched off, and clearing `enabled` here
    // would restore the answer-path authority `delegationHoldsAuthority`
    // withdrew — before any fire re-asks D7's question.
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await disableWorkflowDelegation(created.delegation.id, "the world moved")).toBe(true);

    expect(
      await setDelegationRunBounds(created.delegation.id, { maxTokensPerRun: 99_000 }),
    ).toBeUndefined();
    // The SECOND bound is refused by the same CAS. Adding a field to a
    // writer is exactly how a liveness filter gets bypassed for one arm.
    expect(
      await setDelegationRunBounds(created.delegation.id, { maxRunsPerDay: 96 }),
    ).toBeUndefined();
    const after = await getWorkflowDelegation(created.delegation.id);
    expect(after?.maxTokensPerRun).toBe(5000);
    expect(after?.maxRunsPerDay).toBe(24);
    expect(after?.enabled).toBe(false);
    expect(after?.disabledReason).toBe("the world moved");
  });

  test("an unknown id is undefined, not a throw", async () => {
    expect(
      await setDelegationRunBounds(crypto.randomUUID(), { maxTokensPerRun: 10 }),
    ).toBeUndefined();
  });
});

describe("toWorkflowDelegationView — one shape, three routes", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("the owner is read through the keyed lookup on BOTH arms", async () => {
    const mine = await createWorkflowDelegation(consentInput());
    const svc = await serviceAccount("svc-view");
    const theirs = await createWorkflowDelegation(
      consentInput({ jobRef: "job-2", ownerKind: "service", ownerId: svc }),
    );
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;

    expect(toWorkflowDelegationView(mine.delegation).ownerId).toBe(CONSENTER);
    expect(toWorkflowDelegationView(theirs.delegation).ownerId).toBe(svc);
  });

  test("the consent hash is NOT on the wire", async () => {
    // The view is explicit field copies rather than a row spread for
    // exactly this: `consent_hash` is the fingerprint a stale-consent
    // check compares, and a client that could read it could assert its
    // own freshness instead of being told.
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const view = toWorkflowDelegationView(created.delegation) as unknown as Record<string, unknown>;
    expect(Object.hasOwn(view, "consentHash")).toBe(false);
    // Same argument, same reason: the advisory graph digest is a value a
    // client could use to assert its own freshness.
    expect(Object.hasOwn(view, "definitionHash")).toBe(false);
    expect(Object.hasOwn(view, "consecutiveFailures")).toBe(false);
    // …and the fields the UI genuinely needs ARE there, so the assertion
    // above is not satisfied by an empty object.
    expect(view["maxTokensPerRun"]).toBe(5000);
    expect(view["workflowName"]).toBe("w");
    expect(view["enabled"]).toBe(true);
  });
});

describe("carryDelegationConsentForward — re-stamp a live consent, nothing else", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  const CARRIED = {
    consentHash: "semantic-2",
    definitionHash: "graph-2",
    capabilitySet: [{ kind: "agent", value: null }],
  };

  test("all three consent columns move, and NOTHING else does", async () => {
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = created.delegation;

    expect(await carryDelegationConsentForward(before.id, before.consentHash, CARRIED)).toBe(true);

    const after = await getWorkflowDelegation(before.id);
    expect(after?.consentHash).toBe("semantic-2");
    expect(after?.definitionHash).toBe("graph-2");
    // The narrowed set REPLACES the consented one. Leaving the wider set
    // behind would let the release that puts the capability back compare
    // against it, find nothing added, and re-grant with no human.
    expect(after?.capabilitySet).toEqual(CARRIED.capabilitySet);
    // `consented_at` is NOT re-stamped: `RESUME_RULES["consent-stale"]`
    // lets a parked run continue only once it is later than the run's
    // `started_at`, i.e. only once a HUMAN looked. A carry-forward is the
    // platform observing that nothing widened, so moving it would resume
    // runs nobody answered.
    expect(after?.consentedAt).toEqual(before.consentedAt);
    expect(after?.maxTokensPerRun).toBe(before.maxTokensPerRun);
    expect(after?.maxRunsPerDay).toBe(before.maxRunsPerDay);
    expect(after?.enabled).toBe(before.enabled);
    expect(after?.workflowName).toBe(before.workflowName);
  });

  test("the CAS is on the OLD hash — a concurrent re-consent is never clobbered", async () => {
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // A verdict taken against a row that has since been superseded.
    expect(
      await carryDelegationConsentForward(created.delegation.id, "some-older-hash", CARRIED),
    ).toBe(false);
    expect((await getWorkflowDelegation(created.delegation.id))?.consentHash).toBe("hash-1");
  });

  test("a REVOKED or DISABLED row is not re-stamped", async () => {
    // A tombstone holds no authority to refresh, and a row the platform
    // switched off is not healed by a release.
    const revoked = await createWorkflowDelegation(consentInput());
    const disabled = await createWorkflowDelegation(consentInput({ jobRef: "job-off" }));
    expect(revoked.ok && disabled.ok).toBe(true);
    if (!revoked.ok || !disabled.ok) return;
    await revokeWorkflowDelegation(revoked.delegation.id);
    await disableWorkflowDelegation(disabled.delegation.id, "stopped");

    expect(await carryDelegationConsentForward(revoked.delegation.id, "hash-1", CARRIED)).toBe(
      false,
    );
    expect(await carryDelegationConsentForward(disabled.delegation.id, "hash-1", CARRIED)).toBe(
      false,
    );
    expect((await getWorkflowDelegation(revoked.delegation.id))?.consentHash).toBe("hash-1");
    expect((await getWorkflowDelegation(disabled.delegation.id))?.definitionHash).toBe("def-1");
  });

  test("an unknown id is false, not a throw", async () => {
    expect(await carryDelegationConsentForward(crypto.randomUUID(), "hash-1", CARRIED)).toBe(false);
  });
});

describe("pinnedVersionIds — the version sweep actually honours a live delegation", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  async function seedVersions(): Promise<{ pinned: string; definitionId: string }> {
    const row = await createWorkflow({
      name: "w",
      description: "",
      steps: [{ name: "s1", agent: "writer", input: {} as Record<string, string> }],
    } as never);
    const { version } = await ensureWorkflowVersion(row, CONSENTER);
    return { pinned: version.id, definitionId: row.id };
  }

  test("no delegations means no pins", async () => {
    await seedVersions();
    expect(await listPinnedDelegationVersionIds()).toEqual([]);
  });

  test("a live delegation's version is pinned; a revoked one's is not", async () => {
    const { pinned } = await seedVersions();
    const created = await createWorkflowDelegation(consentInput({ definitionVersionId: pinned }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await listPinnedDelegationVersionIds()).toEqual([pinned]);

    await revokeWorkflowDelegation(created.delegation.id);
    expect(await listPinnedDelegationVersionIds()).toEqual([]);
  });

  test("a NULL pin (a YAML/extension workflow) contributes no id", async () => {
    await createWorkflowDelegation(consentInput({ definitionVersionId: null }));
    expect(await listPinnedDelegationVersionIds()).toEqual([]);
  });

  test("the sweep RETAINS a version a live delegation pins", async () => {
    // End-to-end through the real sweep, because the whole reason
    // `pinnedVersionIds` is a required argument is that forgetting it
    // degrades to a `warn` log line in a daemon that nothing observes.
    const { pinned, definitionId } = await seedVersions();
    await createWorkflowDelegation(consentInput({ definitionVersionId: pinned }));

    const result = await sweepWorkflowDefinitionVersions({
      keepUnreferencedPerDefinition: 0,
      pinnedVersionIds: await listPinnedDelegationVersionIds(),
    });
    expect(result.retained).toBeGreaterThan(0);
    expect((await listWorkflowVersions(definitionId)).map((v) => v.id)).toContain(pinned);
  });
});

/**
 * `listDelegatedRunsForConsenter` — the read behind "jobs running as me".
 *
 * It shipped with NO backend test at all: the only file naming it mocked it
 * (`web/src/__tests__/api-workflows-delegated-runs.server.test.ts`), so the
 * real SQL — an INNER JOIN through `delegation_id` to `consented_by_user_id`
 * — had never executed under test. The coverage gate caught it as
 * `src/db/queries/workflow-runs.ts: 96.17% < 100%` with the whole function
 * body missed. A mocked query proves the route calls something; it cannot
 * prove the something scopes correctly, and the scope IS the authorization
 * here.
 */
describe("listDelegatedRunsForConsenter — 'jobs running as me', scoped by CONSENTER", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  /** A `workflow_runs` row, optionally delegated and optionally back-dated. */
  async function run(
    id: string,
    delegationId: string | null,
    startedAt = new Date(),
    runAsKind: "user" | "service" = "user",
  ): Promise<void> {
    await getDb()
      .insert(workflowRuns)
      .values({
        id,
        workflowName: "w",
        status: "success",
        input: {},
        startedAt,
        delegationId,
        runAsKind,
        runAs: CONSENTER,
      } as never);
  }

  test("returns the runs of a delegation THIS human consented to", async () => {
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await run("run-1", created.delegation.id);

    const page = await listDelegatedRunsForConsenter(CONSENTER, { limit: 10 });
    expect(page.runs.map((r) => r.id)).toEqual(["run-1"]);
  });

  test("another user's delegation is INVISIBLE — the scope is the consenter", async () => {
    // The whole authorization property of the route that wraps this. Keyed
    // on `consented_by_user_id`, the same key `mayManageDelegation` uses, so
    // what a person can SEE is exactly what they can REVOKE.
    const mine = await createWorkflowDelegation(consentInput());
    const theirs = await createWorkflowDelegation(
      consentInput({ jobRef: "job-2", ownerId: OTHER, consentedByUserId: OTHER }),
    );
    expect(mine.ok).toBe(true);
    expect(theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;
    await run("run-mine", mine.delegation.id);
    await run("run-theirs", theirs.delegation.id);

    const page = await listDelegatedRunsForConsenter(CONSENTER, { limit: 10 });
    expect(page.runs.map((r) => r.id)).toEqual(["run-mine"]);
  });

  test("a SERVICE-owned run is listed too — the account owns it, the human answers for it", async () => {
    // Ruling 1. Scoping on `run_as` instead would hide every service job a
    // person authorized, and a service account has no session anywhere, so
    // those runs would become unreadable by anybody at all.
    const svc = await serviceAccount("svc-runs");
    const created = await createWorkflowDelegation(
      consentInput({ ownerKind: "service", ownerId: svc }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await run("run-svc", created.delegation.id, new Date(), "service");

    const page = await listDelegatedRunsForConsenter(CONSENTER, { limit: 10 });
    expect(page.runs.map((r) => r.id)).toEqual(["run-svc"]);
  });

  test("an UNDELEGATED run is excluded — the join is INNER, deliberately", async () => {
    // A run with no `delegation_id` is not a delegated run and has no
    // consenter to attribute it to. Correctly invisible.
    await run("run-plain", null);
    const page = await listDelegatedRunsForConsenter(CONSENTER, { limit: 10 });
    expect(page.runs).toEqual([]);
  });

  test("a REVOKED delegation still lists its runs — the history survives", async () => {
    // The page says "including ones you have since revoked". Revocation is
    // a tombstone, not a delete, so the join still finds the consenter.
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await run("run-revoked", created.delegation.id);
    await revokeWorkflowDelegation(created.delegation.id);

    const page = await listDelegatedRunsForConsenter(CONSENTER, { limit: 10 });
    expect(page.runs.map((r) => r.id)).toEqual(["run-revoked"]);
  });

  test("newest first, and the keyset cursor walks the rest", async () => {
    const created = await createWorkflowDelegation(consentInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await run("run-old", created.delegation.id, new Date("2026-01-01T00:00:00Z"));
    await run("run-mid", created.delegation.id, new Date("2026-02-01T00:00:00Z"));
    await run("run-new", created.delegation.id, new Date("2026-03-01T00:00:00Z"));

    const first = await listDelegatedRunsForConsenter(CONSENTER, { limit: 2 });
    expect(first.runs.map((r) => r.id)).toEqual(["run-new", "run-mid"]);
    // `limit + 1` is fetched so "is there another page?" costs no extra
    // query; the cursor is present precisely when there is one.
    expect(first.nextCursor).toBeDefined();
    if (first.nextCursor === undefined) return;

    const second = await listDelegatedRunsForConsenter(CONSENTER, {
      limit: 2,
      cursor: {
        startedAt: new Date(first.nextCursor.startedAt),
        id: first.nextCursor.id,
      },
    });
    expect(second.runs.map((r) => r.id)).toEqual(["run-old"]);
    expect(second.nextCursor).toBeUndefined();
  });
});

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
  createWorkflowDelegation,
  delegationOwnerId,
  findLiveWorkflowDelegation,
  getWorkflowDelegation,
  listPinnedDelegationVersionIds,
  listWorkflowDelegationsConsentedBy,
  revokeWorkflowDelegation,
} = await import("../db/queries/workflow-delegations");
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
    // and every parked delegated run is stuck forever. There is no update
    // route on a delegation, so the ONLY way to raise `max_tokens_per_run`
    // or refresh a stale consent is to re-consent — which is this
    // function, which tombstones. Both `RESUME_RULES` predicates read the
    // RUN's own `delegation_id` and refuse a revoked row, so the remedies
    // their own prose names ("only raising that cap lets it continue",
    // "only a fresh consent lets it continue") were unreachable.
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
    const created = await createWorkflowDelegation(
      consentInput({ definitionVersionId: pinned }),
    );
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

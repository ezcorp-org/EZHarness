/**
 * R2-c's other two thirds: the approvals inbox DISJUNCT and the capacity
 * resolver that decides which {@link ApprovalActor} a surface mints.
 *
 * ## Why these live together
 *
 * A service account has no `users` row, so a run it owns writes
 * `workflow_runs.user_id = NULL` (`db/schema.ts:538`). Before C3 that meant
 * the run's approvals were admin-only AND invisible, and the two halves are
 * inseparable: granting `answerApproval` the `delegation` actor kind
 * without widening the inbox produces an authority that exists and can
 * never be exercised, which amended spec §6.3 calls out as WORSE than
 * admin-only "because it looks fixed". Widening the inbox without the
 * resolver produces the same failure one layer down — a row a surface
 * lists and its own button cannot answer.
 *
 * So the acceptance criterion is asserted end to end: a service-account
 * run's approval appears in the consenting user's inbox, in nobody else's,
 * and the actor that user's surface mints for it is the one the chokepoint
 * accepts.
 *
 * Real PGlite and the real `migrate()`, because every claim here is about
 * a SQL predicate — a mocked query layer would be asserting the fixture.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { mock } from "bun:test";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

mock.module("../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const {
  listPendingWorkflowApprovalsForUser,
  findDelegatedAnswerAuthority,
  parkWorkflowApproval,
} = await import("../db/queries/workflow-approvals");
const { findDelegationHoldingAuthority, delegationHoldsAuthority } = await import(
  "../db/queries/workflow-delegations"
);
const { resolveApprovalActor } = await import("../runtime/workflow-approval-actor");
const { insertWorkflowRun } = await import("../db/queries/workflow-runs");

/** The consenting human, the bystander, and the admin who created the account. */
const CONSENTER = "consenter";
const BYSTANDER = "bystander";
const ADMIN = "admin-user";

let serviceAccountId: string;
let extensionId: string;

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name) VALUES
      (${CONSENTER}, 'c@example.test', 'x', 'Consenter'),
      (${BYSTANDER}, 'b@example.test', 'x', 'Bystander'),
      (${ADMIN}, 'a@example.test', 'x', 'Admin')
  `);
  extensionId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO extensions (id, name, version, manifest, source)
    VALUES (${extensionId}, 'nightly', '1.0.0', '{}'::jsonb, 'test')
  `);
  serviceAccountId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO service_accounts (id, name, created_by_user_id, max_tokens_per_day)
    VALUES (${serviceAccountId}, 'nightly-bot', ${ADMIN}, 1000000)
  `);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

/**
 * A parked approval on a run, optionally started by a delegation.
 *
 * `ownerUserId: null` is the shape this whole file is about — a
 * `owner_kind='service'` run, which genuinely has no human owner.
 */
async function seedRun(
  opts: {
    ownerUserId?: string | null;
    consentedBy?: string;
    ownerKind?: "user" | "service";
    delegated?: boolean;
    revoked?: boolean;
    enabled?: boolean;
  } = {},
): Promise<{ runId: string; approvalId: string; delegationId: string | null }> {
  const runId = crypto.randomUUID();
  await insertWorkflowRun({
    id: runId,
    workflowName: "nightly-report",
    input: {},
    startedAt: new Date(),
    userId: opts.ownerUserId ?? null,
  });
  await db.execute(sql`UPDATE workflow_runs SET status = 'suspended' WHERE id = ${runId}`);

  let delegationId: string | null = null;
  if (opts.delegated !== false) {
    delegationId = crypto.randomUUID();
    const ownerKind = opts.ownerKind ?? "service";
    await db.execute(sql`
      INSERT INTO workflow_delegations (
        id, extension_id, job_ref, owner_kind, owner_user_id,
        owner_service_account_id, workflow_name, trigger_kind, consent_hash,
        max_tokens_per_run, max_runs_per_day, consented_by_user_id,
        enabled, revoked_at
      ) VALUES (
        ${delegationId}, ${extensionId}, ${`job-${delegationId.slice(0, 8)}`},
        ${ownerKind},
        ${ownerKind === "user" ? (opts.ownerUserId ?? CONSENTER) : null},
        ${ownerKind === "service" ? serviceAccountId : null},
        'nightly-report', 'cron', 'hash-v1', 100000, 10,
        ${opts.consentedBy ?? CONSENTER}, ${opts.enabled ?? true},
        ${opts.revoked === true ? new Date() : null}
      )
    `);
    await db.execute(
      sql`UPDATE workflow_runs SET delegation_id = ${delegationId} WHERE id = ${runId}`,
    );
  }

  const approvalId = await parkWorkflowApproval({
    workflowRunId: runId,
    stepName: "gate",
    prompt: "Send the report?",
    choices: ["approve", "reject"],
    requireItemConsent: false,
    itemIds: [],
  });
  return { runId, approvalId, delegationId };
}

/** The approval ids one user's inbox returns. */
async function inbox(userId: string, isAdmin = false): Promise<string[]> {
  const rows = await listPendingWorkflowApprovalsForUser(userId, isAdmin);
  return rows.map((r) => r.approval.id);
}

describe("the approvals inbox — the delegated disjunct (R2-c, change 3)", () => {
  test("a service-account run's approval appears in the CONSENTING user's inbox, and in NOBODY else's", async () => {
    // The acceptance criterion, both halves in one test because either
    // half alone is satisfiable by a trivially wrong query: showing it to
    // everyone passes the first, showing it to no one passes the second.
    const { approvalId } = await seedRun({ ownerUserId: null });

    expect(await inbox(CONSENTER)).toContain(approvalId);
    expect(await inbox(BYSTANDER)).not.toContain(approvalId);
  });

  test("…and an ADMIN still sees it, which is what keeps the admin view and the sweep's view the same set", async () => {
    const { approvalId } = await seedRun({ ownerUserId: null });
    expect(await inbox(BYSTANDER, true)).toContain(approvalId);
  });

  test("a REVOKED delegation takes the row back out of the consenter's inbox", async () => {
    // Revocation ends the authority, so it must also end the visibility —
    // a row the inbox shows that `answerApproval` then refuses is the
    // "looks fixed" failure the shared liveness predicate exists to
    // prevent.
    const { approvalId } = await seedRun({ ownerUserId: null, revoked: true });
    expect(await inbox(CONSENTER)).not.toContain(approvalId);
  });

  test("a DISABLED delegation takes the row out too — the same predicate, both terms", async () => {
    const { approvalId } = await seedRun({ ownerUserId: null, enabled: false });
    expect(await inbox(CONSENTER)).not.toContain(approvalId);
  });

  test("a delegation consented by SOMEONE ELSE is invisible to a bystander who merely knows of it", async () => {
    const { approvalId } = await seedRun({ ownerUserId: null, consentedBy: BYSTANDER });
    expect(await inbox(CONSENTER)).not.toContain(approvalId);
    expect(await inbox(BYSTANDER)).toContain(approvalId);
  });

  test("the ORDINARY owner arm is untouched — an undelegated run still reaches only its owner", async () => {
    // The regression half. A disjunct written as `OR` over a LEFT JOIN is
    // one mistake away from matching every row with a NULL delegation.
    const { approvalId } = await seedRun({ ownerUserId: BYSTANDER, delegated: false });
    expect(await inbox(BYSTANDER)).toContain(approvalId);
    expect(await inbox(CONSENTER)).not.toContain(approvalId);
  });

  test("an unowned, UNDELEGATED run is still admin-only — 'unowned' never became 'anyone's'", async () => {
    // The pre-C3 rule, restated because the disjunct is exactly the change
    // that could have relaxed it by accident.
    const { approvalId } = await seedRun({ ownerUserId: null, delegated: false });
    expect(await inbox(CONSENTER)).not.toContain(approvalId);
    expect(await inbox(BYSTANDER)).not.toContain(approvalId);
    expect(await inbox(BYSTANDER, true)).toContain(approvalId);
  });

  test("the LEFT JOIN does not duplicate a row the caller reaches BOTH ways", async () => {
    // A run whose delegation names its own owner as consenter satisfies
    // both arms of the disjunction. An inner join, or a join that could
    // fan out, would render the same parked decision twice.
    const { approvalId } = await seedRun({ ownerUserId: CONSENTER, ownerKind: "user" });
    const seen = (await inbox(CONSENTER)).filter((id) => id === approvalId);
    expect(seen).toEqual([approvalId]);
  });
});

describe("findDelegatedAnswerAuthority — the capacity lookup", () => {
  test("returns the delegation and run for the consenting human on an unowned run", async () => {
    const { approvalId, runId, delegationId } = await seedRun({ ownerUserId: null });
    expect(await findDelegatedAnswerAuthority(approvalId, CONSENTER)).toEqual({
      delegationId: delegationId!,
      runId,
    });
  });

  test("returns nothing for anybody the delegation does not name", async () => {
    const { approvalId } = await seedRun({ ownerUserId: null });
    expect(await findDelegatedAnswerAuthority(approvalId, BYSTANDER)).toBeUndefined();
  });

  test("returns nothing once the delegation is revoked, and nothing once it is disabled", async () => {
    const revoked = await seedRun({ ownerUserId: null, revoked: true });
    const disabled = await seedRun({ ownerUserId: null, enabled: false });
    expect(await findDelegatedAnswerAuthority(revoked.approvalId, CONSENTER)).toBeUndefined();
    expect(await findDelegatedAnswerAuthority(disabled.approvalId, CONSENTER)).toBeUndefined();
  });

  test("returns nothing for a run the caller ALREADY OWNS — the capacity widens reach, never narrows it", async () => {
    // A `delegation` actor satisfies no `rbacScope`, so minting one for
    // somebody the run itself names would take away an answer they could
    // otherwise give. `IS DISTINCT FROM`, spelled in two SQL terms because
    // the NULL case is the one that matters.
    const { approvalId } = await seedRun({ ownerUserId: CONSENTER, ownerKind: "user" });
    expect(await findDelegatedAnswerAuthority(approvalId, CONSENTER)).toBeUndefined();
  });

  test("returns nothing for an approval that does not exist", async () => {
    expect(await findDelegatedAnswerAuthority(crypto.randomUUID(), CONSENTER)).toBeUndefined();
  });
});

describe("resolveApprovalActor — which actor a human surface mints", () => {
  test("a non-admin consenter on a service-account run is minted a DELEGATION actor", async () => {
    const { approvalId, runId, delegationId } = await seedRun({ ownerUserId: null });
    expect(
      await resolveApprovalActor(approvalId, { userId: CONSENTER, isAdmin: false }),
    ).toEqual({
      kind: "delegation",
      delegationId: delegationId!,
      runId,
      answeringUserId: CONSENTER,
    });
  });

  test("an ADMIN is always minted a USER actor, even when they are the consenter", async () => {
    // Admins reach every run already, and the delegated capacity is
    // strictly narrower — it satisfies no `rbacScope`. Minting it for an
    // admin would take an answer away.
    const { approvalId } = await seedRun({ ownerUserId: null, consentedBy: ADMIN });
    expect(await resolveApprovalActor(approvalId, { userId: ADMIN, isAdmin: true })).toEqual({
      kind: "user",
      userId: ADMIN,
      isAdmin: true,
    });
  });

  test("everyone else is minted a USER actor — the default is answering as yourself", async () => {
    const { approvalId } = await seedRun({ ownerUserId: BYSTANDER, delegated: false });
    expect(
      await resolveApprovalActor(approvalId, { userId: BYSTANDER, isAdmin: false }),
    ).toEqual({ kind: "user", userId: BYSTANDER, isAdmin: false });
  });
});

describe("delegationHoldsAuthority — one predicate, and it is really shared", () => {
  test("finds a live row by id and refuses a revoked or disabled one", async () => {
    const live = await seedRun({ ownerUserId: null });
    const revoked = await seedRun({ ownerUserId: null, revoked: true });
    const disabled = await seedRun({ ownerUserId: null, enabled: false });

    expect((await findDelegationHoldingAuthority(live.delegationId!))?.id).toBe(
      live.delegationId,
    );
    expect(await findDelegationHoldingAuthority(revoked.delegationId!)).toBeUndefined();
    expect(await findDelegationHoldingAuthority(disabled.delegationId!)).toBeUndefined();
  });

  test("the predicate is a real SQL fragment, not an accidental undefined", async () => {
    // `and(...)` returns `undefined` when handed nothing, and a
    // `.where(undefined)` matches EVERY row — so a refactor that emptied
    // this predicate would silently turn both call sites into "any
    // delegation, revoked or not" while every test above still passed on
    // the rows it happens to seed.
    expect(delegationHoldsAuthority()).toBeDefined();
  });
});

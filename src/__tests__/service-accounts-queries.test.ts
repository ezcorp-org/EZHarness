/**
 * C3 phase 2 — the `service_accounts` query layer.
 *
 * Three properties here are security properties rather than CRUD coverage,
 * and each is asserted against the thing it actually depends on:
 *
 *  1. **The scope clamp is structural.** `createServiceAccount` resolves the
 *     creator's scopes ITSELF, so a caller cannot mint a principal broader
 *     than themselves by forgetting to clamp. Proved with a REAL non-admin
 *     creator holding a REAL grant row, not with a stubbed scope set — a stub
 *     would pass even if the clamp read the request instead of the grants.
 *
 *  2. **The reach warning is DERIVED from the ladder.** `serviceAccountReach`
 *     runs the real `authorizeWorkflow`; the test asserts the answer AND that
 *     the answer is reached through the ladder, by checking the same three
 *     tiers directly. A hard-coded `["system"]` would agree today and stop
 *     agreeing silently the day the ladder moves.
 *
 *  3. **Owner-kind resolution is keyed, in BOTH maps.** The key sets of
 *     `DELEGATION_OWNER_COLUMN` (schema) and `DELEGATION_OWNER_CALLER` (here)
 *     must match, so adding a third principal kind to one and not the other
 *     fails loudly instead of resolving to `undefined` at runtime.
 *
 * DB-backed: run with `--timeout 30000` (a `beforeEach` that restores the
 * migrated snapshot exceeds bun's 5s default and reports a bare 0 pass/1 fail).
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  ALL_VISIBILITIES,
  DELEGATION_OWNER_CALLER,
  SERVICE_ACCOUNT_CALLER,
  SERVICE_ACCOUNT_REACH_CODE,
  SERVICE_ACCOUNT_AUDIT_ACTIONS,
  InvalidServiceAccountError,
  clampScopesToCreator,
  countLiveDelegationsOwnedBy,
  createServiceAccount,
  deleteServiceAccount,
  findLiveServiceAccount,
  getServiceAccount,
  getServiceAccountByName,
  listServiceAccounts,
  serviceAccountReach,
  setServiceAccountDailyTokenCap,
  setServiceAccountEnabled,
  toServiceAccountChoice,
  toServiceAccountView,
} = await import("../db/queries/service-accounts");

const { DELEGATION_OWNER_COLUMN, serviceAccounts } = await import("../db/schema");
type DelegationOwnerKind = keyof typeof DELEGATION_OWNER_COLUMN;
// The ENFORCING side of the principal question — imported so the map above
// can be compared against it rather than against a copy of its answers.
const { delegationPrincipal } = await import("../runtime/workflow-delegation-consent");
const { authorizeWorkflow, systemCachedWorkflow } = await import("../runtime/workflow-scope");
const { RBAC_ALL_SCOPES } = await import("../auth/extension-rbac");

const ADMIN = { id: "u-admin", role: "admin" as const };
const MEMBER = { id: "u-member", role: "member" as const };

/** Two humans, a project and an extension — one live instance of every FK
 *  target `service_accounts` and `workflow_delegations` reach. */
async function seed() {
  const db = getTestDb();
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name, role, status) VALUES
      ('u-admin',  'admin@x.test',  'h', 'Admin',  'admin',  'active'),
      ('u-member', 'member@x.test', 'h', 'Member', 'member', 'active')
  `);
  await db.execute(sql`INSERT INTO projects (id, name, path) VALUES ('p-1', 'Proj', '/tmp/p')`);
  await db.execute(sql`
    INSERT INTO extensions (id, name, version, manifest, source)
    VALUES ('e-1', 'ext-one', '1.0.0', '{}'::jsonb, 'local')
  `);
}

/** A live delegation row owned by `kind`/`ownerId`. Raw SQL: delegation CRUD
 *  is another phase's module and this suite must not depend on it. */
async function insertDelegation(opts: {
  id: string;
  kind: "user" | "service";
  ownerId: string;
  jobRef: string;
  revoked?: boolean;
}) {
  const userCol = opts.kind === "user" ? opts.ownerId : null;
  const svcCol = opts.kind === "service" ? opts.ownerId : null;
  await getTestDb().execute(sql`
    INSERT INTO workflow_delegations
      (id, extension_id, job_ref, owner_kind, owner_user_id, owner_service_account_id,
       workflow_name, trigger_kind, consent_hash, capability_set,
       max_tokens_per_run, max_runs_per_day, consented_by_user_id, revoked_at)
    VALUES
      (${opts.id}, 'e-1', ${opts.jobRef}, ${opts.kind}, ${userCol}, ${svcCol},
       'wf', 'cron', 'hash', '[]'::jsonb, 1000, 5, 'u-admin',
       ${opts.revoked ? new Date().toISOString() : null})
  `);
}

async function mint(overrides: Partial<Parameters<typeof createServiceAccount>[0]> = {}) {
  return createServiceAccount({
    name: "runner",
    createdBy: ADMIN,
    maxTokensPerDay: 10_000,
    ...overrides,
  });
}

describe("service-accounts query layer", () => {
  beforeEach(async () => {
    await setupTestDb();
    await seed();
  });
  afterAll(async () => await closeTestDb());

  // ── owner-kind resolution ────────────────────────────────────────────

  describe("owner-kind is resolved by KEYED LOOKUP", () => {
    test("the two keyed maps carry identical key sets", () => {
      // The whole point of keying rather than switching: a third principal
      // kind must be additive in BOTH maps. Extending one and not the other
      // resolves to `undefined` at runtime; this fails at test time instead.
      expect(Object.keys(DELEGATION_OWNER_CALLER).sort()).toEqual(
        Object.keys(DELEGATION_OWNER_COLUMN).sort(),
      );
      expect(Object.keys(DELEGATION_OWNER_CALLER).length).toBeGreaterThan(1);
    });

    test("`user` carries the owner's user id; `service` carries no identity", () => {
      expect(DELEGATION_OWNER_CALLER.user("u-member")).toEqual({
        userId: "u-member",
        role: "member",
      });
      // The `service` arm IGNORES the id — there is no `users` row to name.
      expect(DELEGATION_OWNER_CALLER.service("sa-1")).toEqual(SERVICE_ACCOUNT_CALLER);
      expect(SERVICE_ACCOUNT_CALLER.userId).toBeNull();
      // …and NOT admin: an admin created it, the account is not one.
      expect(SERVICE_ACCOUNT_CALLER.role).toBe("member");
    });

    test("the ADVERTISED principal is the one the consent gate ENFORCES with", () => {
      // C3 composition hazard: this module derives the admin-facing reach
      // warning from `DELEGATION_OWNER_CALLER`, while `authorizeDelegationConsent`
      // refuses with `delegationPrincipal`. Two hand-written maps over the same
      // union would agree today and diverge silently — and the direction that
      // fails is an admin shown one reach while the gate enforces another.
      // Pinned arm-for-arm over EVERY kind the discriminator has, so a third
      // kind is covered the moment it exists.
      for (const kind of Object.keys(DELEGATION_OWNER_COLUMN) as DelegationOwnerKind[]) {
        expect(DELEGATION_OWNER_CALLER[kind]("owner-xyz")).toEqual(
          delegationPrincipal(kind, "owner-xyz"),
        );
      }
      // …and the constant the reach probe actually runs is the same object
      // shape, not a parallel literal.
      expect(SERVICE_ACCOUNT_CALLER).toEqual(delegationPrincipal("service", null));
    });

    test("the column map is what `countLiveDelegationsOwnedBy` indexes", async () => {
      const account = (await mint()).account;
      await insertDelegation({ id: "d-svc", kind: "service", ownerId: account.id, jobRef: "j1" });
      await insertDelegation({ id: "d-usr", kind: "user", ownerId: "u-member", jobRef: "j2" });

      // Each kind reads its OWN column: the service count must not see the
      // user-kind row and vice versa.
      expect(await countLiveDelegationsOwnedBy({ kind: "service", id: account.id })).toBe(1);
      expect(await countLiveDelegationsOwnedBy({ kind: "user", id: "u-member" })).toBe(1);
      expect(await countLiveDelegationsOwnedBy({ kind: "user", id: account.id })).toBe(0);
      expect(await countLiveDelegationsOwnedBy({ kind: "service", id: "u-member" })).toBe(0);
    });

    test("a REVOKED delegation carries no authority and is not counted", async () => {
      const account = (await mint()).account;
      await insertDelegation({
        id: "d-dead",
        kind: "service",
        ownerId: account.id,
        jobRef: "j3",
        revoked: true,
      });
      expect(await countLiveDelegationsOwnedBy({ kind: "service", id: account.id })).toBe(0);
    });
  });

  // ── the reach warning ────────────────────────────────────────────────

  describe("reach warning (spec §6.5)", () => {
    test("a service account runs `system` and nothing else", () => {
      const reach = serviceAccountReach();
      expect(reach.runnableVisibilities).toEqual(["system"]);
      expect(reach.code).toBe(SERVICE_ACCOUNT_REACH_CODE);
      expect(reach.message).toContain("system");
      // The fork case, named — it is C3's headline use case and the one an
      // admin will actually hit.
      expect(reach.message).toContain("fork");
    });

    test("that answer comes from the LADDER, tier by tier", () => {
      // Same question asked directly of `authorizeWorkflow`. If these two ever
      // disagree, `serviceAccountReach` has stopped deriving and started
      // asserting.
      const probe = (visibility: "system" | "project" | "private") => ({
        ...systemCachedWorkflow(
          { name: "p", steps: [] } as never,
          "yaml",
        ),
        visibility,
      });
      expect(authorizeWorkflow(probe("system"), SERVICE_ACCOUNT_CALLER, "run").ok).toBe(true);
      expect(authorizeWorkflow(probe("project"), SERVICE_ACCOUNT_CALLER, "run").ok).toBe(false);
      expect(authorizeWorkflow(probe("private"), SERVICE_ACCOUNT_CALLER, "run").ok).toBe(false);
      expect(serviceAccountReach().runnableVisibilities).toEqual(
        (["system", "project", "private"] as const).filter(
          (v) => authorizeWorkflow(probe(v), SERVICE_ACCOUNT_CALLER, "run").ok,
        ),
      );
    });

    test("every tier the TYPE admits is actually probed", () => {
      // `satisfies readonly WorkflowVisibility[]` checks each entry is a valid
      // tier; it does NOT check that every tier is an entry. A fourth
      // visibility would compile and silently never be probed, so the reach
      // answer would be right about three tiers and blind to the fourth.
      // Parsed from the union's own declaration — the only independent source.
      const types = readFileSync(join(import.meta.dir, "../types.ts"), "utf8");
      const decl = /export type WorkflowVisibility =([^;]+);/.exec(types);
      expect(decl).not.toBeNull();
      const admitted = [...decl![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      expect(admitted.length).toBeGreaterThan(0);
      expect(admitted).toEqual([...ALL_VISIBILITIES]);
    });

    test("the warning ships on the CREATE result, not only on the consent path", async () => {
      const created = await mint({ name: "warned" });
      expect(created.reach.code).toBe(SERVICE_ACCOUNT_REACH_CODE);
      expect(created.reach.runnableVisibilities).toEqual(["system"]);
    });
  });

  // ── the scope clamp ──────────────────────────────────────────────────

  describe("scopes are clamped to the creating admin", () => {
    test("clampScopesToCreator keeps only what the creator holds", () => {
      const held = new Set(["use", "configure"]);
      expect(clampScopesToCreator(["use", "manage", "configure"], held)).toEqual([
        "use",
        "configure",
      ]);
      expect(clampScopesToCreator([], held)).toEqual([]);
      // The admin sentinel's `has()` is always true, so nothing is dropped.
      expect(clampScopesToCreator(["use", "manage"], RBAC_ALL_SCOPES)).toEqual(["use", "manage"]);
    });

    test("an admin creator drops nothing (the all-scopes sentinel)", async () => {
      const created = await mint({ scopes: ["use", "manage"] });
      expect(created.account.scopes).toEqual(["use", "manage"]);
      expect(created.droppedScopes).toEqual([]);
    });

    test("a NON-admin creator cannot mint a principal broader than itself", async () => {
      // A real grant row, resolved by the real RBAC resolver. The member holds
      // `use` at the covers-all coordinates and nothing else.
      await getTestDb().execute(sql`
        INSERT INTO extension_rbac_grants (id, user_id, project_id, extension_id, scopes)
        VALUES ('g-1', 'u-member', NULL, NULL, '["use"]'::jsonb)
      `);
      const created = await createServiceAccount({
        name: "narrow",
        createdBy: MEMBER,
        scopes: ["use", "manage", "secrets"],
        maxTokensPerDay: 500,
      });
      expect(created.account.scopes).toEqual(["use"]);
      expect(created.droppedScopes).toEqual(["manage", "secrets"]);
    });

    test("a creator with NO grants mints an account with no scopes", async () => {
      const created = await createServiceAccount({
        name: "bare",
        createdBy: MEMBER,
        scopes: ["use"],
        maxTokensPerDay: 500,
      });
      expect(created.account.scopes).toEqual([]);
      expect(created.droppedScopes).toEqual(["use"]);
    });

    test("duplicate requested scopes are collapsed before the clamp", async () => {
      const created = await mint({ name: "dupes", scopes: ["use", "use", "configure"] });
      expect(created.account.scopes).toEqual(["use", "configure"]);
    });
  });

  // ── mint-time validation ─────────────────────────────────────────────

  describe("createServiceAccount input rules", () => {
    test("stores the row with its defaults and trims the name", async () => {
      const created = await mint({ name: "  spaced  ", description: "nightly jobs" });
      expect(created.account.name).toBe("spaced");
      expect(created.account.description).toBe("nightly jobs");
      expect(created.account.createdByUserId).toBe("u-admin");
      expect(created.account.projectId).toBeNull();
      expect(created.account.enabled).toBe(true);
      expect(created.account.disabledReason).toBeNull();
      expect(created.account.maxTokensPerDay).toBe(10_000);
      expect(created.account.scopes).toEqual([]);
      expect(created.account.description).not.toBeUndefined();
    });

    test("accepts a project-scoped account", async () => {
      const created = await mint({ name: "scoped", projectId: "p-1" });
      expect(created.account.projectId).toBe("p-1");
    });

    test("an empty name is refused", async () => {
      const err = await mint({ name: "   " }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidServiceAccountError);
      expect((err as Error).message).toContain("name is required");
    });

    test.each([
      ["zero", 0],
      ["negative", -1],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
    ])("maxTokensPerDay must be a positive integer (%s)", async (_label, value) => {
      const err = await mint({ maxTokensPerDay: value as number }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidServiceAccountError);
      expect((err as Error).message).toContain("maxTokensPerDay");
    });

    test("an ungrammatical scope name is refused, not silently clamped away", async () => {
      const err = await mint({ scopes: ["NOT A SCOPE"] }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidServiceAccountError);
      expect((err as Error).message).toContain("invalid scope name");
    });

    test("the name is globally unique", async () => {
      await mint({ name: "twice" });
      const err = await mint({ name: "twice" }).catch((e) => e);
      // Surfaced by the DB's unique index, not by a read-then-write race.
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(InvalidServiceAccountError);
    });
  });

  // ── reads ────────────────────────────────────────────────────────────

  describe("reads", () => {
    test("by id and by name; both miss cleanly", async () => {
      const created = (await mint({ name: "findme" })).account;
      expect((await getServiceAccount(created.id))?.name).toBe("findme");
      expect((await getServiceAccountByName("findme"))?.id).toBe(created.id);
      expect(await getServiceAccount("nope")).toBeUndefined();
      expect(await getServiceAccountByName("nope")).toBeUndefined();
    });

    // The liveness read the delegation consent gate calls before it writes
    // an `owner_service_account_id`. It lives here — with the module that
    // owns `service_accounts` — rather than beside delegation CRUD, so
    // there is exactly one predicate for "is this account still a usable
    // principal" instead of two that can drift.
    test("findLiveServiceAccount returns an ENABLED account", async () => {
      const created = (await mint({ name: "live-one" })).account;
      expect((await findLiveServiceAccount(created.id))?.id).toBe(created.id);
    });

    test("findLiveServiceAccount refuses a DISABLED account the FK would have accepted", async () => {
      const created = (await mint({ name: "off-one" })).account;
      await setServiceAccountEnabled(created.id, false, "switched off");
      // `getServiceAccount` still returns it — the row exists and is
      // history. The consent gate's read must not, which is the whole
      // reason the two are different functions.
      expect((await getServiceAccount(created.id))?.enabled).toBe(false);
      expect(await findLiveServiceAccount(created.id)).toBeUndefined();
    });

    test("findLiveServiceAccount misses an unknown id rather than throwing at insert time", async () => {
      expect(await findLiveServiceAccount(crypto.randomUUID())).toBeUndefined();
    });

    test("listing is unfiltered by default and project-filtered on request", async () => {
      await mint({ name: "global-one" });
      await mint({ name: "proj-one", projectId: "p-1" });
      expect((await listServiceAccounts()).map((r) => r.name).sort()).toEqual([
        "global-one",
        "proj-one",
      ]);
      // A NULL-project account is instance-wide and is deliberately NOT folded
      // into a project's list.
      expect((await listServiceAccounts("p-1")).map((r) => r.name)).toEqual(["proj-one"]);
      expect(await listServiceAccounts("p-missing")).toEqual([]);
    });

    test("the wire view copies fields explicitly and adds none", async () => {
      const row = (await mint({ name: "viewed", scopes: ["use"] })).account;
      const view = toServiceAccountView(row);
      expect(Object.keys(view).sort()).toEqual([
        "createdAt",
        "createdByUserId",
        "description",
        "disabledReason",
        "enabled",
        "id",
        "maxTokensPerDay",
        "name",
        "projectId",
        "scopes",
        "updatedAt",
      ]);
      expect(view.id).toBe(row.id);
      expect(view.scopes).toEqual(["use"]);
    });

    test("the NARROW view is exactly {id, name} — every other column withheld", async () => {
      // The pin that matters for the widened read. `GET /api/service-accounts`
      // answers any authenticated session with this shape, so a field added
      // here reaches every logged-in user. Asserted as the EXACT key set, not
      // as "does not contain scopes": a spot check passes for whatever the
      // author happened to think of, and the failure mode of this projection
      // is the field nobody thought of.
      const row = (await mint({ name: "narrow", scopes: ["use"], projectId: "p-1" })).account;
      const choice = toServiceAccountChoice(row);
      expect(Object.keys(choice).sort()).toEqual(["id", "name"]);
      expect(choice.id).toBe(row.id);
      expect(choice.name).toBe("narrow");
    });

    test("the narrow view is a STRICT subset of the admin view's keys", async () => {
      // Two projections of one row must not disagree about what a field is
      // called. If `toServiceAccountChoice` ever grows a key the full view
      // does not have, that key came from somewhere other than the row.
      const row = (await mint({ name: "subset" })).account;
      const wide = new Set(Object.keys(toServiceAccountView(row)));
      for (const key of Object.keys(toServiceAccountChoice(row))) {
        expect(wide.has(key)).toBe(true);
      }
    });
  });

  // ── "cannot log in", pinned ──────────────────────────────────────────

  test("a service account carries NO credential material (acceptance §8)", () => {
    // Acceptance criterion 8 is "service accounts cannot authenticate". The
    // reason they cannot is that there is nothing to authenticate WITH — so
    // this pins the absence at the column level rather than by asserting that
    // some login route happens to 401 today. Adding `apiKeyHash` here to make
    // them loggable-in fails this test by name.
    // `maxTokensPerDay` is the LLM-SPEND budget (schema.ts:552), not an auth
    // token. Excluded BY NAME rather than by narrowing the pattern, so a new
    // column containing "token" — `apiToken`, `refreshToken` — still fires.
    const NON_CREDENTIAL = new Set(["maxTokensPerDay"]);
    const columnNames = Object.keys(serviceAccounts).filter((k) => !k.startsWith("_"));
    const credentialish = columnNames.filter(
      (c) => !NON_CREDENTIAL.has(c) && /password|passwd|secret|token|credential|key|hash/i.test(c),
    );
    expect(credentialish).toEqual([]);
    expect(columnNames).toContain("createdByUserId");
  });

  // ── writes ───────────────────────────────────────────────────────────

  describe("enable / disable", () => {
    test("disabling records the reason; re-enabling clears it", async () => {
      const created = (await mint({ name: "toggle" })).account;

      const off = await setServiceAccountEnabled(created.id, false, "runaway spend");
      expect(off?.enabled).toBe(false);
      expect(off?.disabledReason).toBe("runaway spend");

      const on = await setServiceAccountEnabled(created.id, true);
      expect(on?.enabled).toBe(true);
      // A live account carrying a stale "disabled because…" is worse than none.
      expect(on?.disabledReason).toBeNull();
    });

    test("disabling with no reason stores NULL, not the string 'undefined'", async () => {
      const created = (await mint({ name: "quiet" })).account;
      const off = await setServiceAccountEnabled(created.id, false);
      expect(off?.disabledReason).toBeNull();
    });

    test("an unknown id yields undefined, not a throw", async () => {
      expect(await setServiceAccountEnabled("nope", false, "x")).toBeUndefined();
    });
  });

  describe("the daily token cap — rung D10's remedy", () => {
    test("the cap moves and every other column is byte-identical", async () => {
      // D10 refuses a fire once the account has spent `max_tokens_per_day`
      // and its message names raising that cap as the remedy. Nothing could
      // write it: POST set it once at mint time and no route moved it.
      const before = (await mint({ name: "capped", scopes: ["use"] })).account;
      const after = await setServiceAccountDailyTokenCap(before.id, 250_000);
      expect(after?.maxTokensPerDay).toBe(250_000);

      const frozen = (row: Record<string, unknown>) => {
        const { maxTokensPerDay: _cap, updatedAt: _ts, ...rest } = row;
        return rest;
      };
      expect(frozen(after as unknown as Record<string, unknown>)).toEqual(
        frozen(before as unknown as Record<string, unknown>),
      );
      // Named as well, because these are the ones a "helpful" widening of
      // this writer would reach for first.
      expect(after?.scopes).toEqual(["use"]);
      expect(after?.createdByUserId).toBe(before.createdByUserId);
      expect(after?.enabled).toBe(true);
    });

    test("it LOWERS as readily as it raises", async () => {
      // Tightening a standing budget must never be harder than widening it.
      const created = (await mint({ name: "tighten" })).account;
      expect((await setServiceAccountDailyTokenCap(created.id, 1))?.maxTokensPerDay).toBe(1);
    });

    test("a DISABLED account's cap is writable, and writing it does NOT re-enable", async () => {
      // The asymmetry with the delegation bound, stated as a test. An admin
      // fixing the budget before switching the account back on is the
      // ordinary sequence; clearing `enabled` here would re-arm a principal
      // through a route whose whole subject is a number.
      const created = (await mint({ name: "off" })).account;
      await setServiceAccountEnabled(created.id, false, "runaway spend");

      const after = await setServiceAccountDailyTokenCap(created.id, 5);
      expect(after?.maxTokensPerDay).toBe(5);
      expect(after?.enabled).toBe(false);
      expect(after?.disabledReason).toBe("runaway spend");
    });

    test("an unknown id yields undefined, not a throw", async () => {
      expect(await setServiceAccountDailyTokenCap(crypto.randomUUID(), 10)).toBeUndefined();
    });

    test("the audit vocabulary names the cap change on its own", () => {
      // Not folded into a generic `service-account:updated`: this is the row
      // that answers "who widened the budget an unattended job spends".
      expect(SERVICE_ACCOUNT_AUDIT_ACTIONS.DAILY_CAP_CHANGED).toBe(
        "service-account:daily-cap-changed",
      );
      expect(new Set(Object.values(SERVICE_ACCOUNT_AUDIT_ACTIONS)).size).toBe(
        Object.keys(SERVICE_ACCOUNT_AUDIT_ACTIONS).length,
      );
    });
  });

  describe("delete refuses to cascade authority away silently", () => {
    test("an unowned account deletes", async () => {
      const created = (await mint({ name: "gone" })).account;
      expect(await deleteServiceAccount(created.id)).toEqual({ ok: true });
      expect(await getServiceAccount(created.id)).toBeUndefined();
    });

    test("an unknown id reports not-found", async () => {
      expect(await deleteServiceAccount("nope")).toEqual({ ok: false, reason: "not-found" });
    });

    test("an account with LIVE delegations is refused, and the row survives", async () => {
      const created = (await mint({ name: "busy" })).account;
      await insertDelegation({ id: "d-1", kind: "service", ownerId: created.id, jobRef: "j1" });
      await insertDelegation({ id: "d-2", kind: "service", ownerId: created.id, jobRef: "j2" });

      const result = await deleteServiceAccount(created.id);
      expect(result).toEqual({ ok: false, reason: "has-live-delegations", delegationCount: 2 });
      // The FK is ON DELETE CASCADE, so a delete would have SUCCEEDED at the
      // database level and taken both authorities with it. Prove it did not.
      expect(await getServiceAccount(created.id)).toBeDefined();
      expect(await countLiveDelegationsOwnedBy({ kind: "service", id: created.id })).toBe(2);
    });

    test("once the delegations are revoked the account deletes", async () => {
      const created = (await mint({ name: "freed" })).account;
      await insertDelegation({ id: "d-3", kind: "service", ownerId: created.id, jobRef: "j1" });
      await getTestDb().execute(sql`UPDATE workflow_delegations SET revoked_at = now() WHERE id = 'd-3'`);
      expect(await deleteServiceAccount(created.id)).toEqual({ ok: true });
    });
  });

  test("the audit vocabulary is namespaced away from the ext:* feed", () => {
    // `listAuditForExtension` filters `action LIKE 'ext:%'`; a service account
    // is not an extension and must not appear in a per-extension audit view.
    const actions = Object.values(SERVICE_ACCOUNT_AUDIT_ACTIONS);
    expect(actions.every((a) => a.startsWith("service-account:"))).toBe(true);
    expect(new Set(actions).size).toBe(actions.length);
  });
});

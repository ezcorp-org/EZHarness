import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createWorkflow, updateWorkflow, deleteWorkflow, getWorkflowByName } = await import(
  "../db/queries/workflows"
);
const {
  DEFAULT_UNREFERENCED_VERSIONS_KEPT,
  backfillWorkflowDefinitionVersions,
  ensureWorkflowVersion,
  getLatestWorkflowVersion,
  getRunVersionLabel,
  getWorkflowVersion,
  listWorkflowVersions,
  sweepWorkflowDefinitionVersions,
  versionMaterialChanged,
  versionMaterialKey,
  versionStepsHash,
} = await import("../db/queries/workflow-versions");
const { insertWorkflowRun } = await import("../db/queries/workflow-runs");
const { createUser } = await import("../db/queries/users");
const { workflowDefinitionHash } = await import("../runtime/workflow-definition-hash");

const steps = [{ name: "s1", agent: "writer", input: {} as Record<string, string> }];
const otherSteps = [{ name: "s1", agent: "editor", input: {} as Record<string, string> }];

/** `created_by_user_id` is a real FK, so the author has to exist — which
 *  also keeps the ON DELETE SET NULL path honest rather than hypothetical. */
const AUTHOR = "user-1";
async function freshDb() {
  await setupTestDb();
  await createUser({ id: AUTHOR, email: "a@x", passwordHash: "h", name: "A" });
}

async function seed(name: string, overrides: Record<string, unknown> = {}) {
  const row = await createWorkflow({
    name,
    description: "",
    steps,
    ...overrides,
  } as never);
  await ensureWorkflowVersion(row, AUTHOR);
  return row;
}

describe("what constitutes a new version", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("the first ensure mints version 1", async () => {
    const row = await createWorkflow({ name: "w", description: "", steps } as never);
    const { version, minted } = await ensureWorkflowVersion(row, AUTHOR);
    expect(minted).toBe(true);
    expect(version.version).toBe(1);
    expect(version.name).toBe("w");
    expect(version.createdByUserId).toBe(AUTHOR);
  });

  test("editing steps mints a new version", async () => {
    const row = await seed("w");
    const updated = await updateWorkflow(row.id, { steps: otherSteps } as never);
    const { version, minted } = await ensureWorkflowVersion(updated!, AUTHOR);
    expect(minted).toBe(true);
    expect(version.version).toBe(2);
  });

  test("a description-only edit mints NO version", async () => {
    // THE test that protects C3's consent hash. A consent pins a version,
    // so minting one on a typo fix would suspend every delegated job for
    // re-consent over prose — which trains users to click through, the
    // exact failure the consent design exists to prevent.
    const row = await seed("w");
    const updated = await updateWorkflow(row.id, { description: "a typo fix" });
    const { version, minted } = await ensureWorkflowVersion(updated!, AUTHOR);
    expect(minted).toBe(false);
    expect(version.version).toBe(1);
    expect(await listWorkflowVersions(row.id)).toHaveLength(1);
  });

  test("a rename mints NO version, and history keeps the name at that version", async () => {
    const row = await seed("old-name");
    const updated = await updateWorkflow(row.id, { name: "new-name" });
    const { minted } = await ensureWorkflowVersion(updated!, AUTHOR);
    expect(minted).toBe(false);
    // Versions are immutable: v1 still records the name it was minted
    // under, so the rename becomes visible at the next minted version
    // rather than rewriting history.
    const [v1] = await listWorkflowVersions(row.id);
    expect(v1!.name).toBe("old-name");
  });

  test("editing inputSchema mints a version even though the hash ignores it", async () => {
    const row = await seed("w");
    const updated = await updateWorkflow(row.id, {
      inputSchema: { topic: { type: "string" } },
    } as never);
    const { minted, version } = await ensureWorkflowVersion(updated!, AUTHOR);
    expect(minted).toBe(true);
    expect(version.version).toBe(2);
  });

  test("editing defaultModel mints a version", async () => {
    const row = await seed("w");
    const updated = await updateWorkflow(row.id, {
      defaultModel: { model: "claude-opus-5" },
    } as never);
    expect((await ensureWorkflowVersion(updated!, AUTHOR)).minted).toBe(true);
  });

  test("ensure is idempotent — calling it twice on an unedited row mints once", async () => {
    const row = await seed("w");
    await ensureWorkflowVersion(row, AUTHOR);
    await ensureWorkflowVersion(row, AUTHOR);
    expect(await listWorkflowVersions(row.id)).toHaveLength(1);
  });

  test("key-order differences in inputSchema do NOT mint a spurious version", async () => {
    // A jsonb round-trip does not preserve key insertion order, so a
    // raw JSON.stringify comparison would mint a version on every save.
    const a = versionMaterialKey({ steps, inputSchema: { a: 1, b: 2 } });
    const b = versionMaterialKey({ steps, inputSchema: { b: 2, a: 1 } });
    expect(a).toBe(b);
    expect(versionMaterialChanged({ steps, inputSchema: { a: 1, b: 2 } }, { steps, inputSchema: { b: 2, a: 1 } })).toBe(false);
  });

  test("versionMaterialChanged detects a steps change", () => {
    expect(versionMaterialChanged({ steps }, { steps: otherSteps })).toBe(true);
  });

  test("an absent inputSchema and a null one are the same material", () => {
    expect(versionMaterialKey({ steps })).toBe(versionMaterialKey({ steps, inputSchema: null }));
  });
});

describe("the version id is authoritative over the hash", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("stepsHash is the SAME function the runtime writes on a run", async () => {
    // The redefinition must be a no-op, not a behaviour change: widening
    // the hash's material would fail-close every parked run on upgrade.
    const material = { steps, defaultModel: null };
    expect(versionStepsHash(material)).toBe(
      workflowDefinitionHash({ name: "", description: "", steps }),
    );
  });

  test("the hash is a function of the version row, so the two cannot disagree", async () => {
    const row = await seed("w");
    const version = await getLatestWorkflowVersion(row.id);
    expect(version!.stepsHash).toBe(versionStepsHash({ steps: version!.steps, defaultModel: null }));
  });

  test("when hash and version disagree, the version id decides", async () => {
    // A run pinned to v1 keeps reporting v1 even after the definition
    // advances and its hash no longer matches anything current.
    const row = await seed("w");
    const v1 = await getLatestWorkflowVersion(row.id);
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: row.name,
      workflowDefinitionId: row.id,
      input: {},
      startedAt: new Date(),
      definitionVersionId: v1!.id,
      // Deliberately a hash of a DIFFERENT graph — the disagreement.
      definitionHash: workflowDefinitionHash({ name: "", description: "", steps: otherSteps }),
    });

    const updated = await updateWorkflow(row.id, { steps: otherSteps } as never);
    await ensureWorkflowVersion(updated!, AUTHOR);

    const label = await getRunVersionLabel(runId);
    expect(label).toEqual({ version: 1, current: 2, name: "w" });
  });

  test("a run with no version id reads as unknown rather than guessing", async () => {
    // Pre-C6 runs, and runs of YAML/extension workflows. Inventing a
    // version would be a lie in an audit surface.
    const row = await seed("w");
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: row.name,
      workflowDefinitionId: row.id,
      input: {},
      startedAt: new Date(),
      definitionHash: "legacy-hash",
    });
    expect(await getRunVersionLabel(runId)).toBeNull();
  });

  test("an unknown run id reads as unknown", async () => {
    expect(await getRunVersionLabel(crypto.randomUUID())).toBeNull();
  });
});

describe("version reads", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("listWorkflowVersions is oldest-first", async () => {
    const row = await seed("w");
    const updated = await updateWorkflow(row.id, { steps: otherSteps } as never);
    await ensureWorkflowVersion(updated!, AUTHOR);
    expect((await listWorkflowVersions(row.id)).map((v) => v.version)).toEqual([1, 2]);
  });

  test("getLatestWorkflowVersion returns the highest version", async () => {
    const row = await seed("w");
    const updated = await updateWorkflow(row.id, { steps: otherSteps } as never);
    await ensureWorkflowVersion(updated!, AUTHOR);
    expect((await getLatestWorkflowVersion(row.id))!.version).toBe(2);
  });

  test("getLatestWorkflowVersion is undefined for a definition with no versions", async () => {
    const row = await createWorkflow({ name: "unversioned", description: "", steps } as never);
    expect(await getLatestWorkflowVersion(row.id)).toBeUndefined();
  });

  test("getWorkflowVersion fetches by id, and misses cleanly", async () => {
    const row = await seed("w");
    const latest = await getLatestWorkflowVersion(row.id);
    expect((await getWorkflowVersion(latest!.id))!.version).toBe(1);
    expect(await getWorkflowVersion(crypto.randomUUID())).toBeUndefined();
  });

  test("deleting a definition cascades its versions away", async () => {
    const row = await seed("w");
    await deleteWorkflow(row.id);
    expect(await listWorkflowVersions(row.id)).toHaveLength(0);
  });
});

describe("the v1 backfill", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("seeds version 1 for every definition that has none", async () => {
    await createWorkflow({ name: "a", description: "", steps } as never);
    await createWorkflow({ name: "b", description: "", steps } as never);
    expect(await backfillWorkflowDefinitionVersions()).toBe(2);

    const a = await getWorkflowByName("a");
    const [v1] = await listWorkflowVersions(a!.id);
    expect(v1!.version).toBe(1);
    // Never invents an author for a pre-versioning definition.
    expect(v1!.createdByUserId).toBeNull();
  });

  test("a second run is a zero-row no-op", async () => {
    await createWorkflow({ name: "a", description: "", steps } as never);
    expect(await backfillWorkflowDefinitionVersions()).toBe(2 - 1);
    expect(await backfillWorkflowDefinitionVersions()).toBe(0);
  });

  test("it skips definitions that already have a version", async () => {
    await seed("already");
    await createWorkflow({ name: "fresh", description: "", steps } as never);
    expect(await backfillWorkflowDefinitionVersions()).toBe(1);
    const already = await getWorkflowByName("already");
    expect(await listWorkflowVersions(already!.id)).toHaveLength(1);
  });

  test("an empty table is a no-op", async () => {
    expect(await backfillWorkflowDefinitionVersions()).toBe(0);
  });
});

describe("retention sweep", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  async function mintVersions(name: string, count: number) {
    const row = await seed(name);
    for (let i = 2; i <= count; i++) {
      const updated = await updateWorkflow(row.id, {
        steps: [{ name: `s${i}`, agent: "writer", input: {} }],
      } as never);
      await ensureWorkflowVersion(updated!, AUTHOR);
    }
    return row;
  }

  test("keeps the most recent N unreferenced versions per definition", async () => {
    const row = await mintVersions("w", 5);
    const result = await sweepWorkflowDefinitionVersions({ keepUnreferencedPerDefinition: 2, pinnedVersionIds: [] });
    expect(result.scanned).toBe(5);
    expect(result.deleted).toBe(3);
    expect((await listWorkflowVersions(row.id)).map((v) => v.version)).toEqual([4, 5]);
  });

  test("never reaps a version a surviving run points at", async () => {
    const row = await mintVersions("w", 5);
    const [v1] = await listWorkflowVersions(row.id);
    await insertWorkflowRun({
      id: crypto.randomUUID(),
      workflowName: row.name,
      workflowDefinitionId: row.id,
      input: {},
      startedAt: new Date(),
      definitionVersionId: v1!.id,
    });

    await sweepWorkflowDefinitionVersions({ keepUnreferencedPerDefinition: 1, pinnedVersionIds: [] });
    expect((await listWorkflowVersions(row.id)).map((v) => v.version)).toEqual([1, 5]);
  });

  test("EXCLUDES a caller-supplied pin from the delete set — never relies on the FK error", async () => {
    // The C3 constraint. A delegation's consent hash pins a snapshot, and
    // reaping it would leave the consent referencing something that no
    // longer exists. Catching the RESTRICT violation would make the
    // database the control, which is backwards — so the pin is an
    // exclusion, and C3 supplies its non-revoked delegation ids here
    // without editing the sweep.
    const row = await mintVersions("w", 5);
    const versions = await listWorkflowVersions(row.id);
    const pinned = versions[1]!; // v2 — neither newest nor run-referenced

    const result = await sweepWorkflowDefinitionVersions({
      keepUnreferencedPerDefinition: 1,
      pinnedVersionIds: [pinned.id],
    });

    expect((await listWorkflowVersions(row.id)).map((v) => v.version)).toEqual([2, 5]);
    // Deleted 3 of 5, and the pinned one was never attempted.
    expect(result.deleted).toBe(3);
    expect(result.retained).toBe(2);
  });

  test("the newest version always survives, even with keep set to 1", async () => {
    const row = await mintVersions("w", 4);
    await sweepWorkflowDefinitionVersions({ keepUnreferencedPerDefinition: 1, pinnedVersionIds: [] });
    const remaining = await listWorkflowVersions(row.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.version).toBe(4);
  });

  test("a keep below 1 is clamped, so a sweep can never orphan a definition", async () => {
    const row = await mintVersions("w", 3);
    await sweepWorkflowDefinitionVersions({ keepUnreferencedPerDefinition: 0, pinnedVersionIds: [] });
    expect(await listWorkflowVersions(row.id)).toHaveLength(1);
  });

  test("each definition is bounded independently", async () => {
    const a = await mintVersions("a", 3);
    const b = await mintVersions("b", 3);
    await sweepWorkflowDefinitionVersions({ keepUnreferencedPerDefinition: 2, pinnedVersionIds: [] });
    expect(await listWorkflowVersions(a.id)).toHaveLength(2);
    expect(await listWorkflowVersions(b.id)).toHaveLength(2);
  });

  test("an empty table sweeps to nothing", async () => {
    expect(await sweepWorkflowDefinitionVersions({ pinnedVersionIds: [] })).toEqual({ scanned: 0, deleted: 0, retained: 0 });
  });

  test("pinnedVersionIds is REQUIRED, so a caller cannot forget it silently", async () => {
    // The whole defence for the one production call site: a daily sub-tick
    // inside a `try/catch` that logs `warn` and continues. A C3 that
    // forgot its pins there would turn the FK's RESTRICT violation into a
    // log line and stop the sweep reaping forever — permanently, silently,
    // and from a line no runtime test can observe. A compile error beats a
    // log line, so the omission has to be rejected by the TYPE.
    //
    // The directive below is the assertion: `bun run typecheck` fails if
    // `{}` ever becomes assignable again ("Unused '@ts-expect-error'"),
    // which is what happens the moment the field is made optional.
    // @ts-expect-error - pinnedVersionIds must be stated explicitly
    const omitted = () => sweepWorkflowDefinitionVersions({});
    expect(typeof omitted).toBe("function");
    // Stating it empty is the supported way to say "nothing is pinned".
    await expect(sweepWorkflowDefinitionVersions({ pinnedVersionIds: [] })).resolves.toMatchObject({
      deleted: 0,
    });
  });

  test("the default keep is generous — versions are the audit trail", async () => {
    expect(DEFAULT_UNREFERENCED_VERSIONS_KEPT).toBe(50);
    const row = await mintVersions("w", 3);
    const result = await sweepWorkflowDefinitionVersions({ pinnedVersionIds: [] });
    expect(result.deleted).toBe(0);
    expect(await listWorkflowVersions(row.id)).toHaveLength(3);
  });
});

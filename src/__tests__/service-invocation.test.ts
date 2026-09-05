import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();
const { workflowServiceReleaseFixture } = await import("./helpers/workflow-service-release");
const { createServiceInvocation, isServiceInvocation } = await import("../extensions/service-invocation");
const { insertWorkflowRun } = await import("../db/queries/workflow-runs");
const { workflowDelegations, workflowRuns, extensions } = await import("../db/schema");
const { registerCallProvenance, releaseCallProvenance } = await import("../extensions/call-provenance");
const { ReleaseProcess } = await import("../extensions/release-process");
const { workflowExecutionHash } = await import("../runtime/workflow-definition-hash");
const { buildWorkflowReleaseConsent } = await import("../runtime/workflow-release-consent");
const { workflowReleaseFixture } = await import("./helpers/workflow-release");
const { configureReleaseRuntime } = await import("../extensions/release-process");
const { assertServiceCapabilities } = await import("../extensions/service-capabilities");
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture() {
  const setup = await workflowServiceReleaseFixture({ invoke: async (_name, _input, context) => ({ principal: context.principalId }) });
  await insertWorkflowRun({ id: "run", workflowName: setup.release.entry.definition.name, definitionHash: workflowExecutionHash(setup.release.entry.definition, setup.release.entry.extensionRelease), startedAt: new Date(), input: {}, userId: null, runAsKind: "service", runAs: "service", delegationId: "delegation" });
  return setup;
}

test("only a persisted exact service run can mint non-serializable authority", async () => {
  const { release, authority } = await fixture();
  const seen: unknown[] = [];
  const proof = await createServiceInvocation(release.entry, authority, "run", async database => { seen.push(database); });
  expect(isServiceInvocation(proof)).toBe(true);
  expect(Object.isFrozen(proof)).toBe(true);
  expect(isServiceInvocation(JSON.parse(JSON.stringify(proof)))).toBe(false);
  expect(isServiceInvocation(null)).toBe(false);
  expect(isServiceInvocation("service")).toBe(false);
  expect(proof).toMatchObject({ serviceId: "service", delegationId: "delegation", workflowRunId: "run", projectId: null, sourceInstallationId: "installation" });
  expect(seen).toEqual([undefined]);
  const direct = await createServiceInvocation(release.entry, authority, "run");
  direct.close();
  for (const change of [{ userId: "owner" }, { runAsKind: "user" }, { runAs: null }, { delegationId: null }, { runAs: "foreign" }, { delegationId: "foreign" }, { projectId: "foreign" }]) {
    await expect(createServiceInvocation(release.entry, { ...authority, ...change }, "run", async () => {})).rejects.toThrow();
  }
  await expect(createServiceInvocation({ ...release.entry, extensionRelease: undefined }, authority, "run", async () => {})).rejects.toThrow();
  await expect(createServiceInvocation(release.entry, authority, "missing", async () => {})).rejects.toThrow();
  await expect(createServiceInvocation({ ...release.entry, definition: { ...release.entry.definition, name: "wrong" } }, authority, "run", async () => {})).rejects.toThrow();
});

test("service tokens retain null human identity and reject forgery and revoked authority", async () => {
  const { db, release, authority } = await fixture();
  release.snapshot.release.manifest.tools = [{ name: "observe", description: "Observe", inputSchema: { type: "object" }, outputSchema: { type: "object" } }];
  await db.update(workflowDelegations).set({ capabilitySet: [{ kind: "tool", value: "observe" }] }).where(eq(workflowDelegations.id, "delegation"));
  const proof = await createServiceInvocation(release.entry, authority, "run", async () => {});
  const invocationGuard = async (database?: import("../db/migrations/types").MigrationDb) => { await assertServiceCapabilities(proof, "installation", [], { toolName: "observe", database }); };
  const provenance = { onBehalfOf: null, conversationId: "workflow-run:run", runId: "run", parentCallId: null, actorExtensionId: "installation", kind: "tool" as const, ownerless: false, serviceInvocation: proof, invocationGuard };
  expect(() => registerCallProvenance({ ...provenance, onBehalfOf: "owner" })).toThrow();
  expect(() => registerCallProvenance({ ...provenance, ownerless: true })).toThrow();
  expect(() => registerCallProvenance({ ...provenance, serviceInvocation: { ...proof } })).toThrow();
  const token = registerCallProvenance(provenance);
  const process = new ReleaseProcess("installation");
  const unguarded = registerCallProvenance({ ...provenance, invocationGuard: undefined });
  try {
    await expect(process.callTool("observe", {}, { ezCallId: unguarded })).rejects.toThrow("active call token");
    expect(release.calls).toEqual([]);
    expect(await process.callTool("observe", {}, { ezCallId: token })).toEqual({ content: [{ type: "text", text: '{"principal":"service"}' }], isError: false });
    expect(release.calls[0]?.context).toMatchObject({ principalId: "service", metadata: { principalKind: "service", serviceId: "service", delegationId: "delegation", workflowRunId: "run" } });
    await db.transaction(async transaction => {
      await proof.assertActive(transaction);
      await transaction.update(workflowDelegations).set({ enabled: false }).where(eq(workflowDelegations.id, "delegation"));
      await expect(proof.assertActive(transaction)).rejects.toThrow("no longer available");
    });
    await expect(process.callTool("observe", {}, { ezCallId: token })).rejects.toThrow("no longer available");
    expect(release.calls).toHaveLength(1);
  } finally { releaseCallProvenance(token); releaseCallProvenance(unguarded); }
});

test("settled workflow authority cannot survive cleanup or resume a pending admission", async () => {
  const { db, release, authority } = await fixture();
  const entered = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  let wait = false;
  const proof = await createServiceInvocation(release.entry, authority, "run", async () => {
    if (wait) { entered.resolve(); await resumed.promise; }
  });
  wait = true;
  const pending = proof.assertActive();
  await entered.promise;
  proof.close();
  resumed.resolve();
  await expect(pending).rejects.toThrow("closed");
  await expect(proof.assertActive()).rejects.toThrow("closed");
  await db.update(workflowRuns).set({ status: "success" }).where(eq(workflowRuns.id, "run"));
  await expect(createServiceInvocation(release.entry, authority, "run", async () => {})).rejects.toThrow("persisted workflow run");
});

test("another host terminalizing a run denies an otherwise open service proof", async () => {
  const { db, release, authority } = await fixture();
  const proof = await createServiceInvocation(release.entry, authority, "run");
  await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, "run"));
  await expect(proof.assertActive()).rejects.toThrow("persisted workflow run");
});

test.each([{ definitionHash: null }, { definitionHash: "replacement" }, { userId: "owner" }, { runAsKind: "user" as const }, { runAs: "foreign" }, { delegationId: null }, { workflowName: "foreign" }])("service proof refuses changed persisted run identity %j in the effect transaction", async change => {
  const { db, release, authority } = await fixture();
  const proof = await createServiceInvocation(release.entry, authority, "run");
  await db.transaction(async transaction => {
    await proof.assertActive(transaction);
    await transaction.update(workflowRuns).set(change).where(eq(workflowRuns.id, "run"));
    await expect(proof.assertActive(transaction)).rejects.toThrow("persisted workflow run");
  });
  await expect(createServiceInvocation(release.entry, authority, "run")).rejects.toThrow("persisted workflow run");
});

test("terminalization during an awaited guard cannot reopen service admission", async () => {
  const { db, release, authority } = await fixture();
  let terminate = false;
  const proof = await createServiceInvocation(release.entry, authority, "run", async () => {
    if (terminate) await db.update(workflowRuns).set({ status: "error" }).where(eq(workflowRuns.id, "run"));
  });
  terminate = true;
  await expect(proof.assertActive()).rejects.toThrow("persisted workflow run");
});

test("a host workflow uses its sealed delegation origin without pretending to be an extension", async () => {
  const { db, release, authority } = await fixture();
  const definition = { name: "host-root", description: "Host workflow", steps: [] };
  const entry: import("../runtime/workflow-scope").CachedWorkflow = { definition, source: "yaml", visibility: "system", id: null, userId: null, projectId: null, forkedFrom: null };
  const binding = buildWorkflowReleaseConsent({ release: release.entry.extensionRelease!, workflowName: definition.name, ownerKind: "service", ownerId: "service", projectId: null }, [release.entry]);
  await db.update(workflowDelegations).set({ workflowName: definition.name, extensionReleaseBinding: binding }).where(eq(workflowDelegations.id, "delegation"));
  await db.update(workflowRuns).set({ workflowName: definition.name, definitionHash: workflowExecutionHash(definition) }).where(eq(workflowRuns.id, "run"));
  const proof = await createServiceInvocation(entry, authority, "run");
  expect(proof).toMatchObject({ sourceInstallationId: "installation", sourceReleaseBinding: release.entry.extensionRelease!.binding, consenterId: "owner", serviceId: "service" });
  await db.transaction(transaction => proof.assertActive(transaction));
  await db.update(workflowDelegations).set({ extensionReleaseBinding: null }).where(eq(workflowDelegations.id, "delegation"));
  await expect(proof.assertActive()).rejects.toThrow("origin");
  await expect(createServiceInvocation(entry, authority, "run")).rejects.toThrow("sealed service delegation");
});

test("an awaited check cannot switch the origin of an already issued service proof", async () => {
  const { db, release, authority } = await fixture();
  const other = workflowReleaseFixture({ name: "other:root", description: "Other origin", steps: [] }, "owner", "other");
  await db.insert(extensions).values({ id: "other", name: "other", version: "1.0.0", description: "Other", source: "test", enabled: true, manifest: other.snapshot.release.manifest });
  configureReleaseRuntime({ runner: async () => release.runner, resolve: async id => id === "installation" ? release.snapshot : id === "other" ? other.snapshot : null });
  const binding = buildWorkflowReleaseConsent({ release: other.entry.extensionRelease!, workflowName: release.entry.definition.name, ownerKind: "service", ownerId: "service", projectId: null }, [release.entry]);
  let change = false;
  const proof = await createServiceInvocation(release.entry, authority, "run", async () => {
    if (change) await db.update(workflowDelegations).set({ extensionId: "other", extensionReleaseBinding: binding }).where(eq(workflowDelegations.id, "delegation"));
  });
  change = true;
  await expect(proof.assertActive()).rejects.toThrow("origin");
});

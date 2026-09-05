import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();
const { workflowServiceReleaseFixture } = await import("./helpers/workflow-service-release");
const { createServiceInvocation, isServiceInvocation } = await import("../extensions/service-invocation");
const { insertWorkflowRun } = await import("../db/queries/workflow-runs");
const { workflowDelegations, workflowRuns } = await import("../db/schema");
const { registerCallProvenance, releaseCallProvenance } = await import("../extensions/call-provenance");
const { ReleaseProcess } = await import("../extensions/release-process");
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture() {
  const setup = await workflowServiceReleaseFixture({ invoke: async (_name, _input, context) => ({ principal: context.principalId }) });
  await insertWorkflowRun({ id: "run", workflowName: setup.release.entry.definition.name, startedAt: new Date(), input: {}, userId: null, runAsKind: "service", runAs: "service", delegationId: "delegation" });
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
  const proof = await createServiceInvocation(release.entry, authority, "run", async () => {});
  const provenance = { onBehalfOf: null, conversationId: "workflow-run:run", runId: "run", parentCallId: null, actorExtensionId: "installation", kind: "tool" as const, ownerless: false, serviceInvocation: proof };
  expect(() => registerCallProvenance({ ...provenance, onBehalfOf: "owner" })).toThrow();
  expect(() => registerCallProvenance({ ...provenance, ownerless: true })).toThrow();
  expect(() => registerCallProvenance({ ...provenance, serviceInvocation: { ...proof } })).toThrow();
  const token = registerCallProvenance(provenance);
  const process = new ReleaseProcess("installation");
  try {
    expect(await process.callTool("observe", {}, { ezCallId: token })).toEqual({ content: [{ type: "text", text: '{"principal":"service"}' }], isError: false });
    expect(release.calls[0]?.context).toMatchObject({ principalId: "service", metadata: { principalKind: "service", serviceId: "service", delegationId: "delegation", workflowRunId: "run" } });
    await db.transaction(async transaction => {
      await proof.assertActive(transaction);
      await transaction.update(workflowDelegations).set({ enabled: false }).where(eq(workflowDelegations.id, "delegation"));
      await expect(proof.assertActive(transaction)).rejects.toThrow("no longer available");
    });
    await expect(process.callTool("observe", {}, { ezCallId: token })).rejects.toThrow("no longer available");
    expect(release.calls).toHaveLength(1);
  } finally { releaseCallProvenance(token); }
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

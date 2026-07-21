/**
 * query-aux (db-audit): countActiveProposalsForProject is a concurrency-cap
 * probe on the run-lifecycle hot path. It must answer with a SQL COUNT over
 * the mid-flight statuses (approved/spawned/running) — NOT by SELECT *-ing
 * every active row and filtering in JS. This pins the OBSERVABLE contract:
 *   - pending is excluded (queued, not consuming a run slot);
 *   - each of approved/spawned/running is counted;
 *   - terminal rows are excluded;
 *   - an empty projectId short-circuits to 0.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "../../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";

mockDbConnection();

const { createProject } = await import("../projects");
const {
  upsertLink,
  insertProposalIfNew,
  updateProposal,
  countActiveProposalsForProject,
} = await import("../github-projects");
const { githubProposalDedupeKey } = await import("../../../integrations/github-projects/types");

function proposalInput(projectId: string, linkId: string, itemNodeId: string) {
  return {
    projectId,
    linkId,
    itemNodeId,
    contentNodeId: null,
    statusOptionId: "opt",
    statusName: "Doing",
    action: "plan" as const,
    title: "A ticket",
    ticketUrl: null,
    dedupeKey: githubProposalDedupeKey(projectId, itemNodeId, "opt", "plan"),
  };
}

async function seed(): Promise<{ projectId: string; linkId: string }> {
  const p = await createProject({ name: "Proj", path: `/tmp/${crypto.randomUUID()}` });
  const link = await upsertLink({ projectId: p.id, boardNodeId: "PVT_a", boardUrl: "u" });
  return { projectId: p.id, linkId: link.id };
}

describe("countActiveProposalsForProject — SQL COUNT over mid-flight statuses", () => {
  beforeEach(async () => { await setupTestDb(); });
  afterAll(async () => { await closeTestDb(); restoreModuleMocks(); });

  test("empty projectId short-circuits to 0", async () => {
    expect(await countActiveProposalsForProject("")).toBe(0);
  });

  test("no proposals → 0", async () => {
    const { projectId } = await seed();
    expect(await countActiveProposalsForProject(projectId)).toBe(0);
  });

  test("pending is NOT counted (queued, not consuming a run slot)", async () => {
    const { projectId, linkId } = await seed();
    await insertProposalIfNew(proposalInput(projectId, linkId, "i1")); // stays pending
    expect(await countActiveProposalsForProject(projectId)).toBe(0);
  });

  test("approved / spawned / running are each counted", async () => {
    const { projectId, linkId } = await seed();
    for (const [i, status] of (["approved", "spawned", "running"] as const).entries()) {
      const p = await insertProposalIfNew(proposalInput(projectId, linkId, `card-${i}`));
      await updateProposal(p!.id, { status });
    }
    expect(await countActiveProposalsForProject(projectId)).toBe(3);
  });

  test("terminal rows are excluded; the count is a plain number", async () => {
    const { projectId, linkId } = await seed();
    const running = await insertProposalIfNew(proposalInput(projectId, linkId, "live"));
    await updateProposal(running!.id, { status: "running" });
    const done = await insertProposalIfNew(proposalInput(projectId, linkId, "old"));
    await updateProposal(done!.id, { status: "done" });
    const n = await countActiveProposalsForProject(projectId);
    expect(n).toBe(1);
    expect(Number.isInteger(n)).toBe(true);
  });

  test("scoped to the project — a different project's rows never bleed in", async () => {
    const a = await seed();
    const b = await seed();
    const pa = await insertProposalIfNew(proposalInput(a.projectId, a.linkId, "i1"));
    await updateProposal(pa!.id, { status: "running" });
    expect(await countActiveProposalsForProject(b.projectId)).toBe(0);
  });
});

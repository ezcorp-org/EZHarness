/**
 * Focused unit coverage for the github-projects DB query layer
 * (src/db/queries/github-projects.ts) against a REAL PGlite database.
 *
 * Kept deliberately SMALL + isolated (one module under test, no cross-mocks)
 * so Bun's --coverage attribution is stable and every branch of every query is
 * exercised: link upsert (insert + conflict-update with the `??` default
 * fallbacks), pause/cursor/health writes, the proposal idempotency upsert
 * (ON CONFLICT → null), the Hub list/count filters, and the disconnect cancel.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
} from "../../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";
import { createProject } from "../../../db/queries/projects";
import {
  getLinkByProjectId,
  getLinkById,
  listEnabledLinks,
  upsertLink,
  updateLink,
  setLinkEnabled,
  updateLinkPollState,
  deleteLink,
  insertProposalIfNew,
  getProposalById,
  listProposalsByProject,
  countActiveProposalsForProject,
  updateProposal,
  getProposalByRunId,
  cancelActiveProposalsForLink,
} from "../../../db/queries/github-projects";
import { githubProposalDedupeKey } from "../types";

mockDbConnection();

async function seedProject(name = "Proj"): Promise<string> {
  const p = await createProject({ name, path: `/tmp/${name}` });
  return p.id;
}

describe("github-projects queries", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
    restoreModuleMocks();
  });

  test("upsertLink inserts, then conflict-updates the same project (incl. ?? fallbacks)", async () => {
    const projectId = await seedProject();

    const created = await upsertLink({
      projectId,
      boardNodeId: "PVT_a",
      boardUrl: "https://github.com/orgs/acme/projects/1",
      boardTitle: "Roadmap",
      ownerLogin: "acme",
      statusFieldId: "FIELD_s",
      authMode: "pat",
      columnActionMap: { "opt-doing": { action: "execute", autoSpawn: false } },
      enabled: true,
      pollIntervalSec: 30,
    });
    expect(created.projectId).toBe(projectId);
    expect(created.boardTitle).toBe("Roadmap");

    // Re-connect with MINIMAL fields → exercises every `?? default` in the
    // conflict-update set (boardTitle/owner/statusField/authMode/map/enabled/
    // interval) and the pollCursor/lastError reset.
    const replaced = await upsertLink({
      projectId,
      boardNodeId: "PVT_b",
      boardUrl: "https://github.com/orgs/acme/projects/2",
    });
    expect(replaced.id).toBe(created.id); // same row (UNIQUE(project_id))
    expect(replaced.boardNodeId).toBe("PVT_b");
    expect(replaced.boardTitle).toBe("");
    expect(replaced.authMode).toBe("pat");
    expect(replaced.pollIntervalSec).toBe(60);
    expect(replaced.enabled).toBe(true);
    expect(replaced.columnActionMap).toEqual({});
    expect(replaced.pollCursor).toBeNull();
  });

  test("getLinkByProjectId / getLinkById: found, not-found, and empty-id guards", async () => {
    expect(await getLinkByProjectId("")).toBeNull();
    expect(await getLinkById("")).toBeNull();
    expect(await getLinkByProjectId("nope")).toBeNull();
    expect(await getLinkById("nope")).toBeNull();

    const projectId = await seedProject();
    const link = await upsertLink({
      projectId,
      boardNodeId: "PVT_a",
      boardUrl: "u",
    });
    expect((await getLinkByProjectId(projectId))?.id).toBe(link.id);
    expect((await getLinkById(link.id))?.projectId).toBe(projectId);
  });

  test("listEnabledLinks returns only enabled (paused) links", async () => {
    const p1 = await seedProject("A");
    const p2 = await seedProject("B");
    const enabled = await upsertLink({ projectId: p1, boardNodeId: "PVT_1", boardUrl: "u", enabled: true });
    const paused = await upsertLink({ projectId: p2, boardNodeId: "PVT_2", boardUrl: "u", enabled: false });

    const ids = (await listEnabledLinks()).map((l) => l.id);
    expect(ids).toContain(enabled.id);
    expect(ids).not.toContain(paused.id);
  });

  test("updateLink patches fields; setLinkEnabled pauses/resumes; null for missing", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });

    const patched = await updateLink(link.id, {
      pollIntervalSec: 120,
      columnActionMap: { "opt-x": { action: "plan", autoSpawn: true } },
    });
    expect(patched?.pollIntervalSec).toBe(120);
    expect(patched?.columnActionMap["opt-x"]?.autoSpawn).toBe(true);

    const paused = await setLinkEnabled(link.id, false);
    expect(paused?.enabled).toBe(false);
    const resumed = await setLinkEnabled(link.id, true);
    expect(resumed?.enabled).toBe(true);

    expect(await updateLink("missing", { pollIntervalSec: 1 })).toBeNull();
  });

  test("updateLinkPollState writes cursor + health", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const when = new Date();
    await updateLinkPollState(link.id, {
      pollCursor: { item: "2026-06-01T00:00:00Z" },
      lastPolledAt: when,
      lastError: "boom",
      lastErrorAt: when,
    });
    const after = await getLinkById(link.id);
    expect(after?.pollCursor).toEqual({ item: "2026-06-01T00:00:00Z" });
    expect(after?.lastError).toBe("boom");
  });

  test("deleteLink drops the row (proposals cascade)", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    await deleteLink(link.id);
    expect(await getLinkById(link.id)).toBeNull();
    expect(await listProposalsByProject(projectId)).toHaveLength(0);
  });

  test("insertProposalIfNew is idempotent on dedupeKey (ON CONFLICT → null)", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const first = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    expect(first).not.toBeNull();
    const dup = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    expect(dup).toBeNull();
  });

  test("getProposalById + empty-id guard", async () => {
    expect(await getProposalById("")).toBeNull();
    expect(await getProposalById("nope")).toBeNull();
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const p = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    expect((await getProposalById(p!.id))?.id).toBe(p!.id);
  });

  test("listProposalsByProject: empty guard, status filter, and limit", async () => {
    expect(await listProposalsByProject("")).toEqual([]);
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const a = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    const b = await insertProposalIfNew(proposalInput(projectId, link.id, "i2", "opt", "plan"));
    await updateProposal(b!.id, { status: "done", finishedAt: new Date() });

    expect(await listProposalsByProject(projectId)).toHaveLength(2);
    expect(await listProposalsByProject(projectId, { statuses: ["pending"] })).toHaveLength(1);
    expect(await listProposalsByProject(projectId, { limit: 1 })).toHaveLength(1);
    // limit <= 0 is ignored (no .limit applied)
    expect(await listProposalsByProject(projectId, { limit: 0 })).toHaveLength(2);
    void a;
  });

  test("countActiveProposalsForProject excludes pending + terminal", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const pending = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    const running = await insertProposalIfNew(proposalInput(projectId, link.id, "i2", "opt", "plan"));
    await updateProposal(running!.id, { status: "running" });
    void pending;
    expect(await countActiveProposalsForProject(projectId)).toBe(1); // running only
  });

  test("updateProposal + getProposalByRunId (+ empty guard)", async () => {
    expect(await getProposalByRunId("")).toBeNull();
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const p = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "execute"));
    await updateProposal(p!.id, { status: "running", agentRunId: "run-9", conversationId: null });
    expect((await getProposalByRunId("run-9"))?.id).toBe(p!.id);
    expect(await updateProposal("missing", { status: "done" })).toBeNull();
  });

  test("cancelActiveProposalsForLink flips active rows to cancelled and returns the count", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const active = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    const done = await insertProposalIfNew(proposalInput(projectId, link.id, "i2", "opt", "plan"));
    await updateProposal(done!.id, { status: "done" });

    const n = await cancelActiveProposalsForLink(link.id);
    expect(n).toBe(1);
    expect((await getProposalById(active!.id))?.status).toBe("cancelled");
    expect((await getProposalById(done!.id))?.status).toBe("done");
  });
});

function proposalInput(
  projectId: string,
  linkId: string,
  itemNodeId: string,
  statusOptionId: string,
  action: "plan" | "execute",
) {
  return {
    projectId,
    linkId,
    itemNodeId,
    contentNodeId: null,
    statusOptionId,
    statusName: "Doing",
    action,
    title: "A ticket",
    ticketUrl: null,
    dedupeKey: githubProposalDedupeKey(projectId, itemNodeId, statusOptionId, action),
  };
}

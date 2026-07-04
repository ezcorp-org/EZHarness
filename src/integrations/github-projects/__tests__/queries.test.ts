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
import { createConversation } from "../../../db/queries/conversations";
import {
  getLinkByProjectId,
  getLinkById,
  listLinksByProjectId,
  listEnabledLinks,
  upsertLink,
  updateLink,
  setLinkEnabled,
  updateLinkPollState,
  deleteLink,
  insertProposalIfNew,
  getProposalById,
  getProposalByConversationId,
  listProposalsByProject,
  countActiveProposalsForProject,
  updateProposal,
  claimProposal,
  getProposalByRunId,
  cancelActiveProposalsForLink,
  failInterruptedProposals,
} from "../../../db/queries/github-projects";
import { githubProposalDedupeKey, GITHUB_ACTIVE_STATUSES } from "../types";

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

  test("upsertLink: re-connecting the SAME board updates it (incl. ?? fallbacks); a DIFFERENT board inserts", async () => {
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

    // Re-connect the SAME board (PVT_a) with MINIMAL fields → conflict-UPDATE
    // on (project_id, board_node_id). Exercises every `?? default` in the set
    // (boardTitle/owner/statusField/authMode/map/enabled/interval) and the
    // pollCursor/lastError reset.
    const updated = await upsertLink({
      projectId,
      boardNodeId: "PVT_a",
      boardUrl: "https://github.com/orgs/acme/projects/1b",
    });
    expect(updated.id).toBe(created.id); // same row (same project+board)
    expect(updated.boardUrl).toBe("https://github.com/orgs/acme/projects/1b");
    expect(updated.boardTitle).toBe("");
    expect(updated.authMode).toBe("pat");
    expect(updated.pollIntervalSec).toBe(60);
    expect(updated.enabled).toBe(true);
    expect(updated.columnActionMap).toEqual({});
    expect(updated.pollCursor).toBeNull();

    // Connecting a DIFFERENT board to the same project INSERTS a second row.
    const second = await upsertLink({
      projectId,
      boardNodeId: "PVT_b",
      boardUrl: "https://github.com/orgs/acme/projects/2",
    });
    expect(second.id).not.toBe(created.id);
    expect(second.boardNodeId).toBe("PVT_b");
  });

  test("listLinksByProjectId returns all of a project's boards oldest-first (empty-id guard)", async () => {
    expect(await listLinksByProjectId("")).toEqual([]);
    expect(await listLinksByProjectId("nope")).toEqual([]);

    const projectId = await seedProject();
    const first = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u1" });
    const second = await upsertLink({ projectId, boardNodeId: "PVT_b", boardUrl: "u2" });
    // A board in a DIFFERENT project must not leak into this project's list.
    const otherProject = await seedProject("Other");
    await upsertLink({ projectId: otherProject, boardNodeId: "PVT_c", boardUrl: "u3" });

    const ids = (await listLinksByProjectId(projectId)).map((l) => l.id);
    expect(ids).toEqual([first.id, second.id]); // createdAt asc (insertion order)
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

  test("updateLink persists statusOptions + statusFieldId (the refresh-columns write path)", async () => {
    const projectId = await seedProject();
    // A legacy/empty link: no columns persisted yet (status_options = []).
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    expect(link.statusOptions).toEqual([]);
    expect(link.statusFieldId).toBeNull();

    // The refresh-columns route writes the board's full id+name set + field id.
    const options = [
      { id: "d930e00b", name: "needs planning" },
      { id: "f75ad846", name: "Todo" },
      { id: "47fc9ee4", name: "In Progress" },
      { id: "98236657", name: "Done" },
    ];
    const patched = await updateLink(link.id, {
      statusOptions: options,
      statusFieldId: "PVTSSF_field",
    });
    expect(patched?.statusOptions).toEqual(options);
    expect(patched?.statusFieldId).toBe("PVTSSF_field");

    // Durable: a fresh read (what publicLinkView/the page GET sees) carries them.
    const reread = await getLinkByProjectId(projectId);
    expect(reread?.statusOptions).toHaveLength(4);
    expect(reread?.statusOptions.map((o) => o.name)).toEqual([
      "needs planning",
      "Todo",
      "In Progress",
      "Done",
    ]);
    expect(reread?.statusFieldId).toBe("PVTSSF_field");
  });

  test("defaultPermissionMode round-trips through upsertLink + updateLink (and the ?? null fallback on re-connect)", async () => {
    const projectId = await seedProject();

    // Connect with an explicit board-level default permission mode.
    const created = await upsertLink({
      projectId,
      boardNodeId: "PVT_a",
      boardUrl: "u",
      defaultPermissionMode: "ask",
    });
    expect(created.defaultPermissionMode).toBe("ask");

    // updateLink patches it to another runtime mode.
    const patched = await updateLink(created.id, { defaultPermissionMode: "auto-edit" });
    expect(patched?.defaultPermissionMode).toBe("auto-edit");

    // updateLink can clear it back to null (board falls back to 'yolo' at spawn).
    const cleared = await updateLink(created.id, { defaultPermissionMode: null });
    expect(cleared?.defaultPermissionMode).toBeNull();

    // A re-connect of the SAME board with the field OMITTED exercises the
    // `?? null` default in upsertLink's conflict set-clause.
    const reconnected = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u2" });
    expect(reconnected.id).toBe(created.id);
    expect(reconnected.defaultPermissionMode).toBeNull();
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

  test("insertProposalIfNew is idempotent for a re-detected card (ON CONFLICT → null) and still stamps dedupeKey", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const first = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    expect(first).not.toBeNull();
    // dedupe_key is provenance now (not unique) but every row still carries it.
    expect(first!.dedupeKey).toBe(githubProposalDedupeKey(projectId, "i1", "opt", "plan"));
    const dup = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    expect(dup).toBeNull();
  });

  test("insertProposalIfNew: EACH active status blocks a second proposal for the card (→ null)", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    for (const status of GITHUB_ACTIVE_STATUSES) {
      const item = `card-${status}`;
      const held = await insertProposalIfNew(proposalInput(projectId, link.id, item, "opt-x", "plan"));
      expect(held).not.toBeNull();
      if (status !== "pending") await updateProposal(held!.id, { status });
      // Re-detection of the same card while a proposal is in-flight → no-op.
      expect(await insertProposalIfNew(proposalInput(projectId, link.id, item, "opt-x", "plan"))).toBeNull();
      expect((await getProposalById(held!.id))?.status).toBe(status); // untouched
    }
    // Exactly one row per card survived.
    expect(await listProposalsByProject(projectId)).toHaveLength(GITHUB_ACTIVE_STATUSES.length);
  });

  test("insertProposalIfNew: EACH terminal status frees the card — re-entry inserts a FRESH proposal", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    for (const status of ["done", "failed", "dismissed", "cancelled"] as const) {
      const item = `card-${status}`;
      const finished = await insertProposalIfNew(proposalInput(projectId, link.id, item, "opt-x", "plan"));
      expect(finished).not.toBeNull();
      await updateProposal(finished!.id, { status, finishedAt: new Date() });
      // Terminal row no longer occupies the card → the re-trigger lands.
      const fresh = await insertProposalIfNew(proposalInput(projectId, link.id, item, "opt-x", "plan"));
      expect(fresh).not.toBeNull();
      expect(fresh!.id).not.toBe(finished!.id);
      expect(fresh!.status).toBe("pending");
      // History keeps BOTH rows (terminal + fresh).
      const rows = await listProposalsByProject(projectId);
      expect(rows.filter((r) => r.itemNodeId === item)).toHaveLength(2);
    }
  });

  test("insertProposalIfNew: an active proposal in column X blocks column Y for the SAME card (cross-column move mid-run)", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const inX = await insertProposalIfNew(proposalInput(projectId, link.id, "card-1", "opt-x", "plan"));
    expect(inX).not.toBeNull();
    await updateProposal(inX!.id, { status: "running" });
    // Different column AND different action ⇒ a different dedupeKey — under
    // the legacy key this would have double-spawned; the card-scoped guard
    // blocks it.
    expect(await insertProposalIfNew(proposalInput(projectId, link.id, "card-1", "opt-y", "execute"))).toBeNull();
    expect(await listProposalsByProject(projectId)).toHaveLength(1);
  });

  test("insertProposalIfNew: two CONCURRENT inserts for one card → exactly one wins (atomic at the DB)", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const [a, b] = await Promise.all([
      insertProposalIfNew(proposalInput(projectId, link.id, "card-race", "opt-x", "plan")),
      insertProposalIfNew(proposalInput(projectId, link.id, "card-race", "opt-y", "execute")),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const rows = await listProposalsByProject(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(winners[0]!.id);
  });

  test("insertProposalIfNew: different cards on the same link are independent", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const a = await insertProposalIfNew(proposalInput(projectId, link.id, "card-a", "opt-x", "plan"));
    const b = await insertProposalIfNew(proposalInput(projectId, link.id, "card-b", "opt-x", "plan"));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await listProposalsByProject(projectId)).toHaveLength(2);
  });

  test("insertProposalIfNew: the same itemNodeId on DIFFERENT links is independent (identity is (link_id, item_node_id))", async () => {
    const projectId = await seedProject();
    const linkA = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u1" });
    const linkB = await upsertLink({ projectId, boardNodeId: "PVT_b", boardUrl: "u2" });
    const onA = await insertProposalIfNew(proposalInput(projectId, linkA.id, "card-shared", "opt-x", "plan"));
    expect(onA).not.toBeNull();
    await updateProposal(onA!.id, { status: "running" });
    // The other board's view of the "same" card is a separate identity.
    const onB = await insertProposalIfNew(proposalInput(projectId, linkB.id, "card-shared", "opt-x", "plan"));
    expect(onB).not.toBeNull();
    expect(onB!.linkId).toBe(linkB.id);
    expect(await listProposalsByProject(projectId)).toHaveLength(2);
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

  test("getProposalByConversationId finds the proposal that owns a conversation (+ empty/missing guards)", async () => {
    expect(await getProposalByConversationId("")).toBeNull();
    expect(await getProposalByConversationId("nope")).toBeNull();

    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    // The spawn bridge stamps the conversation onto the proposal; seed a real
    // conversation so the FK is satisfied, then stamp it.
    const conv = await createConversation(projectId, { title: "Spawned run" });
    const p = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    await updateProposal(p!.id, { conversationId: conv.id });

    expect((await getProposalByConversationId(conv.id))?.id).toBe(p!.id);
  });

  test("claimProposal transitions only from the expected statuses (+ guards)", async () => {
    expect(await claimProposal("", ["pending"], { status: "dismissed" })).toBeNull();
    expect(await claimProposal("missing", ["pending"], { status: "dismissed" })).toBeNull();

    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const p = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));

    // pending → spawned succeeds ONCE and stamps the patch atomically.
    const when = new Date();
    const claimed = await claimProposal(p!.id, ["pending"], {
      status: "spawned",
      agentRunId: "run-1",
      decidedAt: when,
    });
    expect(claimed?.status).toBe("spawned");
    expect(claimed?.agentRunId).toBe("run-1");
    // A second pending-claim of the SAME row loses (status no longer matches).
    expect(await claimProposal(p!.id, ["pending"], { status: "spawned" })).toBeNull();

    // spawned → running; then an active → terminal claim; then terminal is FINAL.
    expect((await claimProposal(p!.id, ["spawned"], { status: "running" }))?.status).toBe("running");
    const done = await claimProposal(p!.id, GITHUB_ACTIVE_STATUSES, {
      status: "done",
      finishedAt: new Date(),
    });
    expect(done?.status).toBe("done");
    expect(done?.finishedAt).toBeInstanceOf(Date);
    expect(await claimProposal(p!.id, GITHUB_ACTIVE_STATUSES, { status: "cancelled" })).toBeNull();
    expect((await getProposalById(p!.id))?.status).toBe("done"); // untouched by the lost claim
  });

  test("claimProposal: two CONCURRENT pending-claims yield exactly one winner (anti-double-approve)", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const p = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));

    const [a, b] = await Promise.all([
      claimProposal(p!.id, ["pending"], { status: "spawned", agentRunId: "run-A" }),
      claimProposal(p!.id, ["pending"], { status: "spawned", agentRunId: "run-B" }),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    // The row carries exactly the winner's stamp.
    expect((await getProposalById(p!.id))?.agentRunId).toBe(winners[0]!.agentRunId);
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

  test("failInterruptedProposals: FULL status matrix — only spawned+running flip (error + finishedAt), and exactly those rows return", async () => {
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });

    // One proposal per lifecycle status (distinct cards so the partial unique
    // index never conflicts). pending stays as-inserted; the rest are moved
    // via updateProposal.
    const statuses = [
      "pending",
      "approved",
      "spawned",
      "running",
      "done",
      "failed",
      "dismissed",
      "cancelled",
    ] as const;
    const byStatus = new Map<(typeof statuses)[number], string>();
    for (const status of statuses) {
      const row = await insertProposalIfNew(
        proposalInput(projectId, link.id, `card-${status}`, "opt", "plan"),
      );
      expect(row).not.toBeNull();
      if (status !== "pending") await updateProposal(row!.id, { status });
      byStatus.set(status, row!.id);
    }

    const flipped = await failInterruptedProposals();

    // Returns EXACTLY the spawned + running rows — nothing else.
    expect(flipped.map((r) => r.id).sort()).toEqual(
      [byStatus.get("spawned")!, byStatus.get("running")!].sort(),
    );
    for (const row of flipped) {
      expect(row.status).toBe("failed");
      expect(row.error).toBe("Interrupted by restart");
      expect(row.finishedAt).toBeInstanceOf(Date);
    }
    // Durable: a fresh read agrees with the RETURNING payload.
    for (const orphaned of ["spawned", "running"] as const) {
      const reread = await getProposalById(byStatus.get(orphaned)!);
      expect(reread?.status).toBe("failed");
      expect(reread?.error).toBe("Interrupted by restart");
      expect(reread?.finishedAt).toBeInstanceOf(Date);
    }
    // pending/approved (no run attached) + every terminal status: untouched —
    // status unchanged AND no error/finishedAt stamped (the pre-existing
    // `failed` row proves the WHERE excluded it: its error stays null).
    for (const untouched of ["pending", "approved", "done", "failed", "dismissed", "cancelled"] as const) {
      const reread = await getProposalById(byStatus.get(untouched)!);
      expect(reread?.status).toBe(untouched);
      expect(reread?.error).toBeNull();
      expect(reread?.finishedAt).toBeNull();
    }
  });

  test("failInterruptedProposals: no mid-flight rows (empty table) → []", async () => {
    expect(await failInterruptedProposals()).toEqual([]);
    // A pending-only table is equally a no-op.
    const projectId = await seedProject();
    const link = await upsertLink({ projectId, boardNodeId: "PVT_a", boardUrl: "u" });
    const pending = await insertProposalIfNew(proposalInput(projectId, link.id, "i1", "opt", "plan"));
    expect(await failInterruptedProposals()).toEqual([]);
    expect((await getProposalById(pending!.id))?.status).toBe("pending");
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

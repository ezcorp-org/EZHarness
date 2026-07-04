/**
 * Integration test for GithubProjectsDaemon against a REAL PGlite DB.
 *
 * Only the GitHub client is mocked (injected). The DB query layer
 * (listEnabledLinks / insertProposalIfNew / updateLinkPollState / updateProposal)
 * runs for real against a migrated PGlite instance, so this proves the
 * end-to-end anti-double-spawn guarantee (the partial unique index
 * idx_gh_proposals_active_item: ≤1 ACTIVE proposal per card, terminal rows
 * free the card for re-triggers) + the autoSpawn status transitions with the
 * actual ON CONFLICT semantics — not a mock's stand-in.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "../../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";

// Route db/connection at the real PGlite test DB BEFORE importing anything that
// touches it (the query layer the daemon + queries use).
mockDbConnection();

const { GithubProjectsDaemon } = await import("../daemon");
const {
  listProposalsByProject,
  getProposalById,
  updateProposal,
} = await import("../../../db/queries/github-projects");
const { projects, githubProjectsLinks, githubProjectsProposals, conversations } = await import("../../../db/schema");

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(githubProjectsProposals);
  await db.delete(githubProjectsLinks);
  await db.delete(projects);
  await db.insert(projects).values({ id: "proj-int", name: "Int", path: "/tmp/int" } as never);
});

function makeItem(updatedAt = "2026-06-01T00:00:00Z") {
  return {
    itemNodeId: "item-A",
    contentNodeId: "content-A",
    title: "Integration ticket",
    url: "https://github.com/x/9",
    statusOptionId: "opt-doing",
    statusName: "Doing",
    updatedAt,
  };
}

/** Inject a client whose fetchBoardItems returns a fixed page. */
function clientReturning(page: { items: unknown[]; cursor: Record<string, string> }) {
  return { fetchBoardItems: () => Promise.resolve(page) } as never;
}

async function insertLink(over: Partial<{ columnActionMap: unknown; pollCursor: unknown }> = {}) {
  const db = getTestDb();
  const rows = await db.insert(githubProjectsLinks).values({
    id: "link-int",
    projectId: "proj-int",
    boardNodeId: "PVT_int",
    boardUrl: "https://github.com/orgs/x/projects/1",
    authMode: "gh", // gh mode → resolved via injected ghAuthToken (no PAT/decrypt)
    columnActionMap: over.columnActionMap ?? { "opt-doing": { action: "plan", autoSpawn: false } },
    pollCursor: (over.pollCursor as never) ?? null,
    pollIntervalSec: 60,
    enabled: true,
  } as never).returning();
  return rows[0] as { id: string };
}

describe("GithubProjectsDaemon — integration (real PGlite)", () => {
  test("two polls over the same UNCHANGED trigger create exactly ONE proposal (ON CONFLICT)", async () => {
    await insertLink();
    const page = { items: [makeItem()], cursor: { "item-A": "2026-06-01T00:00:00Z" } };
    const d = new GithubProjectsDaemon({
      client: clientReturning(page),
      ghAuthToken: () => Promise.resolve("gho_int"),
    });

    await d.pollOnce();
    // Re-poll the same board state. The cursor was persisted so the item is no
    // longer "newly seen"; even if it were, the pending proposal holds the
    // single-active-per-card index + ON CONFLICT collapses the second insert.
    await d.pollOnce();

    const proposals = await listProposalsByProject("proj-int");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.dedupeKey).toBe("proj-int:item-A:opt-doing:plan");
    expect(proposals[0]!.status).toBe("pending");
  });

  test("even when the cursor is cleared, the active-proposal guard prevents a duplicate", async () => {
    await insertLink();
    const d = new GithubProjectsDaemon({
      client: clientReturning({ items: [makeItem()], cursor: {} }), // empty cursor each time
      ghAuthToken: () => Promise.resolve("gho_int"),
    });
    await d.pollOnce();
    // The persisted cursor is {} (the client returns an empty cursor), so the
    // item looks "new" again next sweep — yet the pending proposal occupies
    // the (link_id, item_node_id) active slot and ON CONFLICT yields ONE row.
    await d.pollOnce();
    await d.pollOnce();
    const proposals = await listProposalsByProject("proj-int");
    expect(proposals).toHaveLength(1);
  });

  test("full re-entry cycle: trigger → terminal run → card moves back (updatedAt bump) → a NEW proposal", async () => {
    await insertLink();
    // Injectable clock + mutable page: pollOnce persists lastPolledAt, so the
    // second sweep must advance past pollIntervalSec to be due again.
    let nowMs = Date.UTC(2026, 5, 1, 12, 0, 0);
    let page = { items: [makeItem("2026-06-01T00:00:00Z")], cursor: { "item-A": "2026-06-01T00:00:00Z" } };
    const d = new GithubProjectsDaemon({
      client: { fetchBoardItems: () => Promise.resolve(page) } as never,
      ghAuthToken: () => Promise.resolve("gho_int"),
      now: () => nowMs,
    });

    // Poll 1: the card is newly in a mapped column → one pending proposal.
    await d.pollOnce();
    const first = (await listProposalsByProject("proj-int"))[0]!;
    expect(first.status).toBe("pending");

    // The run finishes (terminal) → the card's active slot is freed.
    await updateProposal(first.id, { status: "done", finishedAt: new Date() });

    // The card is moved OUT and back INTO the triggering column: GitHub bumps
    // updatedAt past the stored high-water mark, so detectTrigger re-fires.
    page = { items: [makeItem("2026-06-02T00:00:00Z")], cursor: { "item-A": "2026-06-02T00:00:00Z" } };
    nowMs += 120_000; // past pollIntervalSec (60s) → link due again
    await d.pollOnce();

    const proposals = await listProposalsByProject("proj-int");
    expect(proposals).toHaveLength(2);
    const fresh = proposals.find((p) => p.id !== first.id)!;
    expect(fresh.status).toBe("pending");
    expect((await getProposalById(first.id))!.status).toBe("done"); // history intact
    // Same card, same column, same action → the IDENTICAL provenance
    // dedupeKey on both rows — proof the once-ever unique is really gone.
    expect(fresh.dedupeKey).toBe(first.dedupeKey);
    expect(fresh.dedupeKey).toBe("proj-int:item-A:opt-doing:plan");
  });

  test("active-run cycle: a card bumped while its proposal is still active gains NO duplicate", async () => {
    await insertLink();
    let nowMs = Date.UTC(2026, 5, 1, 12, 0, 0);
    let page = { items: [makeItem("2026-06-01T00:00:00Z")], cursor: { "item-A": "2026-06-01T00:00:00Z" } };
    const d = new GithubProjectsDaemon({
      client: { fetchBoardItems: () => Promise.resolve(page) } as never,
      ghAuthToken: () => Promise.resolve("gho_int"),
      now: () => nowMs,
    });

    await d.pollOnce();
    const first = (await listProposalsByProject("proj-int"))[0]!;
    // The spawned run is mid-flight when the card churns (edit/comment/move
    // back) — detectTrigger re-fires on the updatedAt bump, but the running
    // proposal still owns the card's active slot.
    await updateProposal(first.id, { status: "running" });

    page = { items: [makeItem("2026-06-02T00:00:00Z")], cursor: { "item-A": "2026-06-02T00:00:00Z" } };
    nowMs += 120_000;
    await d.pollOnce();

    const proposals = await listProposalsByProject("proj-int");
    expect(proposals).toHaveLength(1); // no duplicate — ON CONFLICT swallowed it
    expect(proposals[0]!.id).toBe(first.id);
    expect(proposals[0]!.status).toBe("running"); // untouched by the lost insert
  });

  test("autoSpawn path transitions the proposal pending → spawned → done", async () => {
    await insertLink({
      columnActionMap: { "opt-doing": { action: "execute", autoSpawn: true } },
    });

    // A real conversation row to satisfy the proposals.conversation_id FK.
    const db = getTestDb();
    await db.insert(conversations).values({ id: "conv-int", projectId: "proj-int" } as never);

    // A fake spawn bridge that uses the REAL updateProposal to move the row
    // through the lifecycle, then completes it (stands in for the executor).
    const approve = async (proposalId: string, _actor: unknown) => {
      await updateProposal(proposalId, { status: "spawned", agentRunId: "run-int", conversationId: "conv-int" });
      const running = await updateProposal(proposalId, { status: "running" });
      await updateProposal(proposalId, { status: "done", finishedAt: new Date() });
      return running;
    };

    const d = new GithubProjectsDaemon({
      client: clientReturning({ items: [makeItem()], cursor: { "item-A": "2026-06-01T00:00:00Z" } }),
      ghAuthToken: () => Promise.resolve("gho_int"),
      approve,
    });
    await d.pollOnce();

    const proposals = await listProposalsByProject("proj-int");
    expect(proposals).toHaveLength(1);
    const final = await getProposalById(proposals[0]!.id);
    expect(final!.status).toBe("done");
    expect(final!.agentRunId).toBe("run-int");
    expect(final!.conversationId).toBe("conv-int");
    expect(final!.finishedAt).toBeInstanceOf(Date);
  });

  test("the persisted poll cursor + lastPolledAt advance after a clean sweep", async () => {
    await insertLink();
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    const d = new GithubProjectsDaemon({
      client: clientReturning({ items: [makeItem()], cursor: { "item-A": "2026-06-01T00:00:00Z" } }),
      ghAuthToken: () => Promise.resolve("gho_int"),
      now: () => now,
    });
    await d.pollOnce();
    const db = getTestDb();
    const rows = await db.select().from(githubProjectsLinks);
    const link = rows[0] as { pollCursor: Record<string, string> | null; lastPolledAt: Date | null; lastError: string | null };
    expect(link.pollCursor).toEqual({ "item-A": "2026-06-01T00:00:00Z" });
    expect(link.lastPolledAt).toBeInstanceOf(Date);
    expect(link.lastError).toBeNull();
  });
});

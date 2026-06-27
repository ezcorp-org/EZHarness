/**
 * Integration test for GithubProjectsDaemon against a REAL PGlite DB.
 *
 * Only the GitHub client is mocked (injected). The DB query layer
 * (listEnabledLinks / insertProposalIfNew / updateLinkPollState / updateProposal)
 * runs for real against a migrated PGlite instance, so this proves the
 * end-to-end anti-double-spawn guarantee + the autoSpawn status transitions
 * with the actual ON CONFLICT semantics — not a mock's stand-in.
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
    // longer "newly seen"; even if it were, the UNIQUE(dedupe_key) + ON CONFLICT
    // collapses the second insert.
    await d.pollOnce();

    const proposals = await listProposalsByProject("proj-int");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.dedupeKey).toBe("proj-int:item-A:opt-doing:plan");
    expect(proposals[0]!.status).toBe("pending");
  });

  test("even when the cursor is cleared, the dedupeKey prevents a duplicate", async () => {
    await insertLink();
    const d = new GithubProjectsDaemon({
      client: clientReturning({ items: [makeItem()], cursor: {} }), // empty cursor each time
      ghAuthToken: () => Promise.resolve("gho_int"),
    });
    await d.pollOnce();
    // The persisted cursor is {} (the client returns an empty cursor), so the
    // item looks "new" again next sweep — yet ON CONFLICT still yields ONE row.
    await d.pollOnce();
    await d.pollOnce();
    const proposals = await listProposalsByProject("proj-int");
    expect(proposals).toHaveLength(1);
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

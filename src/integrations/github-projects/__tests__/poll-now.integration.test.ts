/**
 * Integration test: the Hub "Poll now" path end to end against a REAL PGlite
 * database, with ONLY the GitHub client mocked.
 *
 * Proves the manual-trigger contract: a link whose `lastPolledAt` is recent
 * (so the 30s wake loop would SKIP it as not-due) is nonetheless polled
 * immediately when the user clicks "Poll now". The handler's `"poll-now"` verb
 * resolves+owns the link, then drives the REAL `getGithubProjectsDaemon()`
 * singleton's `pollProjectNow(projectId)`, which bypasses the due-check and runs
 * the full poll body (auth → fetch → diff → propose → persist) against the real
 * query layer + real secrets store. We assert a `pending` proposal row landed in
 * the DB — concrete proof the forced poll did real work despite the link not
 * being due.
 *
 * Mirrors `web-connect-flow.integration.test.ts`'s setup. The `*.integration`
 * name keeps this in `scripts/test.sh` (correctness) but OUT of the coverage
 * leg (which loads several real modules with a different DA line-set — the bun
 * attribution drift the coverage globs already exclude).
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../../__tests__/helpers/test-pglite";
import { extensions } from "../../../db/schema";
import { sql } from "drizzle-orm";

// Real DB-backed connection for every query module (queries + secrets store).
mockDbConnection();

// In-file restore pattern (mock-cleanup-coverage): `../client` + `../bus-registry`
// are NOT in mock-cleanup's MODULE_PATHS, so snapshot the REAL exports BEFORE
// stubbing and re-register them in afterAll — otherwise these stubs leak into the
// sibling github-projects integration files (which mock `../client` with a
// different shape) when several integration suites share one bun process.
const REAL_CLIENT = { ...(await import("../client")) };
const REAL_BUS = { ...(await import("../bus-registry")) };

// Mock ONLY the GitHub client (the single egress). One board item sits in a
// MAPPED column ("opt-doing"), so the poll detects a trigger and proposes.
mock.module("../client", () => ({
  createGithubClient: () => ({
    fetchBoardItems: async () => ({
      items: [
        {
          itemNodeId: "PVTI_item1",
          contentNodeId: "I_issue1",
          title: "Fix the login bug",
          url: "https://github.com/acme/repo/issues/7",
          statusOptionId: "opt-doing",
          statusName: "Doing",
          updatedAt: "2026-06-27T12:00:00Z",
        },
      ],
      cursor: { PVTI_item1: "2026-06-27T12:00:00Z" },
    }),
  }),
}));

// No web bus in this src-side test — emit is a no-op fallback.
mock.module("../bus-registry", () => ({
  getGithubProjectsEmit: () => undefined,
}));

// Real modules (DB-backed via mockDbConnection).
const { createProject } = await import("../../../db/queries/projects");
const { createUser } = await import("../../../db/queries/users");
const { setSecret } = await import("../../../extensions/secrets-store");
const { upsertLink, getLinkByProjectId, listProposalsByProject } = await import(
  "../../../db/queries/github-projects"
);
const { _resetGithubProjectsDaemonForTests } = await import("../daemon");
// Deny-by-default extension RBAC: poll-now requires `use` — seed a real grant.
const { upsertGrant } = await import("../../../db/queries/extension-rbac");
// The handler is the entry point the Hub button reverse-RPCs into.
const { handleGithubProjectsRpc } = await import("../../../extensions/github-projects-handler");
const { GITHUB_PROJECTS_RPC_PREFIX } = await import("../types");

afterAll(async () => {
  _resetGithubProjectsDaemonForTests();
  await closeTestDb();
  // Re-register the REAL github-projects modules so their stubs don't leak into
  // subsequent integration test files (the in-file restore pattern).
  mock.module("../client", () => REAL_CLIENT);
  mock.module("../bus-registry", () => REAL_BUS);
  restoreModuleMocks();
});

const GH_EXT = "github-projects";
const USER = { id: "user-poll-1", email: "poll@test.local", name: "Poller", role: "member" as const };

function pollNowReq(linkId: string) {
  return {
    jsonrpc: "2.0" as const,
    id: 1,
    method: `${GITHUB_PROJECTS_RPC_PREFIX}poll-now`,
    params: { linkId },
  };
}

function ctx() {
  return {
    extensionName: GH_EXT,
    extensionId: "ext-gp",
    userId: USER.id,
    conversationId: "conv-1",
    grantedPermissions: { grantedAt: {} },
  };
}

let projectId: string;

beforeEach(async () => {
  await setupTestDb();
  _resetGithubProjectsDaemonForTests();
  // The link's created_by_user_id FKs users.id — seed the acting user.
  await createUser({
    id: USER.id,
    email: USER.email,
    passwordHash: "x",
    name: USER.name,
    role: USER.role,
  });
  // `extension_secrets.extension_id` FKs `extensions.name` — seed the bundled
  // github-projects extension row so the PAT store's INSERT has its FK parent.
  await getTestDb()
    .insert(extensions)
    .values({
      name: GH_EXT,
      version: "1.0.0",
      source: "test:fixture",
      manifest: sql`${JSON.stringify({
        schemaVersion: 2,
        name: GH_EXT,
        version: "1.0.0",
        description: "",
        author: { name: "test" },
        kind: "subprocess",
        entrypoint: { command: ["true"] },
      })}::jsonb`,
    });
  // Deny-by-default RBAC: the member needs `use` for the poll-now verb (an
  // all-projects / all-extensions row — NULL coordinates, no FK parents).
  await upsertGrant({
    userId: USER.id,
    projectId: null,
    extensionId: null,
    scopes: ["use"],
    grantedByUserId: null,
  });
  const proj = await createProject({ name: "Poll Project", path: "/tmp/poll" });
  projectId = proj.id;
  // Store the PAT (real, encrypted) so the daemon's auth resolution succeeds.
  await setSecret(GH_EXT, projectId, "apiToken", "ghp_polltoken");
});

describe("github-projects poll-now (real DB)", () => {
  test("forces a poll of a NOT-due link and creates a pending proposal", async () => {
    // ENABLED link, mapping "opt-doing" → a plan (no auto-spawn). lastPolledAt
    // is RECENT (now) with the default 60s interval, so the wake loop would
    // SKIP this link as not-due — the only way it gets polled is "Poll now".
    const link = await upsertLink({
      projectId,
      boardNodeId: "PVT_board",
      boardUrl: "https://github.com/orgs/acme/projects/1",
      boardTitle: "Roadmap",
      ownerLogin: "acme",
      authMode: "pat",
      enabled: true,
      columnActionMap: { "opt-doing": { action: "plan", autoSpawn: false } },
      pollIntervalSec: 60,
      createdByUserId: USER.id,
    });
    // Stamp lastPolledAt = now so the link is unambiguously NOT due.
    await getLinkByProjectId(projectId); // sanity: link is readable
    await getTestDb().execute(
      sql`UPDATE github_projects_links SET last_polled_at = now() WHERE id = ${link.id}`,
    );

    // No proposals yet.
    expect(await listProposalsByProject(projectId)).toHaveLength(0);

    // Drive the Hub "Poll now" verb → real daemon.pollProjectNow against the
    // real DB + mocked client.
    const res = await handleGithubProjectsRpc("poll-now", pollNowReq(link.id), ctx());

    expect("result" in res).toBe(true);
    const result = (res as { result: { ok: boolean; polled: boolean } }).result;
    expect(result.ok).toBe(true);
    expect(result.polled).toBe(true);

    // The forced poll did real work: a pending proposal for the triggering item.
    const proposals = await listProposalsByProject(projectId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.itemNodeId).toBe("PVTI_item1");
    expect(proposals[0]!.statusOptionId).toBe("opt-doing");
    expect(proposals[0]!.action).toBe("plan");
    expect(proposals[0]!.status).toBe("pending");
  });
});

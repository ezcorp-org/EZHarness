import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFirstPartyRelease, seedFirstPartyGit } from "../../../__tests__/helpers/first-party-release";
import { closeTestDb, mockDbConnection, setupTestDb } from "../../../__tests__/helpers/test-pglite";

mockDbConnection();
afterAll(closeTestDb);

test("isolated manual trigger reads real git, spawns once and retains the deferred cursor", async () => {
  await setupTestDb();
  const root = await mkdtemp(join(tmpdir(), "docs-release-project-"));
  const release = await buildFirstPartyRelease("docs-updater");
  const spawns: Record<string, unknown>[] = [];
  const session = await release.session({
    projectRoot: root,
    settings: { enabled: true, repo_path: "/project", agent_name: "coder", write_paths: "README.md,docs/", auto_merge: false },
    async handler(request) {
      if (request.method !== "ezcorp/spawn-assignment") return;
      spawns.push(request.params ?? {});
      return { jsonrpc: "2.0", id: request.id, result: { v: 1, subConversationId: "sub-e2e", agentRunId: "agent-run-e2e", taskId: "task-e2e", assignmentId: "assign-e2e" } };
    },
  });
  try {
    await seedFirstPartyGit(root);
    const first = await session.tool("run_docs_update", {});
    expect({ first, failures: session.failures }).toMatchObject({ first: { isError: false } });
    const body = JSON.parse(first.content[0]?.text ?? "{}");
    expect(body.skipped).toBeUndefined();
    expect(body.status).toBe("drafting");
    expect(body.runId).toBe("agent-run-e2e");
    expect(spawns).toHaveLength(1);
    expect(String(spawns[0]?.task)).toContain("update the project documentation");
    expect(await session.storage("loop:docs-updater:index")).toEqual(["agent-run-e2e"]);
    expect(await session.storage("loop:docs-updater:run:agent-run-e2e")).toMatchObject({ status: "drafting" });
    expect(await session.storage("loop:docs-updater:cursor")).toMatch(/^[0-9a-f]{40}$/);
    const second = await session.tool("run_docs_update", {});
    expect(second).toMatchObject({ isError: false });
    expect(JSON.parse(second.content[0]?.text ?? "{}")).toMatchObject({ skipped: true, reason: "no_new_commits" });
    expect(spawns).toHaveLength(1);
    expect(await session.storage("loop:docs-updater:index")).toEqual(["agent-run-e2e"]);
  } finally { await session.close(); await release.close(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

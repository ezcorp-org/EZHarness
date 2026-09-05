import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFirstPartyRelease, seedFirstPartyGit } from "../../../__tests__/helpers/first-party-release";
import { closeTestDb, mockDbConnection, setupTestDb } from "../../../__tests__/helpers/test-pglite";

mockDbConnection();
afterAll(closeTestDb);

test("isolated git check appends and persists once, then declines the unchanged commit", async () => {
  await setupTestDb();
  const root = await mkdtemp(join(tmpdir(), "repo-release-project-"));
  const release = await buildFirstPartyRelease("repo-activity-notify");
  const appends: Record<string, unknown>[] = [];
  const session = await release.session({
    projectRoot: root,
    settings: { enabled: true, conversation_id: "conv-e2e", repo_path: "/project" },
    async handler(request) {
      if (request.method === "ezcorp/append-message") {
        appends.push(request.params ?? {});
        return { jsonrpc: "2.0", id: request.id, result: { messageId: `message-${appends.length}`, toolCallIds: [] } };
      }
      if (request.method === "ezcorp/invoke" && request.params?.tool === "runtime.conversations.getMessages") return { jsonrpc: "2.0", id: request.id, result: { messages: [{ id: "seed-msg", role: "user", content: "watch the repo" }], projectId: "project" } };
    },
  });
  try {
    await seedFirstPartyGit(root);
    const first = await session.tool("check_repo_activity", {});
    expect({ first, failures: session.failures }).toMatchObject({ first: { isError: false } });
    const body = JSON.parse(first.content[0]?.text ?? "{}");
    expect(body.skipped).toBeUndefined();
    expect(body.status).toBe("done");
    const ids = await session.storage("loop:repo-activity-notify:index") as string[];
    expect(ids).toHaveLength(1);
    expect(await session.storage(`loop:repo-activity-notify:run:${ids[0]}`)).toMatchObject({ status: "done", outcome: { appended: true, subject: "feat: seed the probe repo" } });
    expect(await session.storage("loop:repo-activity-notify:cursor")).toMatch(/^[0-9a-f]{40}$/);
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ conversationId: "conv-e2e", parentMessageId: "seed-msg", role: "extension" });
    expect(String(appends[0]?.content)).toContain("new commit");
    expect(session.failures).toEqual([]);
    expect(await readFile(join(session.dataRoot, "loops", "repo-activity-notify", "notices", `${ids[0]}.md`), "utf8")).toContain("new commit");
    const second = await session.tool("check_repo_activity", {});
    expect(JSON.parse(second.content[0]?.text ?? "{}")).toMatchObject({ skipped: true, reason: "no_new_commits" });
    expect(await session.storage("loop:repo-activity-notify:index")).toEqual(ids);
    expect(appends).toHaveLength(1);
  } finally { await session.close(); await release.close(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

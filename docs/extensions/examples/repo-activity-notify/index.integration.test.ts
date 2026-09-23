// @ezcorp-host-integration
import { afterAll, afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFirstPartyRelease, seedFirstPartyGit } from "../../../../src/__tests__/helpers/first-party-release";
import { closeTestDb, mockDbConnection, setupTestDb } from "../../../../src/__tests__/helpers/test-pglite";

mockDbConnection();
let release: Awaited<ReturnType<typeof buildFirstPartyRelease>> | undefined;
let activeSessionCleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await activeSessionCleanup?.(); });
afterAll(async () => { await release?.close(); await closeTestDb(); });

async function setupRepoActivitySession(denyProjectGit = false) {
  await setupTestDb();
  const root = await mkdtemp(join(tmpdir(), "repo-release-project-"));
  let ownedSession: { close(): Promise<void> } | undefined;
  let expired = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    if (activeSessionCleanup === cleanup) activeSessionCleanup = undefined;
    expired = true;
    cleanupPromise = (async () => { try { await ownedSession?.close(); } finally { await rm(root, { recursive: true, force: true }); } })();
    return cleanupPromise;
  };
  activeSessionCleanup = cleanup;
  release ??= await buildFirstPartyRelease("repo-activity-notify");
  if (expired) throw new Error("Repo activity fixture was closed during release build");
  const appends: Record<string, unknown>[] = [];
  let denyGit = denyProjectGit;
  const session = await release.session({
    projectRoot: root,
    settings: { enabled: true, conversation_id: "conv-e2e", repo_path: "/project" },
    async handler(request) {
      if (request.method === "ezcorp/project.gitHead" && denyGit) {
        return { jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "Project Git access was not approved" } };
      }
      if (request.method === "ezcorp/append-message") {
        appends.push(request.params ?? {});
        return { jsonrpc: "2.0", id: request.id, result: { messageId: `message-${appends.length}`, toolCallIds: [] } };
      }
      if (request.method === "ezcorp/invoke" && request.params?.tool === "runtime.conversations.getMessages") return { jsonrpc: "2.0", id: request.id, result: { messages: [{ id: "seed-msg", role: "user", content: "watch the repo" }], projectId: "project" } };
    },
  });
  if (expired) { await session.close(); throw new Error("Repo activity fixture was closed during session setup"); }
  ownedSession = session;
  await seedFirstPartyGit(root);
  return {
    appends,
    session,
    allowProjectGit() { denyGit = false; },
    close: cleanup,
  };
}

test("Git seed does not change the repository that invoked a hook", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repo-seed-hook-"));
  const host = join(directory, "host");
  const seeded = join(directory, "seeded");
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { env: cleanEnv, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr);
    return stdout.trim();
  };
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("GIT_")));
  try {
    await mkdir(host);
    await git("init", "-q", host);
    await git("-C", host, "config", "user.email", "host@example.test");
    await git("-C", host, "config", "user.name", "Host");
    await writeFile(join(host, "README.md"), "host\n");
    await git("-C", host, "add", "README.md");
    await git("-C", host, "commit", "-q", "-m", "host commit");
    const config = await readFile(join(host, ".git", "config"));
    const index = await readFile(join(host, ".git", "index"));
    const refs = await git("-C", host, "show-ref", "--head");
    process.env.GIT_DIR = join(host, ".git");
    process.env.GIT_WORK_TREE = host;
    process.env.GIT_INDEX_FILE = join(host, ".git", "index");
    await seedFirstPartyGit(seeded);
    expect(await git("-C", seeded, "rev-parse", "--show-toplevel")).toBe(seeded);
    expect(await readFile(join(host, ".git", "config"))).toEqual(config);
    expect(await readFile(join(host, ".git", "index"))).toEqual(index);
    expect(await git("-C", host, "show-ref", "--head")).toBe(refs);
  } finally {
    for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
    Object.assign(process.env, inherited);
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolated git check appends and persists once, then declines the unchanged commit", async () => {
  const fixture = await setupRepoActivitySession();
  const { appends, session } = fixture;
  try {
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
  } finally { await fixture.close(); }
}, 120_000);

test("project Git denial has no effects and the same release recovers", async () => {
  const fixture = await setupRepoActivitySession(true);
  const { appends, session } = fixture;
  try {
    const denied = await session.tool("check_repo_activity", {});
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("Host capability denied or failed");
    expect(session.failures).toContainEqual(expect.stringContaining("Project Git access was not approved"));
    expect(appends).toEqual([]);
    expect(await session.storage("loop:repo-activity-notify:cursor")).toBeUndefined();
    expect(await access(join(session.dataRoot, "loops", "repo-activity-notify", "notices")).then(() => true, () => false)).toBe(false);

    fixture.allowProjectGit();
    const recovered = await session.tool("check_repo_activity", {});
    expect(recovered.isError).toBe(false);
    expect(JSON.parse(recovered.content[0]?.text ?? "{}")).toMatchObject({ status: "done" });
    expect(appends).toHaveLength(1);
    const ids = await session.storage("loop:repo-activity-notify:index") as string[];
    expect(ids).toHaveLength(1);
    expect(await session.storage("loop:repo-activity-notify:cursor")).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(session.dataRoot, "loops", "repo-activity-notify", "notices", `${ids[0]}.md`), "utf8")).toContain("new commit");
  } finally { await fixture.close(); }
}, 120_000);

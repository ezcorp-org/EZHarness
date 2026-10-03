import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { publishFrozenDraft, reconcileFrozenDraft, type PrPublisherError, type GithubRequest } from "./publisher";
import { validateSnapshot, type SnapshotFileInput } from "./snapshot";

const baseSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const newTreeSha = "c".repeat(40);
const commitSha = "d".repeat(40);
const branch = "ez-personal/operation-1";
const repositoryName = "owner/repo";
function file(path: string, text: string): SnapshotFileInput {
  const bytes = Buffer.from(text);
  return { path, mode: "100644", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}
function gitBlob(text: string): string { const bytes = Buffer.from(text); return createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex"); }
function fixture() {
  return { token: "host-token", repositoryId: 42, repositoryName, baseRef: "main", baseSha, branch, title: "Approved change", body: "Exact frozen tree", base: validateSnapshot([file("a.txt", "old")]), current: validateSnapshot([file("a.txt", "new")]) };
}

describe("frozen GitHub publisher", () => {
  test("creates a draft from the exact base, persists commit before branch, then reconciles read only", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    let commitSaved = false;
    const request: GithubRequest = async (_token, path, method, body) => {
      calls.push({ path, method, body });
      if (path === "/repos/owner/repo") return { id: 42 };
      if (path === "/repos/owner/repo/git/ref/heads/main") return { object: { sha: baseSha } };
      if (path === `/repos/owner/repo/git/commits/${baseSha}`) return { tree: { sha: treeSha } };
      if (path === "/repos/owner/repo/git/blobs") return { sha: gitBlob("new") };
      if (path === "/repos/owner/repo/git/trees") return { sha: newTreeSha };
      if (path === "/repos/owner/repo/git/commits") return { sha: commitSha };
      if (path === "/repos/owner/repo/git/refs") { expect(commitSaved).toBe(true); return { ref: `refs/heads/${branch}` }; }
      if (path === "/repos/owner/repo/pulls" && method === "POST") return { html_url: "https://github.com/owner/repo/pull/7", number: 7, draft: true, head: { sha: commitSha, ref: branch }, base: { ref: "main" } };
      if (path === `/repos/owner/repo/git/ref/heads/${branch}`) return { object: { sha: commitSha } };
      if (path.startsWith("/repos/owner/repo/pulls?")) return [{ html_url: "https://github.com/owner/repo/pull/7", number: 7, draft: true, head: { sha: commitSha, ref: branch }, base: { ref: "main" } }];
      throw new Error(`Unexpected ${method} ${path}`);
    };
    const published = await publishFrozenDraft({ ...fixture(), onCommitReady: async sha => { expect(sha).toBe(commitSha); commitSaved = true; } }, request);
    expect(published).toEqual({ url: "https://github.com/owner/repo/pull/7", number: 7, branch, commitSha });
    expect(calls.find(call => call.path.endsWith("/git/trees"))?.body).toEqual({ base_tree: treeSha, tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: gitBlob("new") }] });
    const writeCount = calls.filter(call => call.method === "POST").length;
    expect(await reconcileFrozenDraft({ token: "host-token", repositoryId: 42, repositoryName, baseRef: "main", branch, commitSha }, request)).toEqual(published);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(writeCount);
  });

  test("rejects a changed base before any GitHub write", async () => {
    const methods: string[] = [];
    const request: GithubRequest = async (_token, path, method) => {
      methods.push(method);
      if (path === "/repos/owner/repo") return { id: 42 };
      return { object: { sha: "f".repeat(40) } };
    };
    await expect(publishFrozenDraft({ ...fixture(), onCommitReady: async () => {} }, request)).rejects.toMatchObject({ code: "base_changed" } satisfies Partial<PrPublisherError>);
    expect(methods).toEqual(["GET", "GET"]);
  });

  test("rejects changed workflow files without publishing", async () => {
    const input = fixture();
    input.current = validateSnapshot([file("a.txt", "old"), file(".github/workflows/ci.yml", "jobs: {}")]);
    let writes = 0;
    const request: GithubRequest = async (_token, path, method) => {
      if (method === "POST") writes++;
      if (path === "/repos/owner/repo") return { id: 42 };
      if (path === "/repos/owner/repo/git/ref/heads/main") return { object: { sha: baseSha } };
      return { tree: { sha: treeSha } };
    };
    await expect(publishFrozenDraft({ ...input, onCommitReady: async () => {} }, request)).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<PrPublisherError>);
    expect(writes).toBe(0);
  });
});

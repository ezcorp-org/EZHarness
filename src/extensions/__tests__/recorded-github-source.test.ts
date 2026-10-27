/** The recorded GitHub API that the real-browser e2e harness imports its pinned GitHub source from. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import recording from "../recorded-github-source.json";
import { recordedGitHubSourceFetch, recordedGitHubSourceResolveHost } from "../recorded-github-source";
import { collectGitHubSource } from "../source-import";

const COMMIT = "2fea009e0a3015d6aec73eec35bbe45555edbb7c";
const DIRECTORY = "docs/extensions/examples/harness-smoke-test";
const API = "https://140.82.112.6/repos/ezcorp-org/EZHarness";
const githubHost = { headers: { host: "api.github.com" } };

/** sha1("<type> <size>\0" + bytes) is a git object's id. */
function gitObjectId(type: string, bytes: Buffer): string {
  return createHash("sha1").update(`${type} ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** A raw git tree object's entries: "<mode> <name>\0" then the 20-byte id of each. */
function treeEntries(raw: Buffer): Map<string, { mode: string; sha: string }> {
  const entries = new Map<string, { mode: string; sha: string }>();
  for (let at = 0; at < raw.byteLength;) {
    const space = raw.indexOf(0x20, at);
    const nul = raw.indexOf(0, space);
    entries.set(raw.subarray(space + 1, nul).toString("utf8"), { mode: raw.subarray(at, space).toString("utf8"), sha: raw.subarray(nul + 1, nul + 21).toString("hex") });
    at = nul + 21;
  }
  return entries;
}

// The product trusts api.github.com over TLS and does not hash-check its answers, so this checks the recording itself
// against the pin: a changed byte anywhere (commit, tree, blob, mode, size or the pin) fails here.
test("every recorded answer is the git content of the pinned commit", async () => {
  const proof = recording.proof;
  const commitRaw = Buffer.from(proof.commit, "base64");
  expect(gitObjectId("commit", commitRaw)).toBe(COMMIT);
  const rootTree = /^tree ([0-9a-f]{40})$/m.exec(commitRaw.toString("utf8"))![1]!;
  expect(recording.commits[COMMIT as keyof typeof recording.commits]).toEqual({ sha: COMMIT, commit: { tree: { sha: rootTree } } });
  let tree = rootTree;
  for (const name of [...proof.directory.split("/"), ""]) {
    const raw = Buffer.from(proof.trees[tree as keyof typeof proof.trees]!, "base64");
    expect(gitObjectId("tree", raw)).toBe(tree);
    if (!name) {
      const answered = recording.trees[rootTree as keyof typeof recording.trees]!.tree;
      expect(answered.map((entry) => [entry.path, entry.mode, entry.sha])).toEqual(
        [...treeEntries(raw)].map(([file, entry]) => [`${proof.directory}/${file}`, entry.mode, entry.sha]),
      );
      for (const entry of answered) {
        const bytes = Buffer.from(recording.blobs[entry.sha as keyof typeof recording.blobs]!, "base64");
        expect(bytes.byteLength).toBe(entry.size);
        expect(gitObjectId("blob", bytes)).toBe(entry.sha);
      }
      break;
    }
    const next = treeEntries(raw).get(name);
    expect(next?.mode).toBe("40000");
    tree = next!.sha;
  }
  // The e2e spec pins the same commit and directory, so the spec and the recording cannot drift apart.
  const spec = await Bun.file(new URL("../../../web/e2e/real-auth/extension-source-import.spec.ts", import.meta.url)).text();
  expect(spec).toContain(`fill("${COMMIT}")`);
  expect(spec).toContain(`fill("${DIRECTORY}")`);
});

test("the real collector imports the pinned commit from the recording through the egress guard", async () => {
  const files = await collectGitHubSource({ kind: "github", repository: "ezcorp-org/EZHarness", ref: COMMIT, directory: DIRECTORY }, {
    fetch: recordedGitHubSourceFetch as typeof fetch,
    resolveHost: recordedGitHubSourceResolveHost,
  });
  expect(Object.keys(files).sort()).toEqual(["README.md", "extension.test.ts", "extension.ts", "ezcorp.config.ts", "index.test.ts", "index.ts"]);
});

test("the recording resolves to a public address and answers only what it holds, as GitHub's 404 otherwise", async () => {
  expect(await recordedGitHubSourceResolveHost("api.github.com")).toEqual(["140.82.112.6"]);
  const commit = await recordedGitHubSourceFetch(`${API}/commits/${COMMIT}`, githubHost);
  expect(commit.status).toBe(200);
  const treeSha = ((await commit.json()) as { commit: { tree: { sha: string } } }).commit.tree.sha;
  expect((await recordedGitHubSourceFetch(`${API}/git/trees/${treeSha}?recursive=1`, githubHost)).status).toBe(200);
  for (const url of [
    `${API}/commits/main`,
    `${API}/git/trees/${"0".repeat(40)}`,
    `${API}/git/blobs/${"0".repeat(40)}`,
    `${API}/contents/README.md`,
    `https://140.82.112.6/repos/other/repository/commits/${COMMIT}`,
  ]) {
    const response = await recordedGitHubSourceFetch(url, githubHost);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Not Found" });
  }
  expect((await recordedGitHubSourceFetch(`${API}/commits/${COMMIT}`, { headers: { host: "example.com" } })).status).toBe(404);
});

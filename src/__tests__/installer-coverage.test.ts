/** Source admission coverage for v4 local and GitHub staging. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { link, symlink, writeFile } from "node:fs/promises";
import {
  createInstallerV4SourceTree,
  githubFetchFixture,
  resetInstallerV4SourceFixture,
  restoreInstallerV4SourceFixture,
  sourceActor,
  stagingCalls,
} from "./helpers/installer-v4-source-fixtures";

const { collectGitHubSource, importExtensionSource } = await import("../extensions/source-import");

function sourceFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
  return Object.assign(handler, { preconnect: globalThis.fetch.preconnect });
}

afterAll(() => restoreInstallerV4SourceFixture());
beforeEach(resetInstallerV4SourceFixture);

test("GitHub collection resolves a pinned tree through the guarded API only", async () => {
  const { calls, fetcher } = githubFetchFixture();
  const files = await collectGitHubSource(
    { kind: "github", repository: "example/extension", ref: "feature/new" },
    { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] },
  );

  expect(files["extension.ts"]).toContain("extension = 4");
  expect(calls).toHaveLength(3);
  expect(calls[0]!.url).toContain("feature%2Fnew");
  expect(calls.every((call) => call.url.startsWith("https://93.184.216.34/repos/example/extension/") && new Headers(call.init?.headers).get("host") === "api.github.com" && call.init?.redirect === "manual")).toBe(true);
});

test("source collection rejects malformed identifiers, traversal, and oversized blobs", async () => {
  const { fetcher } = githubFetchFixture([{ path: "extension.ts", content: Buffer.alloc(5 * 1024 * 1024) }]);
  for (const repository of ["https://localhost/repo", "../repo", "owner/..", "./repo"]) {
    await expect(collectGitHubSource({ kind: "github", repository }, { fetch: fetcher })).rejects.toThrow("owner/repository");
  }
  for (const ref of ["..", ".", "branch/../private"]) {
    await expect(collectGitHubSource({ kind: "github", repository: "owner/repo", ref }, { fetch: fetcher })).rejects.toThrow("bounded Git");
  }
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo", directory: "../private" }, { fetch: fetcher })).rejects.toThrow("traversal");
  await expect(collectGitHubSource({ kind: "github", repository: "example/extension" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toThrow("oversized");
});

test("collection rejects a response without an immutable Git tree", async () => {
  const fetcher = sourceFetch(async () => Response.json({ commit: { tree: { sha: "not-a-tree" } } }));
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "invalid_source" });
});

test("collection refuses an incomplete Git tree before any blob download", async () => {
  const calls: string[] = [];
  const fetcher = sourceFetch(async (input) => {
    calls.push(String(input));
    return Response.json(calls.length === 1 ? { commit: { tree: { sha: "a".repeat(40) } } } : { truncated: true, tree: [] });
  });
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "source_limit" });
  expect(calls).toHaveLength(2);
  expect(calls.every((url) => !url.includes("/git/blobs/"))).toBe(true);
});

test("collection rejects malformed tree entries before fetching a blob", async () => {
  const { calls, fetcher } = githubFetchFixture([{ path: "extension.ts", mode: "100644", type: "commit" }]);
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "invalid_source" });
  expect(calls).toHaveLength(2);
});

test("collection rejects invalid blob encoding instead of storing altered source", async () => {
  let request = 0;
  const fetcher = sourceFetch(async () => {
    request += 1;
    if (request === 1) return Response.json({ commit: { tree: { sha: "a".repeat(40) } } });
    if (request === 2) return Response.json({ tree: [{ path: "extension.ts", mode: "100644", type: "blob", sha: "b".repeat(40), size: 4 }] });
    return Response.json({ encoding: "plain", content: "code" });
  });
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "invalid_source" });
  expect(request).toBe(3);
});

test("collection rejects a non-UTF-8 v4 entrypoint", async () => {
  const { fetcher } = githubFetchFixture([{ path: "extension.ts", content: Buffer.from([0xff, 0xfe]) }]);
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toThrow("Control and source files must be text");
});

test("collection excludes environment files while retaining explicit source files", async () => {
  const { fetcher } = githubFetchFixture([
    { path: ".env", content: Buffer.from("TOKEN=never-stage") },
    { path: ".env.production", content: Buffer.from("TOKEN=also-never-stage") },
    { path: "extension.ts", content: Buffer.from("export const v4 = true;") },
    { path: "src/tool.ts", content: Buffer.from("export const tool = true;") },
  ]);
  const files = await collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] });
  expect(files[".env"]).toBeUndefined();
  expect(files[".env.production"]).toBeUndefined();
  expect(files["extension.ts"]).toBe("export const v4 = true;");
  expect(files["src/tool.ts"]).toBe("export const tool = true;");
});

test("a registered project source stages through the same immutable workspace path", async () => {
  const tree = await createInstallerV4SourceTree();
  try {
    const result = await importExtensionSource(sourceActor, { kind: "local", path: tree.projectSource });
    expect(result.installation.ownerId).toBe(sourceActor.principalId);
    expect(result.workspace.id).toBe("workspace");
    expect(stagingCalls().workspace).toHaveBeenCalledTimes(1);
  } finally { await tree.cleanup(); }
});

test("a local source outside registered roots cannot create a workspace", async () => {
  const tree = await createInstallerV4SourceTree();
  try {
    await expect(importExtensionSource(sourceActor, { kind: "local", path: tree.root })).rejects.toMatchObject({ code: "forbidden" });
    expect(stagingCalls().workspace).not.toHaveBeenCalled();
  } finally { await tree.cleanup(); }
});

test("relative paths and regular files cannot become local source roots", async () => {
  const tree = await createInstallerV4SourceTree();
  try {
    await expect(importExtensionSource(sourceActor, { kind: "local", path: "relative" })).rejects.toMatchObject({ code: "invalid_source" });
    await expect(importExtensionSource(sourceActor, { kind: "local", path: `${tree.local}/extension.ts` })).rejects.toMatchObject({ code: "invalid_source" });
    expect(stagingCalls().workspace).not.toHaveBeenCalled();
  } finally { await tree.cleanup(); }
});

test("a symlink alias cannot redirect an allowed local source", async () => {
  const tree = await createInstallerV4SourceTree();
  const alias = `${tree.root}/.ezcorp/extensions/alias`;
  try {
    await symlink(tree.local, alias);
    await expect(importExtensionSource(sourceActor, { kind: "local", path: alias })).rejects.toThrow("regular source directory");
    expect(stagingCalls().workspace).not.toHaveBeenCalled();
  } finally { await tree.cleanup(); }
});

test("a hard-linked host file cannot enter a staged workspace", async () => {
  const tree = await createInstallerV4SourceTree();
  const secret = `${tree.root}/outside-source-secret`;
  const linked = `${tree.local}/linked-source.ts`;
  try {
    await writeFile(secret, "host-only-content");
    await link(secret, linked);
    await expect(importExtensionSource(sourceActor, { kind: "local", path: tree.local })).rejects.toThrow("Hard-linked");
    expect(stagingCalls().workspace).not.toHaveBeenCalled();
  } finally { await tree.cleanup(); }
});

test("an unknown bundled name cannot stage a different first-party source", async () => {
  const tree = await createInstallerV4SourceTree();
  try {
    await expect(importExtensionSource(sourceActor, { kind: "bundled", name: "missing" })).rejects.toThrow("Unknown or ambiguous");
    expect(stagingCalls().workspace).not.toHaveBeenCalled();
  } finally { await tree.cleanup(); }
});

test("a GitHub directory selector stages only the selected source subtree", async () => {
  const { fetcher } = githubFetchFixture([
    { path: "ignored/extension.ts", content: Buffer.from("export const wrong = true;") },
    { path: "selected/extension.ts", content: Buffer.from("export const selected = true;") },
    { path: "selected/nested/tool.ts", content: Buffer.from("export const tool = true;") },
  ]);
  const files = await collectGitHubSource({ kind: "github", repository: "owner/repo", directory: "selected" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] });
  expect(files["extension.ts"]).toBe("export const selected = true;");
  expect(files["nested/tool.ts"]).toBe("export const tool = true;");
  expect(files["ignored/extension.ts"]).toBeUndefined();
  expect(Object.keys(files)).toEqual(["extension.ts", "nested/tool.ts"]);
});

test("excluded repository directories cannot enter a v4 candidate snapshot", async () => {
  const { fetcher } = githubFetchFixture([
    { path: "extension.ts", content: Buffer.from("export const safe = true;") },
    { path: "node_modules/pkg/index.js", content: Buffer.from("host dependency") },
    { path: ".git/config", content: Buffer.from("remote=attacker") },
    { path: "dist/bundle.js", content: Buffer.from("compiled artifact") },
    { path: "coverage/report.json", content: Buffer.from("test output") },
    { path: "test-results/result.json", content: Buffer.from("test output") },
  ]);
  const files = await collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] });
  expect(files["extension.ts"]).toBe("export const safe = true;");
  expect(files["node_modules/pkg/index.js"]).toBeUndefined();
  expect(files[".git/config"]).toBeUndefined();
  expect(files["dist/bundle.js"]).toBeUndefined();
  expect(files["coverage/report.json"]).toBeUndefined();
  expect(files["test-results/result.json"]).toBeUndefined();
});

test("a source server HTTP failure cannot produce a partial candidate", async () => {
  const fetcher = sourceFetch(async () => new Response("not found", { status: 404 }));
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "source_fetch_failed" });
});

test("a tree entry without a bounded object ID is rejected before content fetch", async () => {
  const fetcher = sourceFetch(async (input) => {
    if (String(input).includes("/commits/")) return Response.json({ commit: { tree: { sha: "a".repeat(40) } } });
    return Response.json({ tree: [{ path: "extension.ts", mode: "100644", type: "blob", sha: "not-an-object", size: 7 }] });
  });
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "source_limit" });
});

test("a tree entry without a numeric bounded size is rejected before content fetch", async () => {
  const fetcher = sourceFetch(async (input) => {
    if (String(input).includes("/commits/")) return Response.json({ commit: { tree: { sha: "a".repeat(40) } } });
    return Response.json({ tree: [{ path: "extension.ts", mode: "100644", type: "blob", sha: "b".repeat(40), size: "seven" }] });
  });
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "source_limit" });
});

test("a source blob larger than the per-file limit is rejected from tree metadata", async () => {
  const { fetcher } = githubFetchFixture([{ path: "extension.ts", content: Buffer.alloc(4 * 1024 * 1024 + 1) }]);
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "source_limit" });
});

test("an absolute local source inside the host-owned root keeps a basename-only provenance record", async () => {
  const tree = await createInstallerV4SourceTree();
  try {
    const result = await importExtensionSource(sourceActor, { kind: "local", path: tree.local });
    const files = stagingCalls().workspace.mock.calls[0]![1].files;
    expect(result.source).toEqual({ kind: "local", name: "local" });
    expect(files["extension-source.json"]).not.toContain(tree.root);
    expect(files["extension-source.json"]).toContain('"kind": "local"');
    expect(files["extension-source.json"]).toContain('"name": "local"');
  } finally { await tree.cleanup(); }
});

test("a local source missing its v4 entrypoint cannot create a workspace", async () => {
  const tree = await createInstallerV4SourceTree();
  try {
    await writeFile(`${tree.local}/extension.ts`, "");
    await writeFile(`${tree.local}/only-config.ts`, "export const ignored = true;");
    await expect(importExtensionSource(sourceActor, { kind: "local", path: tree.local })).rejects.toThrow("Missing v4 entrypoint");
    expect(stagingCalls().workspace).not.toHaveBeenCalled();
  } finally { await tree.cleanup(); }
});

test("source staging writes host provenance even when a caller supplies a forged record", async () => {
  const { stageExtensionSourceFiles } = await import("../extensions/source-import");
  const result = await stageExtensionSourceFiles(sourceActor, { "extension.ts": "export {};", "extension-source.json": "forged" }, { kind: "skill", name: "fixture" });
  const files = stagingCalls().workspace.mock.calls[0]![1].files;
  expect(result.source).toEqual({ kind: "skill", name: "fixture" });
  expect(JSON.parse(files["extension-source.json"]!)).toEqual({ schemaVersion: 4, source: { kind: "skill", name: "fixture" } });
  expect(files["extension-source.json"]).not.toBe("forged");
});

test("a traversal file name is rejected before a workspace or build can exist", async () => {
  const { stageExtensionSourceFiles } = await import("../extensions/source-import");
  await expect(stageExtensionSourceFiles(sourceActor, { "../escape": "bad" }, { kind: "skill", name: "fixture" })).rejects.toThrow();
  expect(stagingCalls().workspace).not.toHaveBeenCalled();
  expect(stagingCalls().build).not.toHaveBeenCalled();
});

test("an unsupported Git file mode is refused before blob content is read", async () => {
  const { calls, fetcher } = githubFetchFixture([{ path: "extension.ts", mode: "100600" as "100644" }]);
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "invalid_source" });
  expect(calls).toHaveLength(2);
});

test("an invalid tree entry shape is refused before it can name a workspace file", async () => {
  const fetcher = sourceFetch(async (input) => {
    if (String(input).includes("/commits/")) return Response.json({ commit: { tree: { sha: "a".repeat(40) } } });
    return Response.json({ tree: [null] });
  });
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "invalid_source" });
});

test("a tree with more than the bounded source-file count is refused before blob fetch", async () => {
  const tree = Array.from({ length: 4097 }, (_, index) => ({ path: index === 0 ? "extension.ts" : `src/${index}.ts`, mode: "100644", type: "blob", sha: String((index % 9) + 1).repeat(40), size: 1 }));
  const calls: string[] = [];
  const fetcher = sourceFetch(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/commits/")) return Response.json({ commit: { tree: { sha: "a".repeat(40) } } });
    if (url.includes("/git/trees/")) return Response.json({ tree });
    return Response.json({ encoding: "base64", content: "eA==" });
  });
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "source_limit" });
  expect(calls).toHaveLength(4098);
});

test("a traversal tree path cannot become a workspace path", async () => {
  const { fetcher } = githubFetchFixture([
    { path: "extension.ts", content: Buffer.from("export const valid = true;") },
    { path: "../escape.ts", content: Buffer.from("export const unsafe = true;") },
  ]);
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toThrow();
});

test("an empty directory selection cannot reinterpret a repository root as a source file", async () => {
  const { fetcher } = githubFetchFixture([{ path: "nested/extension.ts", content: Buffer.from("export const onlyNested = true;") }]);
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo", directory: "nested/../" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toThrow("traversal");
});

test("a commit response without a tree cannot begin source collection", async () => {
  const fetcher = sourceFetch(async () => Response.json({ commit: {} }));
  await expect(collectGitHubSource({ kind: "github", repository: "owner/repo" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "invalid_source" });
});

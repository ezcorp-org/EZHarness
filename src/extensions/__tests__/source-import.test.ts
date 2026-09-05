import { expect, test } from "bun:test";
import { collectGitHubSource } from "../source-import";

function fixture(entry: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const data = url.includes("/commits/") ? { commit: { tree: { sha: "a".repeat(40) } } }
      : url.includes("/git/trees/") ? { truncated: false, tree: [{ path: "extension.ts", mode: "100644", type: "blob", sha: "b".repeat(40), size: 24, ...entry }] }
      : { encoding: "base64", content: Buffer.from("export const extension = 4;").toString("base64") };
    return Response.json(data);
  }) as typeof fetch;
  return { calls, fetcher };
}

test("fetches a pinned Git tree without checkout, redirects, or executable config", async () => {
  const { calls, fetcher } = fixture();
  const files = await collectGitHubSource({ kind: "github", repository: "example/extension", ref: "feature/new" }, { fetch: fetcher });
  expect(files["extension.ts"]).toContain("extension = 4");
  expect(calls).toHaveLength(3);
  expect(calls[0]!.url).toContain("feature%2Fnew");
  expect(calls.every((call) => call.url.startsWith("https://api.github.com/repos/example/extension/") && call.init?.redirect === "error")).toBe(true);
});

test("rejects links and submodules before fetching their contents", async () => {
  for (const entry of [{ mode: "120000" }, { type: "commit", mode: "160000" }]) {
    const { calls, fetcher } = fixture(entry);
    await expect(collectGitHubSource({ kind: "github", repository: "example/extension" }, { fetch: fetcher })).rejects.toThrow("links and submodules");
    expect(calls).toHaveLength(2);
  }
});

test("rejects arbitrary hosts, traversal, and oversized blobs", async () => {
  const { fetcher } = fixture({ size: 5 * 1024 * 1024 });
  await expect(collectGitHubSource({ kind: "github", repository: "https://localhost/repo" }, { fetch: fetcher })).rejects.toThrow("owner/repository");
  await expect(collectGitHubSource({ kind: "github", repository: "example/extension", directory: "../private" }, { fetch: fetcher })).rejects.toThrow("traversal");
  await expect(collectGitHubSource({ kind: "github", repository: "example/extension" }, { fetch: fetcher })).rejects.toThrow("oversized");
});

test("excludes environment files and requires a v4 entrypoint", async () => {
  const { calls, fetcher } = fixture({ path: ".env" });
  await expect(collectGitHubSource({ kind: "github", repository: "example/extension" }, { fetch: fetcher })).rejects.toThrow("v4 extension.ts");
  expect(calls).toHaveLength(2);
});

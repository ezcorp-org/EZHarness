import { expect, test } from "bun:test";
import { collectGitHubSource } from "../source-import";

test("source credentials never reach private DNS answers or a redirect destination", async () => {
  const input = { kind: "github" as const, repository: "owner/repo" };
  for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "fd00::1"]) {
    const { calls, fetcher } = fixture();
    await expect(collectGitHubSource(input, { token: "fixture-secret", fetch: fetcher, resolveHost: async () => [address] })).rejects.toMatchObject({ reason: "private-ip" });
    expect(calls).toHaveLength(0);
  }
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher = (async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
  }) as typeof fetch;
  await expect(collectGitHubSource(input, { token: "fixture-secret", fetch: fetcher, resolveHost: async () => ["93.184.216.34"] })).rejects.toMatchObject({ reason: "redirect-limit" });
  expect(calls).toEqual([{ url: "https://93.184.216.34/repos/owner/repo/commits/HEAD", authorization: "Bearer fixture-secret" }]);
});

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

test("Git source import preserves binary bytes and executable mode", async () => {
  const contents = [Buffer.from("export const extension = 4;"), Buffer.from([0, 255, 137, 80, 78, 71]), Buffer.from("#!/bin/sh\nprintf asset")];
  const entries = ["extension.ts", "assets/pixel.png", "bin/helper"].map((path, index) => ({ path, mode: index === 2 ? "100755" : "100644", type: "blob", sha: String(index + 1).repeat(40), size: contents[index]!.length }));
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/commits/")) return Response.json({ commit: { tree: { sha: "a".repeat(40) } } });
    if (url.includes("/git/trees/")) return Response.json({ tree: entries });
    const index = entries.findIndex(entry => url.endsWith(entry.sha));
    return Response.json({ encoding: "base64", content: contents[index]!.toString("base64") + "\n" });
  }) as typeof fetch;
  const files = await collectGitHubSource({ kind: "github", repository: "example/assets" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] });
  expect(files["extension.ts"]).toBe(contents[0]!.toString());
  expect(files["assets/pixel.png"]).toEqual({ encoding: "base64", data: contents[1]!.toString("base64"), executable: false });
  expect(files["bin/helper"]).toEqual({ encoding: "base64", data: contents[2]!.toString("base64"), executable: true });
});

test("fetches a pinned Git tree without checkout, redirects, or executable config", async () => {
  const { calls, fetcher } = fixture();
  const files = await collectGitHubSource({ kind: "github", repository: "example/extension", ref: "feature/new" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] });
  expect(files["extension.ts"]).toContain("extension = 4");
  expect(calls).toHaveLength(3);
  expect(calls[0]!.url).toContain("feature%2Fnew");
  expect(calls.every((call) => call.url.startsWith("https://93.184.216.34/repos/example/extension/") && new Headers(call.init?.headers).get("host") === "api.github.com" && call.init?.redirect === "manual")).toBe(true);
});

test("rejects links and submodules before fetching their contents", async () => {
  for (const entry of [{ mode: "120000" }, { type: "commit", mode: "160000" }]) {
    const { calls, fetcher } = fixture(entry);
    await expect(collectGitHubSource({ kind: "github", repository: "example/extension" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow("links and submodules");
    expect(calls).toHaveLength(2);
  }
});

test("rejects arbitrary hosts, traversal, and oversized blobs", async () => {
  const { fetcher } = fixture({ size: 5 * 1024 * 1024 });
  await expect(collectGitHubSource({ kind: "github", repository: "https://localhost/repo" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow("owner/repository");
  for (const repository of ["../repo", "owner/..", "./repo"]) await expect(collectGitHubSource({ kind: "github", repository }, { fetch: fetcher })).rejects.toThrow("owner/repository");
  for (const ref of ["..", ".", "branch/../private"]) await expect(collectGitHubSource({ kind: "github", repository: "owner/repo", ref }, { fetch: fetcher })).rejects.toThrow("bounded Git");
  await expect(collectGitHubSource({ kind: "github", repository: "example/extension", directory: "../private" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow("traversal");
  await expect(collectGitHubSource({ kind: "github", repository: "example/extension" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow("oversized");
});

test("excludes environment files and requires a v4 entrypoint", async () => {
  const { calls, fetcher } = fixture({ path: ".env" });
  await expect(collectGitHubSource({ kind: "github", repository: "example/extension" }, { fetch: fetcher, resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow("v4 extension.ts");
  expect(calls).toHaveLength(2);
});

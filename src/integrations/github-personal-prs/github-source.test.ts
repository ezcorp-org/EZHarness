import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { fetchApprovedBase, GithubSourceError, type GithubJsonTransport } from "./github-source";

function fixture(path = "src/a.txt", content = "hello", mode = "100644") {
  const bytes = Buffer.from(content);
  const sha = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
  const calls: string[] = [];
  const transport: GithubJsonTransport = async request => {
    calls.push(request);
    if (request === "/repos/example/private") return { id: 42 };
    if (request.includes("/git/ref/heads/")) return { object: { type: "commit", sha: "a".repeat(40) } };
    if (request.includes("/git/commits/")) return { tree: { sha: "b".repeat(40) } };
    if (request.includes("/git/trees/")) return { truncated: false, tree: [{ path, type: "blob", mode, size: bytes.length, sha }] };
    if (request.includes("/git/blobs/")) return { encoding: "base64", size: bytes.length, content: bytes.toString("base64") };
    throw new Error("Unexpected request");
  };
  return { transport, calls };
}

const input = { repositoryId: 42, fullName: "example/private", baseRef: "main", token: "host-only" };

describe("approved GitHub base import", () => {
  test("fetches a pinned commit and validates every blob", async () => {
    const { transport, calls } = fixture();
    const result = await fetchApprovedBase(input, transport);
    expect(result.baseSha).toBe("a".repeat(40));
    expect(result.snapshot.files.map(file => file.path)).toEqual(["src/a.txt"]);
    expect(result.snapshot.totalBytes).toBe(5);
    expect(calls).toEqual([
      "/repos/example/private",
      "/repos/example/private/git/ref/heads/main",
      `/repos/example/private/git/commits/${"a".repeat(40)}`,
      `/repos/example/private/git/trees/${"b".repeat(40)}?recursive=1`,
      `/repos/example/private/git/blobs/${createHash("sha1").update("blob 5\0hello").digest("hex")}`,
    ]);
  });

  test("rejects invalid repository, branch, special tree mode, and unsafe path", async () => {
    const good = fixture();
    await expect(fetchApprovedBase({ ...input, fullName: "other/path/more" }, good.transport)).rejects.toMatchObject({ code: "invalid_repository" });
    await expect(fetchApprovedBase({ ...input, baseRef: "../other" }, good.transport)).rejects.toMatchObject({ code: "invalid_base" });
    await expect(fetchApprovedBase(input, fixture("link", "target", "120000").transport)).rejects.toMatchObject({ code: "unsupported_repository" });
    await expect(fetchApprovedBase(input, fixture(".ezcorp/secret").transport)).rejects.toMatchObject({ code: "unsupported_repository" });
  });

  test("rejects mismatched blob and truncated tree", async () => {
    const source = fixture();
    const mismatch: GithubJsonTransport = async (request, token) => request.includes("/git/blobs/") ? { encoding: "base64", size: 5, content: Buffer.from("other").toString("base64") } : source.transport(request, token);
    await expect(fetchApprovedBase(input, mismatch)).rejects.toMatchObject({ code: "provider_unavailable" });
    const truncated: GithubJsonTransport = async (request, token) => request.includes("/git/trees/") ? { truncated: true, tree: [] } : source.transport(request, token);
    await expect(fetchApprovedBase(input, truncated)).rejects.toMatchObject({ code: "unsupported_repository" });
  });

  test("rejects unsupported file size before fetching blob", async () => {
    const source = fixture();
    const oversized: GithubJsonTransport = async (request, token) => request.includes("/git/trees/") ? { truncated: false, tree: [{ path: "big.bin", type: "blob", mode: "100644", size: 256 * 1024 + 1, sha: "c".repeat(40) }] } : source.transport(request, token);
    await expect(fetchApprovedBase(input, oversized)).rejects.toBeInstanceOf(GithubSourceError);
    expect(source.calls.some(call => call.includes("/git/blobs/"))).toBe(false);
  });
});

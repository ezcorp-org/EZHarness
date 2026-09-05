import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldWorkspace } from "@ezcorp/sdk/scaffold";
import { validateManifest, sealPublishedRelease, validatePublishedRelease, type BuildResult } from "@ezcorp/extension-contract";
import { PodmanRunner, buildLimits, filesDigest, provisionToolchain } from "@ezcorp/extension-runner";
import { computeChecksum, verifyChecksum } from "../extensions/checksum";
import { collectGitHubSource } from "../extensions/source-import";
import { snapshotExtensionSource } from "../../scripts/migrate-extension-v4";

let root: string;
let runner: PodmanRunner;
let built: Promise<BuildResult> | undefined;
const files: Record<string, string> = { ...scaffoldWorkspace({ name: "crud-extension", description: "Source lifecycle" }).files, "ezcorp.config.ts": "throw new Error('config must not execute on host');" };
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "extension-crud-v4-"));
  runner = new PodmanRunner({ root: join(root, "runner"), ...await provisionToolchain() });
  await runner.initialize();
  for (const [path, source] of Object.entries(files)) await Bun.write(join(root, "source", path), source);
}, 60000);
afterAll(async () => { await runner?.close(); if (root) await rm(root, { recursive: true, force: true }); });
function build() {
  return built ??= runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
}

describe("checksum", () => {
  test("computeChecksum returns SHA-256 hex string", async () => {
    expect(await computeChecksum(join(root, "source/extension.ts"))).toMatch(/^[a-f0-9]{64}$/);
  });
  test("verifyChecksum accepts matching file bytes", async () => {
    const path = join(root, "source/extension.ts");
    expect(await verifyChecksum(path, await computeChecksum(path))).toBe(true);
  });
  test("verifyChecksum rejects mismatched file bytes", async () => {
    expect(await verifyChecksum(join(root, "source/extension.ts"), "0".repeat(64))).toBe(false);
  });
});

describe("canonical v4 manifest validation", () => {
  const valid = { schemaVersion: 4, name: "valid-extension", version: "1.0.0", description: "Valid", author: { name: "Tests" }, entrypoint: "./extension.ts", tools: [{ name: "echo", description: "Echo", inputSchema: { type: "string" }, outputSchema: { type: "string" } }], permissions: { network: ["api.example.com"] } };
  test("accepts valid data with exact input and output schemas", () => { expect(validateManifest(valid)).toEqual({ ...valid, schemaVersion: 4 as const }); });
  test("rejects missing name", () => { const { name, ...rest } = valid; expect(() => validateManifest(rest)).toThrow(); });
  test("rejects missing version", () => { const { version, ...rest } = valid; expect(() => validateManifest(rest)).toThrow(); });
  test("a source snapshot without its runtime entrypoint cannot build", async () => {
    const files = { "README.md": "No entrypoint" };
    await expect(runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits })).rejects.toMatchObject({ code: "missing_entrypoint" });
  }, 120000);
  test("rejects a tool without a name and output contract", () => { expect(() => validateManifest({ ...valid, tools: [{ description: "Missing name", inputSchema: {} }] })).toThrow(); });
  test("rejects non-object input", () => { expect(() => validateManifest("not a manifest")).toThrow(); });
});

describe("local source collection", () => {
  test("collects nested source and builds immutable evidence without granting execution", async () => {
    const snapshot = await snapshotExtensionSource(root, { name: "crud-extension", directory: "source", entrypoint: "extension.ts" });
    expect(snapshot.files).toEqual(files);
    const result = await build();
    expect(result.diagnostics).toEqual([]);
    expect(result.state).toBe("succeeded");
    expect(result.sourceDigest).toBe(filesDigest(snapshot.files));
    expect(result.manifest?.permissions).toEqual({});
    expect(Object.hasOwn(result, "approvalId")).toBe(false);
  }, 120000);
  test("invalid discovered metadata fails the isolated build", async () => {
    const invalid = { ...files, "extension.ts": files["extension.ts"]!.replace('"schemaVersion": 4', '"schemaVersion": 2') };
    const result = await runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(invalid), files: invalid, entrypoint: "extension.ts", limits: buildLimits });
    expect(result.state).toBe("failed");
    expect(result.artifactDigest).toBeUndefined();
  }, 120000);
});

describe("GitHub immutable source and publication", () => {
  test("fetches an immutable tree and preserves every source byte", async () => {
    const entries = Object.entries(files).map(([path, source], index) => ({ path, source, sha: String(index + 1).repeat(40) }));
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/commits/")) return Response.json({ commit: { tree: { sha: "a".repeat(40) } } });
      if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: entries.map(({ path, source, sha }) => ({ path, sha, type: "blob", mode: "100644", size: Buffer.byteLength(source) })) });
      const entry = entries.find(entry => url.endsWith(entry.sha))!;
      return Response.json({ encoding: "base64", content: Buffer.from(entry.source).toString("base64") });
    }) as typeof fetch;
    const collected = await collectGitHubSource({ kind: "github", repository: "owner/repo", ref: "v1.0.0" }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] });
    expect(collected).toEqual(files);
    expect(calls.some(url => url.includes("/commits/v1.0.0"))).toBe(true);
    expect(calls.some(url => url.includes("/git/trees/" + "a".repeat(40)))).toBe(true);
    expect(filesDigest(collected)).toBe((await build()).sourceDigest);
  }, 120000);
  test("tampered published artifacts fail content-address verification", async () => {
    const result = await build();
    const artifactFiles = await runner.collectArtifacts(result.artifactDigest!);
    const published = await sealPublishedRelease(result, artifactFiles);
    expect(await validatePublishedRelease(published)).toEqual(published);
    const changed = structuredClone(published);
    changed.sourceFiles["extension.ts"] = "tampered";
    await expect(validatePublishedRelease(changed)).rejects.toThrow();
  }, 120000);
});

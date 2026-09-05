import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestObject } from "../v4/blobs";
import type { LifecycleActor } from "../v4";

let root: string;
let local: string;
let user: { id: string; role: string; status: string } | undefined;
const actor: LifecycleActor = { principalId: "admin", scope: "global", kind: "human" };
const workspace = mock(async (_actor: LifecycleActor, input: { files: Record<string, string> }) => ({ installation: { id: "installation", ownerId: _actor.principalId, enabled: false, activeReleaseId: null }, workspace: { id: "workspace", revision: 1, sourceDigest: digestObject(input.files) } }));
const build = mock(async (_actor: LifecycleActor, _input: unknown) => ({ id: "operation", state: "queued" }));
const runBuild = mock(async () => {});
mock.module("../../db/queries/users", () => ({ getUserById: async () => user }));
mock.module("../../db/queries/projects", () => ({ listProjects: async () => [{ path: join(root, "project") }] }));
mock.module("../project-root", () => ({ getProjectRoot: () => root }));
mock.module("../extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => ({ createWorkspace: workspace, build, runBuild }) }));
const { importExtensionSource, stageExtensionSourceFiles, configureGitHubSourceCredentials } = await import("../source-import");
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "source-import-staging-"));
  local = join(root, ".ezcorp/extensions/local");
  for (const path of [local, "extensions/bundled", "docs/extensions/examples", "packages/@ezcorp", "project/.ezcorp/extensions/project-source"].map((path) => path.startsWith(root) ? path : join(root, path))) await mkdir(path, { recursive: true });
  for (const path of [local, join(root, "extensions/bundled"), join(root, "project/.ezcorp/extensions/project-source")]) {
    await writeFile(join(path, "extension.ts"), "throw new Error('never execute on host')");
    await writeFile(join(path, "ezcorp.config.ts"), "throw new Error('config must remain data during collection')");
    await writeFile(join(path, ".env"), "SECRET=not-for-workspace");
  }
});
beforeEach(() => {
  user = { id: "admin", role: "admin", status: "active" };
  workspace.mockClear(); build.mockClear(); runBuild.mockClear();
  runBuild.mockImplementation(async () => {});
  configureGitHubSourceCredentials(async () => null);
  globalThis.fetch = originalFetch;
});
afterAll(async () => { globalThis.fetch = originalFetch; mock.restore(); await rm(root, { recursive: true, force: true }); });

for (const kind of ["local", "bundled"] as const) test(`${kind}: preserves complete source without evaluating metadata or enabling execution`, async () => {
  const result = await importExtensionSource(actor, kind === "local" ? { kind, path: local } : { kind, name: "bundled" });
  expect(result.installation).toMatchObject({ ownerId: "admin", enabled: false, activeReleaseId: null });
  expect(result.openUrl).toContain("workspace=workspace");
  const files = workspace.mock.calls[0]![1].files;
  expect(files["extension.ts"]).toContain("never execute");
  expect(files["ezcorp.config.ts"]).toContain("remain data");
  expect(files[".env"]).toBeUndefined();
  expect(files["extension-source.json"]).not.toContain(root);
  expect(build).toHaveBeenCalledWith(actor, { installationId: "installation", workspaceId: "workspace", expectedRevision: 1, idempotencyKey: `source-import:${digestObject(files)}` });
  expect(runBuild).toHaveBeenCalledWith(actor, "installation", "operation");
});

test("registered project source roots work without granting the rest of the host filesystem", async () => {
  await importExtensionSource(actor, { kind: "local", path: join(root, "project/.ezcorp/extensions/project-source") });
  expect(workspace).toHaveBeenCalledTimes(1);
  await expect(importExtensionSource(actor, { kind: "local", path: root })).rejects.toThrow("outside the allowed");
  expect(workspace).toHaveBeenCalledTimes(1);
});

test("relative paths, files and symlink aliases cannot become local source roots", async () => {
  const alias = join(root, ".ezcorp/extensions/alias");
  await symlink(local, alias);
  for (const path of ["relative", join(local, "extension.ts"), alias]) await expect(importExtensionSource(actor, { kind: "local", path })).rejects.toThrow("regular source directory");
  expect(workspace).not.toHaveBeenCalled();
});

test("missing or ambiguous bundled names cannot stage another extension", async () => {
  await expect(importExtensionSource(actor, { kind: "bundled", name: "missing" })).rejects.toThrow("Unknown or ambiguous");
  expect(workspace).not.toHaveBeenCalled();
});

for (const kind of ["agent", "service"] as const) test(`${kind} cannot import source even when it claims an administrator principal`, async () => {
  await expect(importExtensionSource({ ...actor, kind }, { kind: "local", path: local })).rejects.toThrow("human administrator");
  expect(workspace).not.toHaveBeenCalled();
});

for (const account of [undefined, { id: "admin", role: "admin", status: "inactive" }, { id: "admin", role: "member", status: "active" }]) test(`source staging refuses unauthorized account ${JSON.stringify(account)}`, async () => {
  user = account;
  await expect(stageExtensionSourceFiles(actor, { "extension.ts": "fixture" }, { kind: "skill", name: "fixture" })).rejects.toThrow();
  expect(workspace).not.toHaveBeenCalled();
});

test("prepared skill sources cannot inject paths or overwrite host provenance", async () => {
  await expect(stageExtensionSourceFiles(actor, { "../escape": "bad" }, { kind: "skill", name: "fixture" })).rejects.toThrow();
  expect(workspace).not.toHaveBeenCalled();
  await stageExtensionSourceFiles(actor, { "extension.ts": "fixture", "extension-source.json": "forged" }, { kind: "skill", name: "fixture" });
  expect(JSON.parse(workspace.mock.calls[0]![1].files["extension-source.json"]!)).toEqual({ schemaVersion: 4, source: { kind: "skill", name: "fixture" } });
});

test("GitHub import pins collection and uses only an explicit scoped source credential", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  configureGitHubSourceCredentials(async (identity, repository) => { expect(identity).toEqual(actor); expect(repository).toBe("owner/repo"); return "fixture-scoped-token"; });
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return Response.json(url.includes("/commits/") ? { commit: { tree: { sha: "a".repeat(40) } } } : url.includes("/git/trees/") ? { truncated: false, tree: [{ path: "extension.ts", mode: "100644", type: "blob", sha: "b".repeat(40), size: 7 }] } : { encoding: "base64", content: Buffer.from("fixture").toString("base64") });
  }) as unknown as typeof fetch;
  await importExtensionSource(actor, { kind: "github", repository: "owner/repo", ref: "main" });
  expect(seen).toHaveLength(3);
  expect(seen.every((request) => request.url.startsWith("https://api.github.com/repos/owner/repo/") && request.authorization === "Bearer fixture-scoped-token")).toBe(true);
  expect(JSON.stringify(workspace.mock.calls[0]![1].files)).not.toContain("fixture-scoped-token");
});

test("runner rejection never turns staging into implicit activation", async () => {
  runBuild.mockRejectedValueOnce(new Error("runner unavailable"));
  const result = await stageExtensionSourceFiles(actor, { "extension.ts": "fixture" }, { kind: "skill", name: "fixture" });
  await Promise.resolve();
  expect(result.operation.state).toBe("queued");
  expect(result.installation.enabled).toBe(false);
});

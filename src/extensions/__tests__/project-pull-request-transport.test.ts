import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { up } from "../../db/migrations/add-extension-project-authority";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import type { RpcHandlerDeps } from "../tool-executor/rpc-handlers";

const database = new PGlite();
const driver = drizzle(database);
const root = await mkdtemp(join(tmpdir(), "ez-project-api-"));
await database.exec("CREATE TABLE extension_release_installations(id TEXT PRIMARY KEY); INSERT INTO extension_release_installations VALUES('installation')");
await up(driver);
let bound = true;
let origin: string | null = "https://github.com/owner/repository";
let credential = true;
let httpStatus = 200;
let graphError = false;
const binding = { id: "binding", projectId: "project", ownerId: "owner", writePaths: ["docs/"] };
mock.module("../../db/connection", () => ({ getDb: () => driver }));
mock.module("../project-binding", () => ({ getExtensionProjectBinding: async () => bound ? binding : null }));
mock.module("../project-access", () => ({ authorizeProjectOperation: async () => ({ project: { id: "project", path: root } }) }));
mock.module("../project-git-broker", () => ({ readProjectGit: async () => origin }));
mock.module("../project-root", () => ({ getProjectRoot: () => tmpdir() }));
mock.module("../permission-engine", () => ({ getPermissionEngine: () => ({}) }));
mock.module("../secrets-store", () => ({ getSecret: async () => credential ? "host-only-token" : null }));
const fetcher = mock(async (_url: string, _init: RequestInit, options: { authorizeUrl?: (url: URL) => Promise<void> }) => {
  await options.authorizeUrl?.(new URL("https://api.github.com"));
  const result = graphError ? { errors: [{ message: "host-only-token" }] } : _url.includes("/files?") ? [{ filename: "docs/file.md" }] : { head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) }, node_id: "PR", state: "open", mergeable: true };
  return Response.json(result, { status: httpStatus });
});
mock.module("../../search/egress", () => ({ guardedFetch: fetcher }));
const { getProjectPullRequests, handleProjectPullRequestReview } = await import("../project-pull-request-broker");
const deps = { engine: {} } as RpcHandlerDeps;
beforeEach(async () => { bound = credential = true; origin = "https://github.com/owner/repository"; httpStatus = 200; graphError = false; fetcher.mockClear(); await database.exec("DELETE FROM extension_project_decisions"); });
afterAll(async () => { await database.close(); await rm(root, { recursive: true, force: true }); restoreModuleMocks(); });
async function invoke(input: Record<string, unknown>, actor = "installation", bindingId = "binding") {
  const token = registerCallProvenance({ actorExtensionId: "installation", onBehalfOf: "owner", conversationId: null, runId: null, parentCallId: null, kind: "event", ownerless: false, projectId: "project", projectBindingId: bindingId });
  try { return await handleProjectPullRequestReview(deps, actor, { jsonrpc: "2.0", id: "request", method: "ezcorp/project.pullRequest", params: { ...input, _meta: { ezCallId: token } } }); }
  finally { releaseCallProvenance(token); }
}

test("RPC reads and proposals use exact GitHub transport with host-only credentials", async () => {
  expect((await invoke({ action: "files", number: 42 })).result).toEqual({ files: ["docs/file.md"], unavailable: false });
  expect((await invoke({ action: "status", number: 42 })).result).toEqual({ state: "OPEN", mergeable: "MERGEABLE", unavailable: false });
  const proposed = (await invoke({ action: "propose", number: 42, merge: false, runId: "run" })).result as { proposalId: string };
  expect((await invoke({ action: "finalize", proposalId: proposed.proposalId })).result).toMatchObject({ state: "pending" });
  expect((await invoke({ action: "close", proposalId: proposed.proposalId })).result).toMatchObject({ state: "pending" });
  const [url, init, options] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.github.com/repos/owner/repository/pulls/42");
  expect(init.headers).toMatchObject({ authorization: "Bearer host-only-token" });
  expect(options).toMatchObject({ maxRedirects: 0, retryConnectionFailures: false, maxBodyBytes: 2097152, timeoutMs: 15000, allowedHosts: ["api.github.com"] });
  expect(JSON.stringify(proposed)).not.toContain("host-only-token");
  expect(getProjectPullRequests()).toBeDefined();
});

test("RPC rejects forged caller stale binding unknown methods and foreign origins", async () => {
  expect((await invoke({ action: "files", number: 42 }, "foreign")).error?.code).toBe(-32602);
  expect((await invoke({ action: "files", number: 42 }, "installation", "old")).error?.message).toContain("bind");
  expect((await invoke({ action: "shell", argv: ["rm"] })).error?.message).toContain("fixed");
  bound = false; expect((await invoke({ action: "files", number: 42 })).error?.message).toContain("bind");
  bound = true; origin = null; expect((await invoke({ action: "files", number: 42 })).error?.message).toContain("exact GitHub origin");
  expect(fetcher).not.toHaveBeenCalled();
});

test("credential absence HTTP failures and GraphQL errors stay inside host boundary", async () => {
  credential = false; expect((await invoke({ action: "files", number: 42 })).error?.message).toContain("host-owned GitHub credential");
  expect(fetcher).not.toHaveBeenCalled();
  credential = true; httpStatus = 403; expect((await invoke({ action: "files", number: 42 })).error?.message).toBe("GitHub returned HTTP 403.");
  httpStatus = 200; graphError = true; const error = (await invoke({ action: "files", number: 42 })).error;
  expect(error?.message).toBe("GitHub rejected the requested operation.");
  expect(JSON.stringify(error)).not.toContain("host-only-token");
});

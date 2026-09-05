import { afterAll, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { up } from "../../db/migrations/add-extension-project-authority";
import { ProjectPullRequests } from "../project-pull-request-broker";
import type { LifecycleActor } from "../v4/types";

const database = new PGlite();
const driver = drizzle(database);
await database.exec("CREATE TABLE extension_release_installations(id TEXT PRIMARY KEY); INSERT INTO extension_release_installations VALUES('installation')");
await up(driver);
const scope = { installationId: "installation", ownerId: "owner", projectId: "project", bindingId: "binding" };
const actor: LifecycleActor = { principalId: "owner", kind: "human", scope: "global" };
let now = 1000;
let allowed = true;
let selfProject = false;
let repository = "owner/repository";
let metadata: Record<string, unknown>;
let fileResponse: unknown;
let failWrite = false;
let mergeResult = true;
let effects: { path: string; method: string; body: unknown }[];
const service = new ProjectPullRequests({ database: driver, now: () => now, authorize: async () => {
  if (!allowed) throw new Error("revoked");
  return { repository, selfProject, writePaths: ["docs/", "README.md"] };
}, request: async (_scope, path, method = "GET", body) => {
  if (method !== "GET") {
    effects.push({ path, method, body });
    if (failWrite) throw new Error("host-only-token");
    return path.endsWith("/merge") ? { merged: mergeResult } : path === "/graphql" ? { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_id" } } } } : path.endsWith("/comments") ? { id: 1 } : { state: "closed" };
  }
  return path.includes("/files?") ? fileResponse : metadata;
} });
beforeEach(async () => {
  await database.exec("DELETE FROM extension_project_decisions");
  now = 1000; allowed = true; selfProject = false; repository = "owner/repository"; failWrite = false; mergeResult = true; effects = [];
  metadata = { head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) }, node_id: "PR_id", state: "open", draft: true, mergeable: true };
  fileResponse = [{ filename: "docs/new.md", previous_filename: "docs/old.md" }];
});
afterAll(async () => { await database.close(); });
async function propose(merge = false) { return service.propose(scope, { number: 42, merge, runId: "loop-run" }); }
async function review(merge = false) { const proposed = await propose(merge); return { proposed, record: await service.inspect(actor, proposed.proposalId) }; }

test("proposals disclose exact host-read files and never execute without human decision", async () => {
  const { proposed, record } = await review();
  expect(proposed.files).toEqual(["docs/new.md", "docs/old.md"]);
  expect(proposed.reviewUrl).toBe(`/extensions/project-proposals/${proposed.proposalId}`);
  expect(record.proposal.snapshot.head).toBe("a".repeat(40));
  expect(await service.observe(scope, proposed.proposalId, "finalize")).toMatchObject({ state: "pending" });
  await expect(service.decide({ ...actor, kind: "agent" }, proposed.proposalId, "finalize", record.proposal.snapshot.digest)).rejects.toThrow("human session");
  await expect(service.inspect({ ...actor, principalId: "other" }, proposed.proposalId)).rejects.toThrow("not found");
  await expect(service.observe({ ...scope, bindingId: "new" }, proposed.proposalId, "finalize")).rejects.toThrow("not found");
  expect(effects).toEqual([]);
});

test("human exact approval executes fixed ready comment and SHA-locked squash merge once", async () => {
  const { proposed, record } = await review(true);
  const result = await service.decide(actor, proposed.proposalId, "finalize", record.proposal.snapshot.digest);
  expect(result.state).toBe("completed");
  expect(result.proposal.result).toEqual({ marked: "merged" });
  expect(effects.map(effect => effect.path)).toEqual(["/graphql", "/repos/owner/repository/issues/42/comments", "/repos/owner/repository/pulls/42/merge"]);
  expect(effects[1]?.body).toEqual({ body: "Approved via docs-updater." });
  expect(effects[2]?.body).toEqual({ sha: "a".repeat(40), merge_method: "squash" });
  await service.decide(actor, proposed.proposalId, "finalize", record.proposal.snapshot.digest);
  expect(effects.length).toBe(3);
  expect(await service.observe(scope, proposed.proposalId, "finalize")).toMatchObject({ state: "completed", action: "finalize", result: { marked: "merged" } });
  await expect(service.observe(scope, proposed.proposalId, "close")).rejects.toThrow("different project action");
});

test("ready-only and explicit close differ from rejection with no writes", async () => {
  metadata.draft = false;
  const ready = await review();
  expect((await service.decide(actor, ready.proposed.proposalId, "finalize", ready.record.proposal.snapshot.digest)).proposal.result).toEqual({ marked: "ready" });
  expect(effects.length).toBe(1);
  const close = await review();
  expect((await service.decide(actor, close.proposed.proposalId, "close", close.record.proposal.snapshot.digest)).proposal.result).toEqual({ marked: "closed" });
  expect(effects[1]).toEqual({ path: "/repos/owner/repository/pulls/42", method: "PATCH", body: { state: "closed" } });
  const reject = await review();
  expect((await service.decide(actor, reject.proposed.proposalId, "reject", reject.record.proposal.snapshot.digest)).state).toBe("rejected");
  expect(effects.length).toBe(2);
});

test("self project merge foreign origin stale digest expired review and commit drift fail closed", async () => {
  selfProject = true; await expect(propose(true)).rejects.toThrow("manually"); selfProject = false;
  const { proposed, record } = await review();
  await expect(service.decide(actor, proposed.proposalId, "finalize", "wrong")).rejects.toThrow("stale");
  now += 86400001; await expect(service.decide(actor, proposed.proposalId, "finalize", record.proposal.snapshot.digest)).rejects.toThrow("stale"); now = 1000;
  metadata.head = { sha: "c".repeat(40) };
  await expect(service.decide(actor, proposed.proposalId, "finalize", record.proposal.snapshot.digest)).rejects.toThrow("changed after review");
  expect((await service.inspect(actor, proposed.proposalId)).state).toBe("failed");
  expect(effects).toEqual([]);
  await expect(service.decide(actor, proposed.proposalId, "finalize", record.proposal.snapshot.digest)).rejects.toThrow("already been decided");
});

test("partial writes are not replayed and host credentials never enter failure messages", async () => {
  const { proposed, record } = await review();
  failWrite = true;
  await expect(service.decide(actor, proposed.proposalId, "finalize", record.proposal.snapshot.digest)).rejects.toThrow("Verify partial effects manually");
  expect((await service.observe(scope, proposed.proposalId, "finalize")).state).toBe("failed");
  expect(JSON.stringify(await service.inspect(actor, proposed.proposalId))).not.toContain("host-only-token");
  failWrite = false;
  await expect(service.decide(actor, proposed.proposalId, "finalize", record.proposal.snapshot.digest)).rejects.toThrow("already been decided");
  expect(effects.length).toBe(1);
});

test("concurrent human decisions claim a single durable effect", async () => {
  const { proposed, record } = await review();
  const results = await Promise.allSettled([service.decide(actor, proposed.proposalId, "close", record.proposal.snapshot.digest), service.decide(actor, proposed.proposalId, "close", record.proposal.snapshot.digest)]);
  expect(results.filter(result => result.status === "fulfilled").length).toBe(1);
  expect(effects.length).toBe(1);
});

test("provider metadata paths pagination limits and closed PRs are validated", async () => {
  await expect(service.read(scope, -1)).rejects.toThrow("positive");
  await expect(service.propose(scope, { number: 1, merge: false, runId: "../bad" })).rejects.toThrow("loop run");
  metadata.state = "closed"; await expect(propose()).rejects.toThrow("open pull request"); metadata.state = "open";
  metadata.head = { sha: "bad" }; await expect(propose()).rejects.toThrow("invalid pull request"); metadata.head = { sha: "a".repeat(40) };
  fileResponse = [{ filename: "../secret" }]; await expect(propose()).rejects.toThrow("unsafe file path");
  fileResponse = {}; await expect(propose()).rejects.toThrow("invalid file metadata");
  fileResponse = Array.from({ length: 100 }, () => ({ filename: "file" })); await expect(propose()).rejects.toThrow("too many files");
  expect(effects).toEqual([]);
});

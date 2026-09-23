import { createHash } from "node:crypto";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mockDbConnection, getTestDb, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { validateSnapshot, type SnapshotFileInput } from "./snapshot";

mockDbConnection();
const owner = "personal-owner";
const other = "personal-admin";
const projectId = "personal-project";
const bindingId = "personal-binding";
const resourceId = "personal-resource";
const conversationId = "personal-chat";
const runId = "personal-run";
const baseSha = "a".repeat(40);
function file(text: string): SnapshotFileInput { const bytes = Buffer.from(text); return { path: "src/a.txt", mode: "100644", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") }; }
const base = validateSnapshot([file("old")]);
const changed = validateSnapshot([file("new")]);
type TestTransaction = Parameters<Parameters<ReturnType<typeof getTestDb>["transaction"]>[0]>[0];
let state: "pending" | "ready" = "pending";
let conversation: string | null = null;
let publishCount = 0;
let canDispatch = true;
let effectChecks = 0;
let maxEffectChecks = Number.POSITIVE_INFINITY;
let githubWrites = 0;
let baseMoved = false;
let reconcileMode: "missing" | "published" | "not_found" = "missing";
let duringExport: (() => Promise<void>) | undefined;
let statusCalls = 0;
class FakeGithubUserError extends Error { constructor(public readonly code: string) { super(code); } }
class FakePrPublisherError extends Error { constructor(public readonly code: string) { super(code); } }
const controller = {
  getProjectSandboxStatus: async (userId: string) => {
	statusCalls++;
    if (userId !== owner) throw new Error("private sandbox denied");
    return { privateOwnerOnly: true, initializationState: state, privateConversationId: conversation, bindingId,
      provider: { generation: 1 }, operation: state === "pending" ? { id: "create-op", action: "create", state: "admitted" } : null,
      resource: state === "ready" ? { resourceId, observedState: "stopped" } : null };
  },
  runPrivateWorkspaceImport: async (_userId: string, _projectId: string, _operationId: string, work: () => Promise<void>) => { await work(); state = "ready"; },
  executeAdmittedLocalSandboxOperation: async () => ({ bindingId, resource: { resourceId, observedState: "stopped" } }),
  requestSandboxAction: async () => { throw new Error("sandbox is stopped"); },
};
mock.module("../../runtime/sandbox/controller", () => ({ getSandboxController: () => controller }));
mock.module("./github-source", () => ({ fetchApprovedBase: async () => ({ repositoryId: 42, fullName: "owner/repo", baseRef: "main", baseSha, snapshot: base }) }));
mock.module("./provider-transfer", () => ({ importSnapshotToSandbox: async () => {}, exportSnapshotFromSandbox: async () => { await duringExport?.(); return changed; } }));
mock.module("../github-user/broker", () => ({
  checkRepository: async () => ({ status: "ready", repository: { id: 42, fullName: "owner/repo" } }),
  getConnectionBinding: async () => ({ githubAccountId: 17, generation: 1 }),
  assertUserEffectCurrent: async () => { if (++effectChecks > maxEffectChecks) throw new FakeGithubUserError("STALE_CONNECTION"); },
  withUserToken: async (input: { authorizeDispatch?: (tx: TestTransaction) => Promise<void> }, effect: (token: string) => Promise<unknown>) => {
    if (!canDispatch) throw new Error("connection revoked before dispatch");
    if (input.authorizeDispatch) await getTestDb().transaction(input.authorizeDispatch);
    return effect("host-token");
  },
  withUserTokenReadOnly: async (_input: unknown, effect: (token: string) => Promise<unknown>) => {
    if (reconcileMode === "not_found") throw new FakeGithubUserError("GITHUB_404");
    return effect("host-token");
  },
}));
mock.module("./publisher", () => ({
  publishFrozenDraft: async (input: { token: string; onCommitReady: (sha: string) => Promise<void>; base: typeof base; current: typeof changed }, request: (token: string, path: string, method: "GET" | "POST") => Promise<unknown>) => {
    publishCount++;
    expect(input.base.digest).toBe(base.digest);
    expect(input.current.digest).toBe(changed.digest);
    await request(input.token, "/repos/owner/repo", "GET");
    if (baseMoved) throw new FakePrPublisherError("base_changed");
    await request(input.token, "/repos/owner/repo/git/blobs", "POST");
    await request(input.token, "/repos/owner/repo/git/refs", "POST");
    await input.onCommitReady("b".repeat(40));
    return { url: "https://github.com/owner/repo/pull/7", number: 7, branch: "ez-personal/test", commitSha: "b".repeat(40) };
  },
  reconcileFrozenDraft: async () => reconcileMode === "published" ? { url: "https://github.com/owner/repo/pull/7", number: 7, branch: "ez-personal/test", commitSha: "b".repeat(40) } : null,
  PrPublisherError: FakePrPublisherError,
}));
mock.module("../github-user/transport", () => ({ githubApi: async () => { throw new Error("source mock owns GitHub wire"); }, githubApiRequest: async (_token: string, _path: string, method: string) => { if (method === "POST") githubWrites++; return {}; }, GithubUserError: FakeGithubUserError }));
const { importApprovedRepository, preparePersonalPr, getPersonalPrForReviewId, getPersonalPrForRun, confirmPersonalPr, PersonalPrError } = await import("./service");

async function seed() {
  const db = getTestDb();
  await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${owner},'owner@example.test','hash','Owner','member'),(${other},'admin@example.test','hash','Admin','admin')`);
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Private','/private')`);
  await db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('member-owner',${projectId},${owner},'owner'),('member-admin',${projectId},${other},'owner')`);
  await db.execute(sql`INSERT INTO conversations(id,project_id,title,user_id) VALUES (${conversationId},${projectId},'Owned chat',${owner})`);
  await db.execute(sql`INSERT INTO project_workspace_bindings(project_id,kind,binding_id,revision,state) VALUES (${projectId},'sandbox',${bindingId},1,'active')`);
  await db.execute(sql`INSERT INTO sandbox_provider_bindings(id,project_id,owner_id,installation_id,provider_id,release_id,release_binding,generation,config_revision,config_digest,state,private_owner_id,private_initialization_state) VALUES (${bindingId},${projectId},${owner},'install','provider','release','binding',1,1,'digest','active',${owner},'pending')`);
  await db.execute(sql`INSERT INTO sandbox_resources(id,binding_id,provider_resource_id,desired_state,observed_state,limits) VALUES ('internal-resource',${bindingId},${resourceId},'stopped','stopped','{}')`);
}

beforeEach(async () => { await setupTestDb(); state = "pending"; conversation = null; publishCount = 0; canDispatch = true; effectChecks = 0; maxEffectChecks = Number.POSITIVE_INFINITY; githubWrites = 0; baseMoved = false; reconcileMode = "missing"; duringExport = undefined; statusCalls = 0; await seed(); });

describe("personal PR service with durable database state", () => {
  test("does not touch a sandbox for an owner run without a GitHub import", async () => {
    await getTestDb().execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at) VALUES (${runId},'agent',${projectId},${conversationId},${owner},'success',NOW()-INTERVAL '1 minute',NOW())`);
    expect(await getPersonalPrForRun(owner, runId)).toEqual({ state: "no_changes", projectId });
    expect(statusCalls).toBe(0);
    await expect(getPersonalPrForRun(other, runId)).rejects.toMatchObject({ code: "not_found" });
  });
  test("imports once, binds a completed owner run and exact snapshot, confirms once, replays safely", async () => {
    const imported = await importApprovedRepository(owner, { projectId, repositoryId: 42, baseRef: "main", idempotencyKey: "same-import" });
    expect(imported.importState).toBe("ready");
    expect((await importApprovedRepository(owner, { projectId, repositoryId: 42, baseRef: "main", idempotencyKey: "same-import" })).importState).toBe("ready");
    await expect(importApprovedRepository(owner, { projectId, repositoryId: 42, baseRef: "main", idempotencyKey: "different" })).rejects.toBeInstanceOf(PersonalPrError);
    conversation = conversationId;
    await getTestDb().execute(sql`UPDATE sandbox_provider_bindings SET private_conversation_id=${conversationId},private_initialization_state='ready' WHERE id=${bindingId}`);
    await getTestDb().execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at) VALUES (${runId},'agent',${projectId},${conversationId},${owner},'success',NOW()-INTERVAL '1 minute',NOW())`);
    expect((await getPersonalPrForRun(owner, runId)).state).toBe("working");
    const ready = await preparePersonalPr(owner, { runId, title: "Review change" });
    expect(ready.state).toBe("ready");
    expect((await getPersonalPrForRun(owner, runId)).proposalId).toBe(ready.proposalId);
    expect(ready.files).toHaveLength(1);
    await expect(getPersonalPrForReviewId(other, ready.proposalId!)).rejects.toMatchObject({ code: "not_found" });
    const result = await confirmPersonalPr(owner, { proposalId: ready.proposalId!, expectedDigest: ready.digest!, title: "Edited title" });
    expect(result.state).toBe("created");
    expect(result.prUrl).toBe("https://github.com/owner/repo/pull/7");
    expect((await confirmPersonalPr(owner, { proposalId: ready.proposalId!, expectedDigest: ready.digest! })).state).toBe("created");
    expect(publishCount).toBe(1);
    expect(effectChecks).toBe(3);
    expect(githubWrites).toBe(2);
  });

  test("rejects a foreign conversation and a revoked connection before dispatch", async () => {
    await importApprovedRepository(owner, { projectId, repositoryId: 42, baseRef: "main", idempotencyKey: "same-import" });
    conversation = "other-chat";
    await getTestDb().execute(sql`INSERT INTO conversations(id,project_id,title,user_id) VALUES ('other-chat',${projectId},'Other chat',${owner})`);
    await getTestDb().execute(sql`UPDATE sandbox_provider_bindings SET private_conversation_id='other-chat',private_initialization_state='ready' WHERE id=${bindingId}`);
    await getTestDb().execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at) VALUES (${runId},'agent',${projectId},${conversationId},${owner},'success',NOW()-INTERVAL '1 minute',NOW())`);
    await expect(preparePersonalPr(owner, { runId })).rejects.toMatchObject({ code: "forbidden" });
    conversation = conversationId;
    await getTestDb().execute(sql`UPDATE sandbox_provider_bindings SET private_conversation_id=${conversationId} WHERE id=${bindingId}`);
    const ready = await preparePersonalPr(owner, { runId });
    canDispatch = false;
    await expect(confirmPersonalPr(owner, { proposalId: ready.proposalId!, expectedDigest: ready.digest! })).rejects.toMatchObject({ code: "unavailable" });
    expect(publishCount).toBe(0);
  });

  test("reconciles only the exact committed draft after an uncertain write", async () => {
    await importApprovedRepository(owner, { projectId, repositoryId: 42, baseRef: "main", idempotencyKey: "same-import" });
    conversation = conversationId;
    await getTestDb().execute(sql`UPDATE sandbox_provider_bindings SET private_conversation_id=${conversationId},private_initialization_state='ready' WHERE id=${bindingId}`);
    await getTestDb().execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at) VALUES (${runId},'agent',${projectId},${conversationId},${owner},'success',NOW()-INTERVAL '1 minute',NOW())`);
    const ready = await preparePersonalPr(owner, { runId });
    await getTestDb().execute(sql`UPDATE github_personal_pr_proposals SET state='failed',commit_sha=${"b".repeat(40)} WHERE id=${ready.proposalId}`);
    await expect(confirmPersonalPr(owner, { proposalId: ready.proposalId!, expectedDigest: ready.digest! })).rejects.toMatchObject({ code: "conflict" });
    reconcileMode = "not_found";
    await expect(confirmPersonalPr(owner, { proposalId: ready.proposalId!, expectedDigest: ready.digest! })).rejects.toMatchObject({ code: "conflict" });
    reconcileMode = "published";
    expect((await confirmPersonalPr(owner, { proposalId: ready.proposalId!, expectedDigest: ready.digest! })).state).toBe("created");
    expect(publishCount).toBe(0);
  });

  test("rejects a newer active run before and during snapshot export", async () => {
    await importApprovedRepository(owner, { projectId, repositoryId: 42, baseRef: "main", idempotencyKey: "same-import" });
    conversation = conversationId;
    await getTestDb().execute(sql`UPDATE sandbox_provider_bindings SET private_conversation_id=${conversationId},private_initialization_state='ready' WHERE id=${bindingId}`);
    await getTestDb().execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at) VALUES (${runId},'agent',${projectId},${conversationId},${owner},'success',NOW()-INTERVAL '2 minutes',NOW()-INTERVAL '1 minute')`);
    await getTestDb().execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at) VALUES ('newer-run','agent',${projectId},${conversationId},${owner},'running',NOW())`);
    await getTestDb().execute(sql`UPDATE runs SET started_at=(SELECT started_at FROM runs WHERE id=${runId}),created_at=(SELECT created_at FROM runs WHERE id=${runId}) WHERE id='newer-run'`);
    expect((await getPersonalPrForRun(owner, runId)).state).toBe("no_changes");
    await expect(preparePersonalPr(owner, { runId })).rejects.toMatchObject({ code: "conflict" });
    await getTestDb().execute(sql`UPDATE runs SET status='success',finished_at=NOW() WHERE id='newer-run'`);
    await expect(preparePersonalPr(owner, { runId })).rejects.toMatchObject({ code: "conflict" });
    await getTestDb().execute(sql`DELETE FROM runs WHERE id='newer-run'`);
    duringExport = async () => { await getTestDb().execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at) VALUES ('newer-run','agent',${projectId},${conversationId},${owner},'running',NOW())`); };
    await expect(preparePersonalPr(owner, { runId })).rejects.toMatchObject({ code: "conflict" });
    const snapshotRows = await getTestDb().execute(sql`SELECT id FROM github_personal_pr_snapshots`);
    expect(snapshotRows.rows).toHaveLength(0);
  });

  test("disconnect after dispatch fences each later GitHub write", async () => {
    await importApprovedRepository(owner, { projectId, repositoryId: 42, baseRef: "main", idempotencyKey: "same-import" });
    conversation = conversationId;
    await getTestDb().execute(sql`UPDATE sandbox_provider_bindings SET private_conversation_id=${conversationId},private_initialization_state='ready' WHERE id=${bindingId}`);
    await getTestDb().execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at) VALUES (${runId},'agent',${projectId},${conversationId},${owner},'success',NOW()-INTERVAL '1 minute',NOW())`);
    const ready = await preparePersonalPr(owner, { runId });
    maxEffectChecks = 1;
    await expect(confirmPersonalPr(owner, { proposalId: ready.proposalId!, expectedDigest: ready.digest! })).rejects.toMatchObject({ code: "STALE_CONNECTION" });
    expect(effectChecks).toBe(2);
    expect(githubWrites).toBe(0);
    const failed = await getPersonalPrForReviewId(owner, ready.proposalId!);
    expect(failed.blockReason).toBe("pre_ref_retryable");
    const first = await getTestDb().execute(sql`SELECT operation_id,branch FROM github_personal_pr_proposals WHERE id=${ready.proposalId}`);
    maxEffectChecks = Number.POSITIVE_INFINITY;
    expect((await confirmPersonalPr(owner, { proposalId: ready.proposalId!, expectedDigest: failed.digest! })).state).toBe("created");
    const second = await getTestDb().execute(sql`SELECT operation_id,branch FROM github_personal_pr_proposals WHERE id=${ready.proposalId}`);
    expect(second.rows[0]?.operation_id).not.toBe(first.rows[0]?.operation_id);
    expect(second.rows[0]?.branch).not.toBe(first.rows[0]?.branch);
    expect(githubWrites).toBe(2);
  });

  test("base movement before a write marks review stale and requires a new import", async () => {
    await importApprovedRepository(owner, { projectId, repositoryId: 42, baseRef: "main", idempotencyKey: "same-import" });
    conversation = conversationId;
    await getTestDb().execute(sql`UPDATE sandbox_provider_bindings SET private_conversation_id=${conversationId},private_initialization_state='ready' WHERE id=${bindingId}`);
    await getTestDb().execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at) VALUES (${runId},'agent',${projectId},${conversationId},${owner},'success',NOW()-INTERVAL '1 minute',NOW())`);
    const ready = await preparePersonalPr(owner, { runId });
    baseMoved = true;
    await expect(confirmPersonalPr(owner, { proposalId: ready.proposalId!, expectedDigest: ready.digest! })).rejects.toMatchObject({ code: "base_changed" });
    const stale = await getPersonalPrForReviewId(owner, ready.proposalId!);
    expect(stale.state).toBe("stale");
    expect(stale.blockReason).toBe("base_changed_reimport_required");
    expect(githubWrites).toBe(0);
    await expect(confirmPersonalPr(owner, { proposalId: ready.proposalId!, expectedDigest: ready.digest! })).rejects.toMatchObject({ code: "conflict" });
  });
});

import { createHash } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { providerMethodSchemas, validateManifest } from "@ezcorp/extension-contract";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import type { LocalSandboxDriver, SandboxController } from "../runtime/sandbox/controller/types";

mockDbConnection();
const { configureSandboxController } = await import("../runtime/sandbox/controller");
const { startAuthorization, completeAuthorization, startDeviceAuthorization, pollDeviceAuthorization, checkRepository } = await import("../integrations/github-user/broker");
const { importApprovedRepository, getPersonalPrForRun, preparePersonalPr, confirmPersonalPr, getPersonalPrForReviewId } = await import("../integrations/github-personal-prs/service");

const originalFetch = globalThis.fetch;
const baseSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const publishedSha = "c".repeat(40);
const limits = { memoryBytes: 1_048_576, milliCpu: 1000, pids: 64, diskBytes: 10_485_760 };
const blobSha = (bytes: Buffer) => createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
const oldBytes = Buffer.from("before\n");
const oldBlob = blobSha(oldBytes);
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let publishedBranch = "";
let publishedPrs = 0;
let devicePolls = 0;
let deviceRefreshes = 0;

function githubTransport(mode: "oauth" | "device"): void {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    const requestedHost = new Headers(init?.headers).get("host");
    if (requestedHost !== "github.com" && requestedHost !== "api.github.com") throw new Error(`Unexpected credential destination: ${requestedHost}`);
    const path = `${url.pathname}${url.search}`;
    const method = init?.method ?? "GET";
    if (path === "/login/device/code" && mode === "device") {
      const fields = new URLSearchParams(String(init?.body));
      expect(fields.get("client_id")).toBe("client");
      expect(fields.has("client_secret")).toBe(false);
      return reply({ device_code: "device-code-12345678901234567890", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    }
    if (path === "/login/oauth/access_token") {
      const fields = new URLSearchParams(String(init?.body));
      if (mode === "device") {
        expect(fields.has("client_secret")).toBe(false);
        if (fields.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
          devicePolls++;
          expect(fields.get("device_code")).toBe("device-code-12345678901234567890");
          return reply({ access_token: "user-access", refresh_token: "user-refresh", expires_in: 28800, refresh_token_expires_in: 15897600 });
        }
        if (fields.get("grant_type") === "refresh_token") {
          deviceRefreshes++;
          expect(fields.get("refresh_token")).toBe("user-refresh");
          return reply({ access_token: "refreshed-access", refresh_token: "refreshed-refresh", expires_in: 28800, refresh_token_expires_in: 15897600 });
        }
        throw new Error(`Unexpected device token grant: ${fields.get("grant_type")}`);
      }
      return reply({ access_token: "user-access", refresh_token: "user-refresh", expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    if (path === "/user") return reply({ id: 71, login: "owner" });
    if (path.startsWith("/user/installations?")) return reply({ total_count: 1, installations: [{ id: 50, app_id: 123, permissions: { contents: "write", pull_requests: "write" } }] });
    if (path.startsWith("/user/installations/50/repositories?")) return reply({ total_count: 1, repositories: [{ id: 42, full_name: "owner/repo", default_branch: "main", private: true }] });
    if (path === "/repos/owner/repo") return reply({ id: 42, permissions: { pull: true, push: true } });
    if (path === "/repos/owner/repo/git/ref/heads/main") return reply({ object: { type: "commit", sha: baseSha } });
    if (path === `/repos/owner/repo/git/commits/${baseSha}`) return reply({ tree: { sha: treeSha } });
    if (path === `/repos/owner/repo/git/trees/${treeSha}?recursive=1`) return reply({ truncated: false, tree: [{ path: "readme.txt", mode: "100644", type: "blob", sha: oldBlob, size: oldBytes.length }] });
    if (path === `/repos/owner/repo/git/blobs/${oldBlob}`) return reply({ encoding: "base64", content: oldBytes.toString("base64"), size: oldBytes.length });
    if (path === "/repos/owner/repo/git/blobs" && method === "POST") return reply({ sha: blobSha(Buffer.from(body.content, "base64")) });
    if (path === "/repos/owner/repo/git/trees" && method === "POST") return reply({ sha: "d".repeat(40) });
    if (path === "/repos/owner/repo/git/commits" && method === "POST") return reply({ sha: publishedSha });
    if (path === "/repos/owner/repo/git/refs" && method === "POST") { publishedBranch = String(body.ref).replace("refs/heads/", ""); return reply({ ref: body.ref, object: { sha: publishedSha } }); }
    if (path === "/repos/owner/repo/pulls" && method === "POST") {
      publishedPrs++;
      return reply({ number: 7, html_url: "https://github.com/owner/repo/pull/7", draft: true, head: { ref: publishedBranch, sha: publishedSha }, base: { ref: "main" } });
    }
    throw new Error(`Unexpected GitHub request: ${method} ${path}`);
  }, { preconnect: () => {} });
}

function provider(): { driver: LocalSandboxDriver; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  const mode = new Map<string, number>();
  let bundle = Buffer.alloc(0);
  const receipt = (input: any) => ({ operationId: input.call.operationId, idempotencyKey: input.call.idempotencyKey, requestDigest: input.call.requestDigest, outcome: "succeeded" as const });
  const resource = (input: any) => ({ receipt: receipt(input), resource: { resourceId: input.resourceId ?? "private-resource", desiredState: "stopped", observedState: "stopped", limits } });
  const entry = (path: string, kind: "file" | "directory" = "file") => ({ path, kind, revision: "r1", sizeBytes: files.get(path)?.length ?? 0, mode: mode.get(path) ?? 0o644 });
  const driver = {
    create: async (input: any) => resource(input),
    fileList: async (input: any) => ({ receipt: receipt(input), entries: [...files.keys()].map(path => entry(path)) }),
    fileMkdir: async (input: any) => ({ receipt: receipt(input), entry: entry(input.path, "directory") }),
    fileWrite: async (input: any) => { files.set(input.path, Buffer.from(input.data, input.encoding)); return { receipt: receipt(input), entry: entry(input.path) }; },
    fileChmod: async (input: any) => { mode.set(input.path, input.mode); return { receipt: receipt(input), entry: entry(input.path) }; },
    fileStat: async (input: any) => ({ receipt: receipt(input), entry: entry(input.path) }),
    fileRead: async (input: any) => ({ receipt: receipt(input), path: input.path, revision: "r1", offsetBytes: input.offsetBytes, nextOffsetBytes: files.get(input.path)?.length ?? 0, data: files.get(input.path)?.toString("base64") ?? "", encoding: "base64", eof: true }),
    beginExport: async (input: any) => {
      const entries = [...files].map(([path, bytes]) => ({ path: path.slice(1), mode: mode.get(path) === 0o755 ? "100755" : "100644", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") }));
      bundle = Buffer.from(JSON.stringify(entries));
      return { receipt: receipt(input), snapshotId: "frozen-1", byteLength: bundle.length, sha256: createHash("sha256").update(bundle).digest("hex") };
    },
    readExport: async (input: any) => ({ receipt: receipt(input), snapshotId: input.snapshotId, offsetBytes: input.offsetBytes, nextOffsetBytes: bundle.length, eof: true, data: bundle.toString("base64") }),
    endExport: async (input: any) => ({ receipt: receipt(input) }),
  } as unknown as LocalSandboxDriver;
  return { driver, files };
}

async function controllerFixture(ownerId: string): Promise<{ controller: SandboxController; restart: () => SandboxController; files: Map<string, Buffer>; installationId: string }> {
  const operations = {
    "sandbox.lifecycle.v1": ["create", "inspect", "start", "stop", "destroy"],
    "sandbox.process.v1": ["start", "inspect", "readOutput", "cancel"],
    "sandbox.files.v1": ["stat", "list", "read", "write", "mkdir", "remove", "chmod"],
    "sandbox.transfer.v1": ["beginExport", "readExport", "endExport"],
  } as const;
  const groups = Object.entries(operations).map(([name, methods]) => ({ name, methods: Object.fromEntries(methods.map(method => [method, `${name}:${method}`])) }));
  const methods = Object.entries(operations).flatMap(([name, entries]) => entries.map(operation => ({ name: `${name}:${operation}`, ...providerMethodSchemas(name as never, operation as never), sensitivity: "ordinary" as const })));
  const manifest = validateManifest({ schemaVersion: 4, name: "journey-sandbox", version: "1.0.0", author: { name: "Test" }, description: "Journey fixture", permissions: { hostApi: { routes: [{ method: "POST", path: "/api/local-sandbox/operations/:id/execute" }], events: false } }, methods, providers: [{ id: "local", kind: "sandbox", protocolMajor: 1, minimumHostContract: { major: 4, minor: 0 }, profiles: ["linux-exec.v1"], capabilities: [], configSchema: {}, requiredPermissions: ["hostApi"], methodGroups: groups }] });
  const installationId = crypto.randomUUID();
  const installation = { id: installationId, ownerId, scope: "global", activeReleaseId: "journey-release", generation: 1, acknowledgedGeneration: 1, enabled: true, uninstalled: false, status: "active", grants: [] };
  const release = { id: "journey-release", installationId, releaseDigest: "release-digest", policyDigest: "policy-digest", manifest };
  const runtime = { resolve: async () => ({ installation, release, limits: { memoryBytes: 1_048_576, cpuMillis: 1000, pids: 64, tmpBytes: 10_485_760, outputBytes: 65_536, timeoutMs: 30_000 } }) as unknown as ActiveExtensionRelease };
  await getTestDb().execute(sql`INSERT INTO extension_release_installations(id,owner_id,scope,payload) VALUES (${installationId},${ownerId},'global',${JSON.stringify(installation)})`);
  await getTestDb().execute(sql`INSERT INTO extension_release_records(installation_id,kind,id,payload) VALUES (${installationId},'releases','journey-release',${JSON.stringify(release)})`);
  const { driver, files } = provider();
  let controller!: SandboxController;
  const restart = () => controller = configureSandboxController(driver, runtime, async (userId, _projectId, reference, _group, _operation, input, signal) => controller.executeAdmittedLocalSandboxOperationRaw(userId, (input as { call: { operationId: string } }).call.operationId, reference.installationId, signal));
  restart();
  return { controller, restart, files, installationId };
}

async function exerciseJourney(mode: "oauth" | "device") {
  await setupTestDb();
  publishedBranch = "";
  publishedPrs = 0;
  devicePolls = 0;
  deviceRefreshes = 0;
  githubTransport(mode);
  process.env.EZ_GITHUB_INSTANCE_ID = "journey-instance";
  process.env.EZ_GITHUB_APP_ID = "123";
  process.env.EZ_GITHUB_APP_SLUG = "journey-app";
  process.env.EZ_GITHUB_APP_CLIENT_ID = "client";
  process.env.EZ_GITHUB_AUTH_MODE = mode;
  if (mode === "oauth") {
    process.env.EZ_GITHUB_APP_CLIENT_SECRET = "secret";
    process.env.EZ_GITHUB_APP_CALLBACK_URL = "https://app.example/api/github/callback";
  } else {
    delete process.env.EZ_GITHUB_APP_CLIENT_SECRET;
    delete process.env.EZ_GITHUB_APP_CALLBACK_URL;
  }
  const db = getTestDb();
  const ownerId = crypto.randomUUID(); const otherId = crypto.randomUUID(); const sessionId = crypto.randomUUID();
  await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${ownerId},'journey-owner@example.test','hash','Owner','member'),(${otherId},'journey-other@example.test','hash','Other','admin')`);
  await db.execute(sql`INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES (${sessionId},${ownerId},${crypto.randomUUID()},NOW()+INTERVAL '1 hour')`);
  if (mode === "oauth") {
    const { authorizeUrl } = await startAuthorization({ userId: ownerId, sessionId });
    await completeAuthorization({ userId: ownerId, sessionId, state: new URL(authorizeUrl).searchParams.get("state")!, code: "code" });
  } else {
    const attempt = await startDeviceAuthorization({ userId: ownerId, sessionId });
    expect(attempt).toMatchObject({ userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", intervalSeconds: 5 });
    expect(JSON.stringify(attempt)).not.toContain("device-code-12345678901234567890");
    const [stored] = (await db.execute(sql`SELECT device_ciphertext FROM github_user_device_attempts WHERE attempt_id=${attempt.attemptId}`)).rows as Array<{ device_ciphertext: string }>;
    expect(stored.device_ciphertext).not.toContain("device-code-12345678901234567890");
    await expect(pollDeviceAuthorization({ userId: otherId, sessionId, attemptId: attempt.attemptId })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    const otherSessionId = crypto.randomUUID();
    await db.execute(sql`INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES (${otherSessionId},${otherId},${crypto.randomUUID()},NOW()+INTERVAL '1 hour')`);
    await expect(pollDeviceAuthorization({ userId: otherId, sessionId: otherSessionId, attemptId: attempt.attemptId })).rejects.toMatchObject({ code: "DEVICE_ATTEMPT_UNAVAILABLE" });
    await expect(pollDeviceAuthorization({ userId: ownerId, sessionId: otherSessionId, attemptId: attempt.attemptId })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect((await pollDeviceAuthorization({ userId: ownerId, sessionId, attemptId: attempt.attemptId })).status).toBe("pending");
    expect(devicePolls).toBe(0);
    await db.execute(sql`UPDATE github_user_device_attempts SET next_poll_at=NOW()-INTERVAL '1 second' WHERE attempt_id=${attempt.attemptId}`);
    expect((await pollDeviceAuthorization({ userId: ownerId, sessionId, attemptId: attempt.attemptId })).status).toBe("connected");
    expect(devicePolls).toBe(1);
    const [connection] = (await db.execute(sql`SELECT auth_flow,access_ciphertext,refresh_ciphertext FROM github_user_connections WHERE user_id=${ownerId}`)).rows as Array<{ auth_flow: string; access_ciphertext: string; refresh_ciphertext: string }>;
    expect(connection.auth_flow).toBe("device");
    expect(connection.access_ciphertext).not.toContain("user-access");
    expect(connection.refresh_ciphertext).not.toContain("user-refresh");
    await db.execute(sql`UPDATE github_user_connections SET access_expires_at=NOW()-INTERVAL '1 second' WHERE user_id=${ownerId}`);
    expect((await checkRepository({ userId: ownerId, repositoryId: 42 })).status).toBe("ready");
    expect(deviceRefreshes).toBe(1);
  }
  const { controller, restart, files, installationId } = await controllerFixture(ownerId);
  const created = await controller.createSandboxProject(ownerId, { name: "Journey", idempotencyKey: "create", providerInstallationId: installationId, providerId: "local", config: {}, limits, privateOwnerOnly: true, privateInitializing: true });
  const imported = await importApprovedRepository(ownerId, { projectId: created.projectId, repositoryId: 42, baseRef: "main", idempotencyKey: "import" });
  expect(imported.importState).toBe("ready");
  expect(files.get("/readme.txt")?.toString()).toBe("before\n");
  await db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES (${crypto.randomUUID()},${created.projectId},${otherId},'member')`);
  await expect(controller.getProjectSandboxStatus(otherId, created.projectId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  await expect(importApprovedRepository(otherId, { projectId: created.projectId, repositoryId: 42, baseRef: "main", idempotencyKey: "foreign-import" })).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  const conversationId = crypto.randomUUID(); const runId = crypto.randomUUID();
  await db.execute(sql`INSERT INTO conversations(id,project_id,title,user_id) VALUES (${conversationId},${created.projectId},'Journey',${ownerId})`);
  const admitted = await controller.admitSandboxMethod(ownerId, created.projectId, { group: "sandbox.files.v1", operation: "list", payload: { path: "/", limit: 10 }, conversationId, idempotencyKey: "bind-conversation" });
  await controller.executeAdmittedSandboxMethod(ownerId, admitted.id);
  files.set("/readme.txt", Buffer.from("after\n"));
  await db.execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at) VALUES (${runId},'agent',${created.projectId},${conversationId},${ownerId},'success',NOW()-INTERVAL '1 minute',NOW())`);
  expect((await getPersonalPrForRun(ownerId, runId)).state).toBe("working");
  const ready = await preparePersonalPr(ownerId, { runId, title: "Change readme" });
  expect(ready.state).toBe("ready");
  expect(ready.files?.[0]).toMatchObject({ path: "readme.txt", additions: 1, deletions: 1 });
  await expect(getPersonalPrForReviewId(otherId, ready.proposalId!)).rejects.toMatchObject({ code: "not_found" });
  await expect(confirmPersonalPr(otherId, { proposalId: ready.proposalId!, expectedDigest: ready.digest! })).rejects.toMatchObject({ code: "not_found" });
  const createdPr = await confirmPersonalPr(ownerId, { proposalId: ready.proposalId!, expectedDigest: ready.digest! });
  expect(createdPr).toMatchObject({ state: "created", prUrl: "https://github.com/owner/repo/pull/7" });
  restart();
  expect((await getPersonalPrForReviewId(ownerId, ready.proposalId!)).state).toBe("created");
  expect((await confirmPersonalPr(ownerId, { proposalId: ready.proposalId!, expectedDigest: ready.digest! })).state).toBe("created");
  const claims = (await db.execute(sql`SELECT kind,state FROM github_user_effect_claims WHERE user_id=${ownerId} ORDER BY kind`)) as { rows: Array<{ kind: string; state: string }> };
  expect(claims.rows).toEqual([{ kind: "import", state: "completed" }, { kind: "publish", state: "completed" }]);
  expect(publishedPrs).toBe(1);
}

test("OAuth owner imports, reviews, publishes once, and excludes another member", () => exerciseJourney("oauth"));
test("device owner connects without a secret, refreshes locally, imports, reviews and publishes once", () => exerciseJourney("device"));

afterAll(async () => { globalThis.fetch = originalFetch; await closeTestDb(); });

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { sandboxPresetDigest, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import { incusManifest, INCUS_PRESETS } from "../../../extensions/incus-sandbox/manifest";
import { digest } from "../../../scripts/incus/model";
import { createIncusSourceTransport } from "../../__tests__/helpers/incus-source-transport";
import { getTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { releaseRows } from "../../db/queries/extension-releases";
import { sandboxBindings } from "../../db/schema";
import type { ActiveExtensionRelease } from "../../extensions/release-process";
import { IncusFeatureService } from "../../infrastructure/incus-feature-service";
import { IncusWorkspaceCaller as RealCaller, type IncusWorkspaceCallerDependencies } from "../../infrastructure/incus-workspace-caller";
import type { ProviderConnectionCredentials } from "../../infrastructure/provider-connections/store";
import { SandboxAdmissionStore } from "../../sandboxes/admission";
import { SandboxController, type SandboxProviderRequest } from "../../sandboxes/controller";
import { createProviderSandboxWorkspaceBackend } from "../../runtime/workspaces/provider-backend";
import { setSandboxWorkspaceTargetResolver } from "../../runtime/workspaces/project-target";
import { sandboxWorkspaceTarget } from "../../runtime/workspaces/target";
import { validateSnapshot } from "./snapshot";
import { GithubSourceError } from "./github-source";

mockDbConnection();
const owner = "incus-import-owner";
const preset = INCUS_PRESETS[0]!;
const input = { name: "Repository feature", installationId: "installation", connectionId: "connection", presetId: preset.id,
  repositoryId: 42, baseRef: "main", idempotencyKey: "private-repository" };
function sourceFile(text: string, path = "src/app.txt") {
  const bytes = Buffer.from(text);
  return { path, mode: "100644", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}
let selected = validateSnapshot([sourceFile("original")]);
let fetched = 0;
let sourceFailure: Error | undefined;
let sourceGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let features: IncusFeatureService;
let callerDependencies: IncusWorkspaceCallerDependencies;
let transportFailure = false;
let unplannedChecked = false;
let pending = false;
let failedPhase: "CREATE" | "START" | undefined;
let dispatches: SandboxProviderRequest[] = [];
let guestCalls: SandboxProtocolOperation[] = [];
let temporary = "";
let workspace = "";
mock.module("../../infrastructure/incus-feature-runtime", () => ({ configuredIncusFeatureService: () => features }));
mock.module("../../infrastructure/incus-workspace-caller", () => ({ IncusWorkspaceCaller: class extends RealCaller {
  constructor() { super(callerDependencies); }
} }));
mock.module("./repository-source", () => ({ approvedRepositorySource: async () => {
  fetched++;
  if (sourceFailure) throw sourceFailure;
  if (sourceGate) { if (fetched === 2) sourceGate.resolve(); await sourceGate.promise; }
  return { source: { repositoryId: 42, fullName: "owner/repo", baseRef: "main", baseSha: "a".repeat(40), snapshot: selected } };
} }));
let githubWrites: Array<{ path: string; body: unknown }> = [];
let publicationRead: (() => Promise<void>) | undefined;
class FakeGithubUserError extends Error { constructor(public code: string) { super(code); } }
mock.module("../github-user/broker", () => ({
  getConnectionBinding: async () => ({ githubAccountId: 17, generation: 1 }),
  assertUserEffectCurrent: async () => {},
  withUserToken: async (request: { authorizeDispatch?: (tx: ReturnType<typeof getTestDb>) => Promise<void> }, effect: (token: string) => Promise<unknown>) => {
    if (request.authorizeDispatch) await getTestDb().transaction(request.authorizeDispatch);
    return effect("host-github-token-canary");
  },
  withUserTokenReadOnly: async (_request: unknown, effect: (token: string) => Promise<unknown>) => effect("host-github-token-canary"),
}));
mock.module("../github-user/transport", () => ({ GithubUserError: FakeGithubUserError,
  githubApiRequest: async (token: string, path: string, method: string, body: Record<string, unknown>) => {
    expect(token).toBe("host-github-token-canary");
    if (method === "GET") await publicationRead?.();
    if (method === "POST") githubWrites.push({ path, body });
    if (path === "/repos/owner/repo") return { id: 42 };
    if (path.endsWith("/git/ref/heads/main")) return { object: { sha: "a".repeat(40) } };
    if (path.endsWith(`/git/commits/${"a".repeat(40)}`)) return { tree: { sha: "b".repeat(40) } };
    if (path.endsWith("/git/blobs")) {
      const bytes = Buffer.from(String(body.content), "base64");
      return { sha: createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex") };
    }
    if (path.endsWith("/git/trees")) return { sha: "c".repeat(40) };
    if (path.endsWith("/git/commits")) return { sha: "d".repeat(40) };
    if (path.endsWith("/git/refs")) return {};
    if (path.endsWith("/pulls")) return { html_url: "https://github.com/owner/repo/pull/7", number: 7, draft: true,
      head: { sha: "d".repeat(40), ref: body.head }, base: { ref: "main" } };
    throw new Error("Unexpected private GitHub transport fixture path");
  },
}));
const { createPrivateIncusRepository, resumeIncusRepository } = await import("./incus-import");
const { currentIncusAuthority, incusPersonalPrWorkspace } = await import("./incus-workspace-service");
const { exportIncusSnapshot } = await import("./incus-workspace");
const { preparePersonalPr, confirmPersonalPr } = await import("./service");

beforeEach(async () => {
  await setupTestDb();
  const db = getTestDb();
  await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role,status) VALUES (${owner},'incus-import@example.test','hash','Owner','admin','active')`);
  temporary = await mkdtemp(join(tmpdir(), "incus-private-import-"));
  workspace = join(temporary, "workspace");
  const stateRoot = join(temporary, "state");
  await mkdir(workspace); await mkdir(stateRoot, { mode: 0o700 });
  fetched = 0; sourceFailure = undefined; sourceGate = undefined; githubWrites = []; publicationRead = undefined; dispatches = []; guestCalls = []; transportFailure = false; pending = false; failedPhase = undefined; unplannedChecked = false;
  selected = validateSnapshot([sourceFile("original")]);
  const presetDigest = await sandboxPresetDigest(preset);
  const effectiveSettingsDigest = digest({ presetDigest, connectionRevision: 1 });
  const release = { installation: { id: "installation", activeReleaseId: "release" },
    release: { id: "release", releaseDigest: "release-digest", manifest: incusManifest } } as unknown as ActiveExtensionRelease;
  const connection: ProviderConnectionCredentials = { id: "connection", revision: 1, providerInstallationId: "installation", providerReleaseId: "release",
    endpoint: "https://incus.example:8443/", serverCertificatePem: "server", project: "ezharness",
    configuration: { kind: "incus", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" },
    clientCertificatePem: "client", privateKeyPem: "host-private-key-canary", revokedAt: null };
  const transport = createIncusSourceTransport(workspace, stateRoot);
  callerDependencies = { db, resolveRelease: async () => release, resolveConnection: async () => connection,
    invoke: async (_installation, _binding, operation, payload, _signal, guard) => {
      await guard?.();
      if (operation === "files.list" && !unplannedChecked) {
        unplannedChecked = true;
        const { target } = await currentIncusAuthority(owner, String((await db.select().from(sandboxBindings).where(eq(sandboxBindings.id, _binding)))[0]!.projectId));
        await expect(new RealCaller(callerDependencies).call({ binding: target.binding, principal: { userId: owner }, toolCallId: "unplanned:1", action: "file.stat", payload: { path: "unplanned.txt" } })).rejects.toThrow("must finish");
      }
      guestCalls.push(operation);
      expect(JSON.stringify(payload)).not.toContain("host-private-key-canary");
      if (transportFailure && operation === "files.writeAtomic") throw new Error("Interrupted guest write");
      return transport(operation, payload);
    } };
  const controller = new SandboxController(db, {
    async dispatch(request) {
      const [marker] = releaseRows<{ state: string; workspace_authority: unknown }>(await db.execute(sql`SELECT state,workspace_authority FROM github_personal_pr_imports WHERE binding_id=${request.binding.id}`));
      expect(marker?.state).toBe(request.idempotency.scope === "github-personal-import" ? "importing" : "ready");
      expect(marker?.workspace_authority).not.toBeNull();
      dispatches.push(request);
      if (request.kind === failedPhase) return { outcome: "FAILED", errorCode: "FIXTURE_LIFECYCLE_DENIED" };
      return pending ? { outcome: "PENDING", providerOperationId: `provider-${request.operationId}` }
        : { outcome: "SUCCEEDED", observedState: request.kind === "START" ? "RUNNING" : "STOPPED" };
    },
    async inspectOperation(request) { return pending ? { outcome: "PENDING", providerOperationId: request.providerOperationId ?? undefined } : { outcome: "SUCCEEDED", observedState: request.kind === "START" ? "RUNNING" : "STOPPED" }; },
  });
  const admission = new SandboxAdmissionStore(db);
  await admission.configureHostCapacity({ providerInstallationId: "installation", connectionId: "connection",
    allocatable: { memoryBytes: 2 * preset.limits.memoryBytes, cpuMillicores: 2 * preset.limits.cpuMillis, pids: 2 * preset.limits.pids, diskBytes: 2 * preset.limits.diskBytes, executionSlots: 2 },
    safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
  features = new IncusFeatureService({ db, controller, admission, activeRelease: async () => release,
    assertCurrentScope: async () => {}, connectionRevision: async () => 1, resolveConnection: async () => connection,
    loadQualification: async () => ({ producer: "live-provider", connectionId: "connection", providerId: "incus", presetId: preset.id, profile: preset.profile,
      releaseDigest: "release-digest", presetDigest, effectiveSettingsDigest, backendVersion: "6.0.6", verifiedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(), cases: [] }),
    assertReady: async () => {}, inspect: async (_installation, bindingId) => {
      const [binding] = await db.select().from(sandboxBindings).where(eq(sandboxBindings.id, bindingId));
      return { ok: true, sandbox: { sandboxId: bindingId, profile: preset.profile, presetId: preset.id,
        desiredState: binding!.desiredState.toLowerCase(), observedState: binding!.observedState.toLowerCase(), generation: binding!.generation, bootId: "fixture-boot", observedAt: new Date().toISOString() } };
    } });
  setSandboxWorkspaceTargetResolver(async binding => sandboxWorkspaceTarget({ projectId: binding.projectId, workspaceId: binding.resourceKey!, connectionId: binding.connectionId,
    providerId: "incus", generation: binding.generation, presetId: binding.presetId!, releaseDigest: release.release.releaseDigest,
    presetDigest: binding.presetDigest!, effectiveSettingsDigest: binding.effectiveSettingsDigest! }, createProviderSandboxWorkspaceBackend(new RealCaller(callerDependencies))));
});
afterEach(async () => { setSandboxWorkspaceTargetResolver(null); if (temporary) await rm(temporary, { recursive: true, force: true }); });

test("new private source import crosses normal lifecycle, real caller guard, native process backend, and guest file helper", async () => {
  const result = await createPrivateIncusRepository(owner, input);
  expect(result.importState).toBe("ready");
  expect(dispatches.map(value => value.kind)).toEqual(["CREATE", "START"]);
  expect(await readFile(join(workspace, "src/app.txt"), "utf8")).toBe("original");
  expect(guestCalls).toContain("processes.start");
  expect(unplannedChecked).toBe(true);
  const [marker] = releaseRows<{ state: string; base_sha: string }>(await getTestDb().execute(sql`SELECT state,base_sha FROM github_personal_pr_imports WHERE project_id=${result.projectId!}`));
  expect(marker).toEqual({ state: "ready", base_sha: "a".repeat(40) });
  const { target } = await currentIncusAuthority(owner, result.projectId!);
  expect(target.kind).toBe("sandbox");
  const captured = await exportIncusSnapshot(target, owner);
  expect(captured.digest).toBe(selected.digest);
  expect(Buffer.from(captured.files[0]!.bytes).toString()).toBe("original");
  expect(releaseRows(await getTestDb().execute(sql`SELECT * FROM project_workspace_bindings WHERE project_id=${result.projectId!}`))).toEqual([]);
  selected = validateSnapshot([sourceFile("moving branch must not replace source")]);
  expect((await createPrivateIncusRepository(owner, input)).importState).toBe("ready");
  expect(fetched).toBe(1);
  expect(dispatches).toHaveLength(2);
  expect(await readFile(join(workspace, "src/app.txt"), "utf8")).toBe("original");
});

test("unsupported source is rejected before project, journal, or guest effects", async () => {
  selected = validateSnapshot([sourceFile("x".repeat(65_537))]);
  await expect(createPrivateIncusRepository(owner, input)).rejects.toMatchObject({ code: "unsupported_workspace" });
  expect(dispatches).toEqual([]); expect(guestCalls).toEqual([]);
  expect(releaseRows(await getTestDb().execute(sql`SELECT * FROM projects WHERE id <> 'global'`))).toEqual([]);
});

test("partial transfer remains blocked and is never replayed by the same request", async () => {
  transportFailure = true;
  await expect(createPrivateIncusRepository(owner, input)).rejects.toMatchObject({ code: "provider_failed" });
  const [marker] = releaseRows<{ project_id: string; state: string }>(await getTestDb().execute(sql`SELECT project_id,state FROM github_personal_pr_imports`));
  expect(marker!.state).toBe("unknown");
  const count = guestCalls.length;
  transportFailure = false;
  await expect(createPrivateIncusRepository(owner, input)).rejects.toMatchObject({ code: "provider_failed" });
  await expect(resumeIncusRepository(owner, marker!.project_id)).rejects.toMatchObject({ code: "provider_failed" });
  expect(guestCalls).toHaveLength(count); expect(fetched).toBe(1); expect(dispatches).toHaveLength(2);
});

test("an admitted source request cannot change repository, scope, or name on retry", async () => {
  pending = true;
  const result = await createPrivateIncusRepository(owner, input);
  expect(result.importState).toBe("unknown");
  for (const change of [{ repositoryId: 43 }, { baseRef: "other" }, { name: "Other" }, { connectionId: "other" }]) {
    await expect(createPrivateIncusRepository(owner, { ...input, ...change })).rejects.toMatchObject({ code: "conflict" });
  }
  expect(fetched).toBe(1); expect(dispatches).toHaveLength(1); expect(guestCalls).toEqual([]);
});


test("pending lifecycle retry observes the same receipt and original source without another CREATE", async () => {
  pending = true;
  const first = await createPrivateIncusRepository(owner, input);
  expect(first.importState).toBe("unknown");
  expect(dispatches).toHaveLength(1);
  expect((await createPrivateIncusRepository(owner, input)).importState).toBe("unknown");
  expect(dispatches).toHaveLength(1);
  selected = validateSnapshot([sourceFile("moving branch")]);
  pending = false;
  expect((await createPrivateIncusRepository(owner, input)).importState).toBe("ready");
  expect(dispatches.map(value => value.kind)).toEqual(["CREATE", "START"]);
  expect(fetched).toBe(1);
  expect(await readFile(join(workspace, "src/app.txt"), "utf8")).toBe("original");
});


test("source policy errors are actionable limits while provider failures keep their identity", async () => {
  sourceFailure = new GithubSourceError("unsupported_repository", "Tree has unsupported entries");
  await expect(createPrivateIncusRepository(owner, input)).rejects.toMatchObject({ code: "unsupported_workspace" });
  sourceFailure = new GithubSourceError("provider_unavailable", "GitHub unavailable");
  await expect(createPrivateIncusRepository(owner, input)).rejects.toBe(sourceFailure);
  expect(dispatches).toEqual([]); expect(guestCalls).toEqual([]);
});


async function preparedFeatureReview() {
  const imported = await createPrivateIncusRepository(owner, input);
  const projectId = imported.projectId!;
  const { target } = await currentIncusAuthority(owner, projectId);
  const caller = new RealCaller(callerDependencies);
  const principal = { userId: owner };
  const current = await caller.call({ binding: target.binding, principal, toolCallId: "native-edit:1", action: "file.stat", payload: { path: "src/app.txt" } }) as { file: { revision: string } };
  const changed = Buffer.from("feature implementation");
  await caller.call({ binding: target.binding, principal, toolCallId: "native-edit:2", action: "file.writeAtomic",
    payload: { path: "src/app.txt", expectedRevision: current.file.revision, dataBase64: changed.toString("base64"), byteLength: changed.length, executable: false } });
  const db = getTestDb();
  await db.execute(sql`INSERT INTO conversations(id,project_id,title,user_id) VALUES ('feature-chat',${projectId},'Feature',${owner})`);
  await db.execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at) VALUES ('feature-run','agent',${projectId},'feature-chat',${owner},'success',NOW()-INTERVAL '1 minute',NOW())`);
  await db.execute(sql`INSERT INTO extension_release_installations(id,owner_id,scope,payload) VALUES ('installation',${owner},'global',${JSON.stringify({ activeReleaseId: "release", enabled: true, status: "active", generation: 1, acknowledgedGeneration: 1 })})`);
  await db.execute(sql`INSERT INTO extension_release_records(installation_id,kind,id,payload) VALUES ('installation','releases','release',${JSON.stringify({ releaseDigest: "release-digest" })})`);
  await db.execute(sql`INSERT INTO provider_connections(id,revision,provider_installation_id,provider_release_id,endpoint,server_certificate_pem,project,configuration,client_certificate_pem,private_key_ciphertext)
    VALUES ('connection',1,'installation','release','https://incus.example:8443/','server','ezharness','{}','client','private-test-ciphertext')`);
  return { projectId, target, caller, review: await preparePersonalPr(owner, { runId: "feature-run", title: "Feature implementation" }) };
}

test("native Incus source edit is reviewed once and published from frozen host bytes through the existing publisher", async () => {
  const { review, caller, target } = await preparedFeatureReview();
  expect(review.state).toBe("ready");
  const current = await caller.call({ binding: target.binding, principal: { userId: owner }, toolCallId: "later-edit:1", action: "file.stat", payload: { path: "src/app.txt" } }) as { file: { revision: string } };
  const later = Buffer.from("later guest edit must not be published");
  await caller.call({ binding: target.binding, principal: { userId: owner }, toolCallId: "later-edit:2", action: "file.writeAtomic", payload: {
    path: "src/app.txt", expectedRevision: current.file.revision, byteLength: later.length, dataBase64: later.toString("base64"), executable: false } });
  const published = await confirmPersonalPr(owner, { proposalId: review.proposalId!, expectedDigest: review.digest!, title: "Feature implementation", body: "", idempotencyKey: "publish-feature" });
  expect(published.state).toBe("created");
  const blobs = githubWrites.filter(value => value.path.endsWith("/git/blobs"));
  expect(blobs).toHaveLength(1);
  expect(Buffer.from(String((blobs[0]!.body as Record<string, unknown>).content), "base64").toString()).toBe("feature implementation");
  expect(await readFile(join(workspace, "src/app.txt"), "utf8")).toBe(later.toString());
  expect(githubWrites.filter(value => value.path.endsWith("/pulls"))).toHaveLength(1);
});

test("Incus connection revocation after publication claim blocks the first GitHub write", async () => {
  const { review } = await preparedFeatureReview();
  publicationRead = async () => {
    publicationRead = undefined;
    await getTestDb().execute(sql`UPDATE provider_connections SET revoked_at=NOW() WHERE id='connection'`);
  };
  await expect(confirmPersonalPr(owner, { proposalId: review.proposalId!, expectedDigest: review.digest!, title: "Feature implementation", body: "", idempotencyKey: "publish-revoked" })).rejects.toMatchObject({ code: "unavailable" });
  expect(githubWrites).toEqual([]);
});


test("known failed CREATE or START is terminal and cannot retry guest effects", async () => {
  failedPhase = "CREATE";
  await expect(createPrivateIncusRepository(owner, input)).rejects.toMatchObject({ code: "provider_failed" });
  const [failed] = releaseRows<{ state: string }>(await getTestDb().execute(sql`SELECT state FROM github_personal_pr_imports`));
  expect(failed!.state).toBe("failed");
  await expect(createPrivateIncusRepository(owner, input)).rejects.toMatchObject({ code: "provider_failed" });
  expect(dispatches).toHaveLength(1); expect(guestCalls).toEqual([]);
});

test("known failed initial START retains its saved receipt and blocks transfer", async () => {
  failedPhase = "START";
  await expect(createPrivateIncusRepository(owner, input)).rejects.toMatchObject({ code: "provider_failed" });
  expect(dispatches.map(value => value.kind)).toEqual(["CREATE", "START"]);
  await expect(createPrivateIncusRepository(owner, input)).rejects.toMatchObject({ code: "provider_failed" });
  expect(dispatches).toHaveLength(2); expect(guestCalls).toEqual([]);
});


test("same private Incus source supports normal stop, resume, and a new reviewed owner run", async () => {
  const { projectId, target, review: firstReview } = await preparedFeatureReview();
  const before = target.binding.generation;
  await features.stop({ bindingId: target.binding.workspaceId, idempotencyScope: "operator", idempotencyKey: "stop-feature" });
  const resumed = await features.start({ bindingId: target.binding.workspaceId, idempotencyScope: "operator", idempotencyKey: "resume-feature" });
  expect(resumed.state).toBe("DISPATCHED");
  const current = await currentIncusAuthority(owner, projectId);
  expect(current.target.binding.workspaceId).toBe(target.binding.workspaceId);
  expect(current.target.binding.generation).toBe(before);
  await getTestDb().execute(sql`INSERT INTO runs(id,agent_name,project_id,conversation_id,user_id,status,started_at,finished_at) VALUES ('resumed-run','agent',${projectId},'feature-chat',${owner},'success',NOW(),NOW())`);
  const nextReview = await preparePersonalPr(owner, { runId: "resumed-run" });
  expect(nextReview.state).toBe("ready");
  expect(nextReview.proposalId).not.toBe(firstReview.proposalId);
});


test("repository import cannot adopt an existing empty management workspace", async () => {
  const prepared = await features.prepareProject({ ...input, ownerUserId: owner });
  await expect(createPrivateIncusRepository(owner, input)).rejects.toThrow("existing workspace cannot be attached");
  expect(dispatches).toEqual([]); expect(guestCalls).toEqual([]);
  expect(releaseRows(await getTestDb().execute(sql`SELECT * FROM github_personal_pr_imports WHERE project_id=${prepared.project.id}`))).toEqual([]);
});

test("concurrent identical import uses one saved source and at most one file transfer", async () => {
  sourceGate = Promise.withResolvers<void>();
  const results = await Promise.allSettled([createPrivateIncusRepository(owner, input), createPrivateIncusRepository(owner, input)]);
  expect(results.some(value => value.status === "fulfilled")).toBe(true);
  const rows = releaseRows<{ project_id: string; state: string }>(await getTestDb().execute(sql`SELECT project_id,state FROM github_personal_pr_imports`));
  expect(rows).toHaveLength(1);
  expect(dispatches.filter(value => value.kind === "CREATE")).toHaveLength(1);
  expect(dispatches.filter(value => value.kind === "START")).toHaveLength(1);
  expect(guestCalls.filter(value => value === "files.writeAtomic")).toHaveLength(1);
  expect((await resumeIncusRepository(owner, rows[0]!.project_id)).importState).toBe("ready");
});

test("Incus port refuses direct existing-workspace import and a changed capture generation cannot publish", async () => {
  const { projectId, review } = await preparedFeatureReview();
  const port = incusPersonalPrWorkspace(owner, projectId);
  await expect(port.importSnapshot("arbitrary-import", await port.status(), selected, async () => {})).rejects.toThrow("must create a new private workspace");
  publicationRead = async () => {
    publicationRead = undefined;
    await getTestDb().execute(sql`UPDATE sandbox_bindings SET generation=generation+1 WHERE project_id=${projectId}`);
  };
  await expect(confirmPersonalPr(owner, { proposalId: review.proposalId!, expectedDigest: review.digest!, title: "Feature implementation", body: "", idempotencyKey: "publish-replaced-generation" })).rejects.toMatchObject({ code: "unavailable" });
  expect(githubWrites).toEqual([]);
});

test("installed legacy import key cannot become an Incus import or a temporary retry error", async () => {
  const db = getTestDb();
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES ('legacy-project','Installed private workspace','/installed-private')`);
  await db.execute(sql`INSERT INTO github_personal_pr_imports
    (id,owner_id,project_id,binding_id,workspace_revision,provider_generation,resource_id,repository_id,repository_name,base_ref,base_sha,base_digest,state,operation_id,idempotency_key,artifact)
    VALUES ('installed-legacy',${owner},'legacy-project','legacy-binding',1,1,'legacy-resource',42,'owner/repo','main','legacy-base','legacy-digest','ready','legacy-operation',${input.idempotencyKey},'[]')`);
  await expect(createPrivateIncusRepository(owner, input)).rejects.toMatchObject({ code: "conflict" });
  expect(fetched).toBe(0);
  expect(dispatches).toEqual([]);
  expect(guestCalls).toEqual([]);
});

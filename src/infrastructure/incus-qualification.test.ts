import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { drizzle as postgresDrizzle } from "drizzle-orm/bun-sql";
import { LIVE_SANDBOX_QUALIFICATION_CASES, sandboxPresetDigest, type SandboxCompatibilityObservation } from "@ezcorp/extension-contract";
import { liveComposePreviewProof } from "../../packages/@ezcorp/extension-contract/src/sandbox-presets.fixture";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import recipeTemplate from "../../scripts/incus/recipe.json";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import { qualifySandboxRuntime, releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { up } from "../db/migrations/add-incus-qualification";
import { guestHelperSha256 } from "./incus-guest/protocol";
import { IncusQualificationStore, type IncusQualificationScope, type IncusImageReceipt, type IncusLiveCaseEvidence } from "./incus-qualification";
import type { ProviderConnectionCredentials } from "./provider-connections/store";

const manifest = structuredClone(incusManifest);
for (const provider of manifest.sandboxProviders ?? []) {
  for (const preset of provider.presets) preset.helperDigests = [guestHelperSha256()];
}
const { snapshot } = releaseRuntimeFixture("qualification-installation", manifest);
const preset = manifest.sandboxProviders![0]!.presets[0]!;
const scope: IncusQualificationScope = {
  installationId: snapshot.installation.id, releaseId: snapshot.release.id,
  connectionId: "connection-qualification", presetId: preset.id,
};
const observation: SandboxCompatibilityObservation = {
  backendApi: preset.requirements.backendApis[0]!, backendVersion: "6.0.6",
  architecture: preset.requirements.architectures[0]!, storageDriver: preset.requirements.storageDrivers[0]!,
  isolation: preset.requirements.isolation[0]!, nestedCompose: true,
};
const certificatePem = readFileSync(new URL("./incus-transport/test-server.pem", import.meta.url), "utf8");
const certificateSha256 = createHash("sha256").update(new X509Certificate(certificatePem).raw).digest("hex");
const imageReceipt = (selectedPreset = preset): IncusImageReceipt => ({
  providerReleaseId: scope.releaseId, providerReleaseDigest: snapshot.release.releaseDigest,
  connectionId: scope.connectionId, connectionRevision: revision, state: "verified",
  recipe: { ...structuredClone(recipeTemplate), profile: { ...recipeTemplate.profile, name: "ezharness" },
    guestImage: { ...recipeTemplate.guestImage, fingerprint: selectedPreset.imageDigest,
      sourceFingerprint: "a".repeat(64), helperSha256: guestHelperSha256(),
      pythonPackageVersion: "3.12.1", dockerArchiveSha256: "b".repeat(64), composeSha256: "c".repeat(64) } } as IncusSetupRecipe,
});

function terminalDatabase(directory?: string) {
  const url = process.env.EZCORP_CONTINUATION_TEST_PG_URL;
  if (!url) { const client = new PGlite(directory); return { client, db: drizzle(client) }; }
  const destination = new URL(url);
  if (destination.hostname !== "127.0.0.1" || destination.pathname !== "/continuation_fixture") {
    throw new Error("Only the isolated loopback PostgreSQL fixture is allowed");
  }
  const postgres = new SQL(url, { max: 1 });
  const client = { waitReady: Promise.resolve(),
    query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> =>
      ({ rows: await postgres.unsafe(text, params) as T[] }),
    exec: (text: string) => postgres.unsafe(text).simple(), close: () => postgres.close() };
  return { client, db: postgresDrizzle(postgres) as unknown as ReturnType<typeof drizzle> };
}
let { client, db } = terminalDatabase(process.env.EZCORP_CONTINUATION_DB_PATH);
let now = Date.parse("2026-09-22T15:00:00Z");
let revision = 1;
let negativeProbe = false;
let caseStatus: "passed" | "failed" = "passed";
let probeCalls = 0;
const connection = (): ProviderConnectionCredentials => ({
  id: scope.connectionId, revision, providerInstallationId: scope.installationId,
  providerReleaseId: scope.releaseId, endpoint: "https://incus.example:8443",
  serverCertificatePem: certificatePem, project: "sandbox",
  configuration: { kind: "incus", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" },
  clientCertificatePem: "client", privateKeyPem: "host-private-key", revokedAt: null,
});
const cases = (): IncusLiveCaseEvidence => ({
  observation,
  observedProfile: preset.profile, observedImageDigest: preset.imageDigest,
  observedHelperDigest: guestHelperSha256(),
  verifiedAt: new Date(now - 1_000).toISOString(),
  validUntil: new Date(now + 60_000).toISOString(),
  cases: LIVE_SANDBOX_QUALIFICATION_CASES.map(caseId => ({ caseId, status: caseStatus })),
});
const probeResult = () => ({
  serverCertificateSha256: certificateSha256, project: "sandbox", profile: "ezharness",
  helperVersion: "unverified", backendApi: negativeProbe ? "unsupported" : observation.backendApi,
  backendVersion: observation.backendVersion, architecture: observation.architecture,
  storageDriver: "unverified", isolation: observation.isolation, nestedCompose: false,
  controls: { restrictedProject: true, unprivileged: false, projectLimits: false, privateNetwork: false,
    workspaceRoot: "/workspace" as const, explicitGuestUser: false, atomicFileReplace: false,
    durableProcesses: false, boundedOutput: false, endpointProxy: false },
});
const store = new IncusQualificationStore({ db,
  activeRelease: async () => snapshot,
  connectionRevision: async () => revision,
  imageReceipt: async () => imageReceipt(),
  resolveConnection: async () => connection(),
  probe: async () => { probeCalls++; return probeResult(); },
  runLiveCases: async () => cases(),
  now: () => now,
});

beforeAll(async () => {
  await client.waitReady;
  await up(db);
}, 30_000);
afterAll(async () => client.close());

describe("host Incus qualification store", () => {
  test("fixture authorization pins the current release, connection, preset, and published image", async () => {
    let published = true;
    const fixtureStore = new IncusQualificationStore({ db,
      activeRelease: async () => snapshot,
      connectionRevision: async () => revision,
      resolveConnection: async () => connection(),
      imageReceipt: async () => published ? imageReceipt() : null,
      probe: async () => { throw new Error("Fixture authorization must not run the host probe"); },
    });
    const selected = await fixtureStore.authorizeFixture(scope);
    expect(selected.snapshot).toEqual(snapshot);
    expect(selected.connection).toEqual(connection());
    expect(selected.preset).toEqual(preset);
    expect(selected.presetDigest).toBe(await sandboxPresetDigest(preset));
    expect(selected.helperDigest).toBe(guestHelperSha256());
    await expect(fixtureStore.authorizeFixture({ ...scope, releaseId: "different-release" }))
      .rejects.toThrow("release is unavailable");
    published = false;
    await expect(fixtureStore.authorizeFixture(scope)).rejects.toThrow("image is unpublished");
  });

  test("missing evidence fails closed and a host probe plus all live cases can be persisted", async () => {
    expect(await store.load(scope)).toBeNull();
    const saved = await store.recordVerified(scope);
    expect(saved.cases).toHaveLength(8);
    expect(probeCalls).toBe(1);
    expect(await store.load(scope)).toEqual(saved);
  });

  test("Compose rejects the old eight-case receipt and legacy saved row", async () => {
    const composePreset = manifest.sandboxProviders![0]!.presets[1]!;
    const composeScope = { ...scope, presetId: composePreset.id };
    const composeStore = new IncusQualificationStore({ db,
      activeRelease: async () => snapshot,
      connectionRevision: async () => revision,
      imageReceipt: async () => imageReceipt(composePreset),
      resolveConnection: async () => connection(),
      probe: async () => probeResult(),
      runLiveCases: async () => cases(),
      now: () => now,
    });
    const selected = await composeStore.authorizeFixture(composeScope);
    const oldCases = { ...cases(), observedProfile: composePreset.profile };
    await expect(composeStore.recordVerified(composeScope, oldCases)).rejects.toThrow("preview proof");
    expect(await composeStore.load(composeScope)).toBeNull();
    const previewProof = await liveComposePreviewProof(composePreset, {
      connectionId: composeScope.connectionId, releaseDigest: snapshot.release.releaseDigest,
      presetDigest: selected.presetDigest, effectiveSettingsDigest: selected.effectiveSettingsDigest,
      helperDigest: selected.helperDigest, expiresAt: new Date(now + 30_000).toISOString(),
    });
    const evidence: IncusLiveCaseEvidence = { ...oldCases, previewProof,
      cases: [...oldCases.cases, { caseId: "SP09", status: "passed" }] };
    const saved = await composeStore.recordVerified(composeScope, evidence);
    expect(saved.previewProof).toEqual(previewProof);
    expect(await composeStore.loadBaselineProof(composeScope, (await import("../../scripts/incus/model")).digest(saved))).toEqual(saved);
    expect(await composeStore.load(composeScope)).toEqual(saved);
    const legacy = { ...saved, cases: saved.cases.slice(0, 8) };
    delete legacy.previewProof;
    await db.execute(sql`UPDATE incus_live_qualifications SET qualification = ${JSON.stringify(legacy)}::jsonb
      WHERE installation_id = ${composeScope.installationId} AND connection_id = ${composeScope.connectionId}
      AND preset_id = ${composeScope.presetId}`);
    expect(await composeStore.load(composeScope)).toBeNull();
  });

  test("stale connection revision, expiry, and changed release deny a persisted row", async () => {
    revision = 2;
    expect(await store.load(scope)).toBeNull();
    revision = 1;
    now += 61_000;
    expect(await store.load(scope)).toBeNull();
    now -= 61_000;
    expect(await store.load({ ...scope, releaseId: "different-release" })).toBeNull();
  });

  test("negative backend probe and failed live case never replace good evidence", async () => {
    negativeProbe = true;
    await expect(store.recordVerified(scope)).rejects.toThrow("probe is incompatible");
    negativeProbe = false;
    caseStatus = "failed";
    await expect(store.recordVerified(scope)).rejects.toThrow();
    caseStatus = "passed";
    expect(await store.load(scope)).not.toBeNull();
  });

  test("changed artifact observations cannot replace persisted qualification", async () => {
    const before = await store.recordVerified(scope);
    expect(await store.load(scope)).toEqual(before);
    for (const change of [
      { observedProfile: "other" }, { observedImageDigest: "0".repeat(64) },
      { observedHelperDigest: "0".repeat(64) },
      { observation: { ...observation, backendApi: "unsupported" } },
      { observation: { ...observation, backendVersion: "different" } },
    ]) {
      await expect(store.recordVerified(scope, { ...cases(), ...change }))
        .rejects.toThrow("Live Incus artifact observation changed");
      expect(await store.load(scope)).toEqual(before);
    }
  });

  test("a connection revision changed during live cases is refused before persistence", async () => {
    const before = await store.recordVerified(scope);
    expect(await store.load(scope)).toEqual(before);
    const changing = new IncusQualificationStore({ db,
      activeRelease: async () => snapshot,
      connectionRevision: async () => revision,
      imageReceipt: async () => imageReceipt(),
      resolveConnection: async () => connection(),
      probe: async () => probeResult(),
      runLiveCases: async () => {
        const evidence = cases();
        revision += 1;
        return evidence;
      },
      now: () => now,
    });
    const originalRevision = revision;
    try {
      await expect(changing.recordVerified(scope)).rejects.toThrow("Incus qualification changed during live cases");
    } finally {
      revision = originalRevision;
    }
    expect(await store.load(scope)).toEqual(before);
  });

  test("the default store has no synthetic live runner", async () => {
    const noRunner = new IncusQualificationStore({ db,
      activeRelease: async () => snapshot,
      connectionRevision: async () => revision,
      imageReceipt: async () => imageReceipt(),
      resolveConnection: async () => connection(),
      probe: async () => { throw new Error("Probe must not run without a live runner"); },
    });
    await expect(noRunner.recordVerified(scope)).rejects.toThrow("runner is unavailable");
  });

  test("an unpublished image or missing source pin denies qualification", async () => {
    const missing = new IncusQualificationStore({ db,
      activeRelease: async () => snapshot, connectionRevision: async () => revision,
      resolveConnection: async () => connection(), imageReceipt: async () => null,
      probe: async () => { throw new Error("Probe must not run without an image receipt"); },
      runLiveCases: async () => cases(), now: () => now });
    await expect(missing.recordVerified(scope)).rejects.toThrow("image is unpublished");
    expect(await missing.load(scope)).toBeNull();
    const placeholder = new IncusQualificationStore({ db,
      activeRelease: async () => snapshot, connectionRevision: async () => revision,
      resolveConnection: async () => connection(),
      imageReceipt: async () => ({ ...imageReceipt(), recipe: { ...imageReceipt().recipe,
        guestImage: { ...imageReceipt().recipe.guestImage!, fingerprint: null } } }),
      runLiveCases: async () => cases(), now: () => now });
    await expect(placeholder.recordVerified(scope)).rejects.toThrow("image is unpublished");
  });

  test("migration can reopen and reapply without deleting stored evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "incus-qualification-"));
    try {
      const firstClient = new PGlite(directory);
      await firstClient.waitReady;
      await up(drizzle(firstClient));
      await firstClient.exec(`INSERT INTO incus_live_qualifications (
        installation_id, release_id, release_digest, connection_id, connection_revision,
        preset_id, preset_digest, effective_settings_digest, profile, image_digest,
        helper_digest, probe_observation, live_observation, qualification, verified_at, valid_until
      ) VALUES ('i', 'r', 'd', 'c', 1, 'p', 'pd', 'sd', 'profile', 'image',
        'helper', '{}', '{}', '{}', NOW(), NOW() + INTERVAL '1 day')`);
      await firstClient.close();
      const reopened = new PGlite(directory);
      try {
        await reopened.waitReady;
        await up(drizzle(reopened));
        const result = await reopened.query<{ connection_id: string }>(
          "SELECT connection_id FROM incus_live_qualifications WHERE installation_id = 'i'",
        );
        expect(result.rows).toEqual([{ connection_id: "c" }]);
      } finally {
        await reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("default qualification path reads the host image receipt before any probe", async () => {
  const queries: string[] = [];
  const emptyDb = { execute: async (query: { toQuery?: () => { sql: string } }) => {
    queries.push(String(query));
    return [];
  } };
  let liveCaseCalls = 0;
  const defaults = new IncusQualificationStore({ db: emptyDb,
    activeRelease: async () => snapshot, connectionRevision: async () => revision,
    resolveConnection: async () => connection(),
    runLiveCases: async () => { liveCaseCalls++; return cases(); }, now: () => now });
  await expect(defaults.recordVerified(scope)).rejects.toThrow("image is unpublished");
  expect(queries).toHaveLength(1);
  expect(liveCaseCalls).toBe(0);
});

test("default host probe requires a persisted host connection before live cases", async () => {
  const unavailableDb = { execute: async () => [] };
  let liveCaseCalls = 0;
  const defaults = new IncusQualificationStore({ db: unavailableDb,
    activeRelease: async () => snapshot, connectionRevision: async () => revision,
    resolveConnection: async () => connection(), imageReceipt: async () => imageReceipt(),
    runLiveCases: async () => { liveCaseCalls++; return cases(); }, now: () => now });
  await expect(defaults.recordVerified(scope)).rejects.toThrow();
  expect(liveCaseCalls).toBe(0);
});

test("a separately pinned baseline validates the unchanged full receipt after its expiry", async () => {
  const original = await store.recordVerified(scope);
  const originalDigest = (await import("../../scripts/incus/model")).digest(original);
  const previous = now;
  now += 3_600_000;
  try {
    expect(await store.load(scope)).toBeNull();
    expect(await store.loadBaselineProof(scope, originalDigest)).toEqual(original);
    expect(await store.loadBaselineProof(scope, "f".repeat(64))).toBeNull();
    expect(await store.loadBaselineProof(scope, "invalid")).toBeNull();
    revision++;
    expect(await store.loadBaselineProof(scope, originalDigest)).toBeNull();
    revision--;
  } finally { now = previous; }
});

test("claimed qualification prepares baseline before atomically storing receipt and completion", async () => {
  const { spyOn } = await import("bun:test");
  const { IncusAdmissionReadinessService } = await import("./incus-admission-readiness");
  const { IncusQualificationCheckpointStore } = await import("./incus-qualification-checkpoint");
  const previous = process.env.EZCORP_INCUS_SUPERVISOR_SOCKET;
  process.env.EZCORP_INCUS_SUPERVISOR_SOCKET = "/fixture/control.sock";
  const events: string[] = [];
  const prepare = spyOn(IncusAdmissionReadinessService.prototype, "prepareBaseline").mockImplementation(async (selected, runId, qualification) => {
    expect(selected).toEqual(scope); expect(runId).toBe("claimed"); events.push("prepare");
    return { scope: selected, runId, qualification } as Awaited<ReturnType<InstanceType<typeof IncusAdmissionReadinessService>["prepareBaseline"]>>;
  });
  const record = spyOn(IncusAdmissionReadinessService.prototype, "recordBaseline").mockImplementation(async (_prepared, transaction) => {
    expect(transaction).not.toBe(db); events.push("baseline");
  });
  const complete = spyOn(IncusQualificationCheckpointStore.prototype, "complete").mockImplementation(async (claim, transaction) => {
    expect(claim).toEqual({ runId: "claimed", nonce: "nonce", scope }); expect(transaction).not.toBe(db); events.push("complete");
  });
  try {
    expect(await store.recordVerified(scope, cases(), { runId: "claimed", nonce: "nonce" })).toMatchObject({ producer: "live-provider" });
    expect(events).toEqual(["prepare", "baseline", "complete"]);
  } finally {
    prepare.mockRestore(); record.mockRestore(); complete.mockRestore();
    if (previous === undefined) delete process.env.EZCORP_INCUS_SUPERVISOR_SOCKET;
    else process.env.EZCORP_INCUS_SUPERVISOR_SOCKET = previous;
  }
});

test("claimed baseline persistence keeps unrelated database requests responsive", async () => {
  if (process.env.EZCORP_CONTINUATION_DB_WORKER !== "1") {
    const directory = mkdtempSync(join(tmpdir(), "incus-continuation-db-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern",
      "claimed baseline persistence keeps unrelated database requests responsive"], {
      env: { ...process.env, EZCORP_CONTINUATION_DB_WORKER: "1", EZCORP_CONTINUATION_DB_PATH: directory,
        EZCORP_ENCRYPTION_SECRET: "synthetic-terminal-database-fixture", EZCORP_ENCRYPTION_SALT: "synthetic-fixture-salt" },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      console.log(stdout); console.error(stderr);
      const { client: reopened } = terminalDatabase(directory); await reopened.waitReady;
      try {
        const qualification = await reopened.query("SELECT * FROM incus_live_qualifications");
        const baseline = await reopened.query("SELECT * FROM incus_admission_baselines");
        const run = await reopened.query<{ state: string }>("SELECT state FROM incus_qualification_runs");
        expect(qualification.rows).toHaveLength(exit === 0 ? 1 : 0);
        expect(baseline.rows).toHaveLength(exit === 0 ? 1 : 0);
        expect(run.rows[0]?.state).toBe(exit === 0 ? "COMPLETED" : "CLAIMED");
      } finally { await reopened.close(); }
      expect(exit).toBe(0);
    } finally { clearTimeout(timer); child.kill(); await child.exited; rmSync(directory, { recursive: true, force: true }); }
    return;
  }
  const { IncusQualificationCheckpointStore, currentProcessIdentity, processIdentityKey,
    observationDigest, restartHandoffSigningBytes } = await import("./incus-qualification-checkpoint");
  const { checkpointTestObservation } = await import("./__tests__/incus-qualification-checkpoint-test-observation");
  const handle = { operationId: "qual-primary-claimed-db", sandboxId: "primary-binding" };
  const checkpointScope: IncusQualificationScope = JSON.parse(process.env.EZCORP_CONTINUATION_DB_SCOPE ?? JSON.stringify(scope));
  const checkpointObservation = (processId: string) => {
    const value = checkpointTestObservation(processId);
    value.durable.fixture = { ...value.durable.fixture, ...checkpointScope, operationId: handle.operationId,
      bindingId: handle.sandboxId, connectionRevision: 1 };
    value.durable.binding = { ...value.durable.binding, id: handle.sandboxId, generation: 1 };
    value.durable.operation = { ...value.durable.operation!, generation: 1 };
    value.backend.sandboxId = handle.sandboxId;
    return value;
  };
  if (process.env.EZCORP_CONTINUATION_DB_BEGIN === "1") {
    const identity = currentProcessIdentity();
    await new IncusQualificationCheckpointStore(db).begin({ runId: "claimed-db", nonce: "nonce", scope: checkpointScope, handle,
      deadlineMs: Number(process.env.EZCORP_CONTINUATION_DB_DEADLINE),
      before: checkpointObservation(processIdentityKey(identity)) });
    console.log(JSON.stringify(identity));
    return;
  }
  const { spyOn } = await import("bun:test");
  const { up: addReleases } = await import("../db/migrations/add-extension-releases");
  const { up: addConnections } = await import("../db/migrations/add-provider-connections");
  const { up: addReadiness } = await import("../db/migrations/add-incus-admission-readiness");
  const { up: addRuns } = await import("../db/migrations/add-incus-qualification-runs");
  const { up: completeRuns } = await import("../db/migrations/complete-incus-qualification-runs");
  const { up: addSetups } = await import("../db/migrations/add-incus-operator-setups");
  const { configureReleaseRuntime } = await import("../extensions/release-process");
  const { resolveExtensionReleaseSnapshot } = await import("../extensions/extension-lifecycle-service");
  const { DatabaseLifecycleRepository } = await import("../db/queries/extension-releases");
  const { ExtensionDataMigrations } = await import("../extensions/v4/data-migrations");
  const { ProviderConnectionStore } = await import("./provider-connections/store");
  const { IncusAdmissionReadinessService } = await import("./incus-admission-readiness");
  const { admissionObservation } = await import("./__tests__/incus-admission-observation");
  await addReleases(db); await addConnections(db); await addReadiness(db); await addSetups(db);
  await client.exec("CREATE TABLE extension_storage(extension_id TEXT)");
  await qualifySandboxRuntime(snapshot);
  await client.query("INSERT INTO extension_release_installations VALUES ($1,$2,$3,$4)",
    [snapshot.installation.id, snapshot.installation.ownerId, snapshot.installation.scope, JSON.stringify(snapshot.installation)]);
  const approval = { id: "terminal-approval", releaseId: scope.releaseId, releaseDigest: snapshot.release.releaseDigest,
    status: "consumed", expectedGeneration: snapshot.installation.generation - 1, principalId: snapshot.installation.ownerId,
    scope: snapshot.installation.scope, grants: snapshot.installation.grants };
  for (const [kind, value] of [["releases", snapshot.release], ["approvals", approval]] as const) {
    await client.query("INSERT INTO extension_release_records VALUES ($1,$2,$3,$4)",
      [scope.installationId, kind, value.id, JSON.stringify(value)]);
  }
  await new ProviderConnectionStore(db).create(connection());
  const image = imageReceipt();
  await client.query(`INSERT INTO incus_operator_setups(id,provider_installation_id,provider_release_id,
    provider_release_digest,provider_generation,connection_id,connection_revision,planned_by,recipe,plan,state)
    VALUES ('published',$1,$2,$3,$4,$5,1,'fixture',$6::text::jsonb,'{}','verified')`,
  [scope.installationId,scope.releaseId,snapshot.release.releaseDigest,snapshot.installation.generation,scope.connectionId,JSON.stringify(image.recipe)]);
  await client.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,purpose TEXT);
    CREATE TABLE sandbox_bindings(id TEXT PRIMARY KEY,project_id TEXT,generation INTEGER,desired_state TEXT,
      observed_state TEXT,current_operation_id TEXT,provider_installation_id TEXT,provider_release_id TEXT,
      connection_id TEXT,connection_revision INTEGER,preset_id TEXT);
    CREATE TABLE incus_qualification_fixtures(operation_id TEXT PRIMARY KEY,project_id TEXT,
      binding_id TEXT,installation_id TEXT,release_id TEXT,connection_id TEXT,connection_revision INTEGER,preset_id TEXT);
    CREATE TABLE provider_sandbox_operations(id TEXT PRIMARY KEY,binding_id TEXT,idempotency_scope TEXT,
      idempotency_key TEXT,kind TEXT,state TEXT,generation INTEGER);
    INSERT INTO projects VALUES ('fixture-project','incus-qualification');
    INSERT INTO provider_sandbox_operations VALUES ('stop-operation','primary-binding',NULL,NULL,'STOP','SUCCEEDED',1);
    INSERT INTO provider_sandbox_operations VALUES ('recovery-destroy','recovery-binding','incus-qualification',
      'qual-recovery-claimed-db:destroy','DESTROY','SUCCEEDED',1)`);
  await client.query("INSERT INTO sandbox_bindings VALUES ('primary-binding','fixture-project',1,'STOPPED','STOPPED','stop-operation',$1,$2,$3,1,$4)",
    [scope.installationId,scope.releaseId,scope.connectionId,scope.presetId]);
  for (const [operation, binding] of [[handle.operationId,handle.sandboxId],["qual-recovery-claimed-db","recovery-binding"]]) {
    await client.query("INSERT INTO incus_qualification_fixtures VALUES ($1,'fixture-project',$2,$3,$4,$5,1,$6)",
      [operation,binding,scope.installationId,scope.releaseId,scope.connectionId,scope.presetId]);
  }
  await addRuns(db); await completeRuns(db);
  await client.close();
  const deadlineMs = Date.now() + 60_000;
  const writer = Bun.spawn([process.execPath,"test",import.meta.path,"--test-name-pattern",
    "claimed baseline persistence keeps unrelated database requests responsive"], {
    env: { ...process.env, EZCORP_CONTINUATION_DB_BEGIN: "1", EZCORP_CONTINUATION_DB_SCOPE: JSON.stringify(scope), EZCORP_CONTINUATION_DB_DEADLINE: String(deadlineMs) },
    stdout: "pipe",stderr: "pipe" });
  const writerTimer = setTimeout(() => writer.kill(),5_000);
  let oldProcess: ReturnType<typeof currentProcessIdentity>;
  try {
    const [exit,stdout,stderr] = await Promise.all([writer.exited,new Response(writer.stdout).text(),new Response(writer.stderr).text()]);
    expect(exit,stderr).toBe(0);
    oldProcess = JSON.parse(stdout.trim().split("\n").find(line => line.startsWith("{"))!);
  } finally { clearTimeout(writerTimer); writer.kill(); await writer.exited; }
  ({ client,db } = terminalDatabase(process.env.EZCORP_CONTINUATION_DB_PATH));
  await client.waitReady;
  const repository = new DatabaseLifecycleRepository(db);
  const migrations = new ExtensionDataMigrations(db, async () => { throw new Error("No migration effects in fixture"); });
  configureReleaseRuntime({ runner: async () => { throw new Error("No extension worker effects in fixture"); },
    resolve: (id, transaction) => resolveExtensionReleaseSnapshot(repository, migrations, id, transaction) });
  const keys = generateKeyPairSync("ed25519");
  const checkpoints = new IncusQualificationCheckpointStore(db,keys.publicKey.export({ type: "spki",format: "pem" }).toString());
  const assertObjectColumns = async (table: string, columns: string[]) => {
    const row = (await client.query<Record<string,string>>(`SELECT ${columns.map(column =>
      `jsonb_typeof(${column}) AS ${column}`).join(",")} FROM ${table}`)).rows[0];
    expect(row).toEqual(Object.fromEntries(columns.map(column => [column,"object"])));
    console.log("Actual stored JSON object types:",table,row);
  };
  const pending = await checkpoints.get("claimed-db");
  console.log("Actual checkpoint begin JSON types",(await client.query(`SELECT jsonb_typeof(scope) AS scope,
    jsonb_typeof(before_observation) AS before,jsonb_typeof(old_process_identity) AS process FROM incus_qualification_runs`)).rows);
  expect(pending?.scope).toEqual(scope);
  await assertObjectColumns("incus_qualification_runs",["scope","before_observation","old_process_identity"]);
  const newProcess = currentProcessIdentity();
  const after = checkpointObservation(processIdentityKey(newProcess));
  const payload = { version: 1 as const,runId: "claimed-db",nonce: "nonce",deadlineMs,scope,
    fixtureOperationId: handle.operationId,bindingId: handle.sandboxId,generation: 1,connectionRevision: 1,
    lastOperationId: "stop-operation",oldProcess,newProcess,beforeDigest: observationDigest(checkpointObservation(processIdentityKey(oldProcess))),
    afterDigest: observationDigest(after) };
  const receipt = { payload,signature: sign(null,restartHandoffSigningBytes(payload),keys.privateKey).toString("base64") };
  await checkpoints.claim({ runId: "claimed-db",nonce: "nonce",receipt,after });
  expect((await checkpoints.get("claimed-db"))?.receipt).toEqual(receipt);
  await assertObjectColumns("incus_qualification_runs",["receipt","after_observation"]);
  await expect(checkpoints.claim({ runId: "claimed-db",nonce: "nonce",receipt,after })).rejects.toThrow("unavailable");
  const realStore = new IncusQualificationStore({ db, probe: async () => probeResult(), now: () => now });
  const service = new IncusAdmissionReadinessService(db, realStore,
    { read: async pin => admissionObservation(pin, Date.now()) });
  await service.capture(scope, "claimed-db");
  await assertObjectColumns("incus_qualification_authority_captures",["scope","pins","authority"]);
  const originalPrepare = IncusAdmissionReadinessService.prototype.prepareBaseline;
  const prepare = spyOn(IncusAdmissionReadinessService.prototype, "prepareBaseline")
    .mockImplementation((selected, run, qualification) => originalPrepare.call(service, selected, run, qualification));
  const originalRecord = IncusAdmissionReadinessService.prototype.recordBaseline;
  let sharedQueryFinished = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
    await db.execute(sql`SELECT 1`); sharedQueryFinished = true; return new Response("database responsive");
  } });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let request: Promise<Response> | undefined;
  type Transaction = NonNullable<Parameters<typeof originalRecord>[1]>;
  let mutate: ((transaction: Transaction) => Promise<unknown>) | undefined;
  const record = spyOn(IncusAdmissionReadinessService.prototype, "recordBaseline").mockImplementation(async function(this: InstanceType<typeof IncusAdmissionReadinessService>, prepared, transaction) {
    console.log("Actual recordVerified transaction entered actual recordBaseline; unrelated HTTP database read started");
    sharedQueryFinished = false;
    request = fetch(server.url);
    deadline = setTimeout(() => {
      console.log(JSON.stringify({ blockedBaselineAuthorization: true, unrelatedDatabaseReadFinished: sharedQueryFinished }));
      process.exit(23);
    }, 700);
    await mutate?.(transaction!);
    return originalRecord.call(this, prepared, transaction);
  });
  process.env.EZCORP_INCUS_SUPERVISOR_SOCKET = "/synthetic/unused.sock";
  try {
    const mutations: [string, (transaction: Transaction) => Promise<unknown>][] = [
      ["generation", tx => tx.execute(sql`UPDATE extension_release_installations SET payload =
        ${JSON.stringify({ ...snapshot.installation, generation: 2, acknowledgedGeneration: 2 })} WHERE id = ${scope.installationId}`)],
      ["grants", tx => tx.execute(sql`UPDATE extension_release_records SET payload =
        ${JSON.stringify({ ...approval, grants: ["unapproved-synthetic-grant"] })} WHERE kind = 'approvals' AND id = 'terminal-approval'`)],
      ["approval revocation", tx => tx.execute(sql`UPDATE extension_release_records SET payload =
        ${JSON.stringify({ ...approval, status: "revoked" })} WHERE kind = 'approvals' AND id = 'terminal-approval'`)],
      ["connection revision", tx => tx.execute(sql`UPDATE provider_connections SET revision = revision + 1 WHERE id = ${scope.connectionId}`)],
      ["connection settings", tx => tx.execute(sql`UPDATE provider_connections SET configuration =
        jsonb_set(configuration,'{profile}','"changed"') WHERE id = ${scope.connectionId}`)],
      ["published image", tx => tx.execute(sql`UPDATE incus_operator_setups SET recipe =
        jsonb_set(recipe,'{guestImage,fingerprint}',${JSON.stringify("0".repeat(64))}::text::jsonb) WHERE id = 'published'`)],
    ];
    for (const [name, change] of mutations) {
      mutate = change;
      await expect(realStore.recordVerified(scope, cases(), { runId: "claimed-db", nonce: "nonce" })).rejects.toThrow();
      clearTimeout(deadline);
      expect((await request!).status).toBe(200); expect(sharedQueryFinished).toBe(true);
      expect((await client.query("SELECT * FROM incus_live_qualifications")).rows).toHaveLength(0);
      expect((await client.query("SELECT * FROM incus_admission_baselines")).rows).toHaveLength(0);
      expect((await client.query<{ state: string }>("SELECT state FROM incus_qualification_runs")).rows[0]?.state).toBe("CLAIMED");
      console.log("Uncommitted authority drift denied and terminal writes rolled back:", name);
    }
    mutate = undefined;
    await realStore.recordVerified(scope, cases(), { runId: "claimed-db", nonce: "nonce" });
    expect((await request!).status).toBe(200); expect(sharedQueryFinished).toBe(true);
    await assertObjectColumns("incus_live_qualifications",["probe_observation","live_observation","qualification"]);
    await assertObjectColumns("incus_admission_baselines",["pins","authority"]);
    expect(await realStore.load(scope)).toMatchObject({ producer: "live-provider",connectionId: scope.connectionId });
    console.log("Actual terminal persistence and unrelated HTTP database request completed");
  } finally {
    clearTimeout(deadline); server.stop(true); record.mockRestore(); prepare.mockRestore();
    delete process.env.EZCORP_INCUS_SUPERVISOR_SOCKET;
  }
}, 25_000);

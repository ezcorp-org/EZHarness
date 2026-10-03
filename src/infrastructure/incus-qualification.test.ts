import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { LIVE_SANDBOX_QUALIFICATION_CASES, sandboxPresetDigest, type SandboxCompatibilityObservation } from "@ezcorp/extension-contract";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import recipeTemplate from "../../scripts/incus/recipe.json";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
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
const imageReceipt = (): IncusImageReceipt => ({
  providerReleaseId: scope.releaseId, providerReleaseDigest: snapshot.release.releaseDigest,
  connectionId: scope.connectionId, connectionRevision: revision, state: "verified",
  recipe: { ...structuredClone(recipeTemplate), profile: { ...recipeTemplate.profile, name: "ezharness" },
    guestImage: { ...recipeTemplate.guestImage, fingerprint: preset.imageDigest,
      sourceFingerprint: "a".repeat(64), helperSha256: guestHelperSha256(),
      pythonPackageVersion: "3.12.1", dockerArchiveSha256: "b".repeat(64), composeSha256: "c".repeat(64) } } as IncusSetupRecipe,
});

const client = new PGlite();
const db = drizzle(client);
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
const store = new IncusQualificationStore({ db,
  activeRelease: async () => snapshot,
  connectionRevision: async () => revision,
  imageReceipt: async () => imageReceipt(),
  resolveConnection: async () => connection(),
  probe: async () => { probeCalls++; return {
    serverCertificateSha256: certificateSha256, project: "sandbox", profile: "ezharness",
    helperVersion: "unverified", backendApi: negativeProbe ? "unsupported" : observation.backendApi,
    backendVersion: observation.backendVersion, architecture: observation.architecture,
    storageDriver: "unverified", isolation: observation.isolation, nestedCompose: false,
    controls: { restrictedProject: true, unprivileged: false, projectLimits: false, privateNetwork: false,
      workspaceRoot: "/workspace", explicitGuestUser: false, atomicFileReplace: false,
      durableProcesses: false, boundedOutput: false, endpointProxy: false },
  }; },
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

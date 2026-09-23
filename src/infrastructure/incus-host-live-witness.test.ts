import { expect, test } from "bun:test";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import recipe from "../../scripts/incus/recipe.json";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import type { Database } from "../db/connection";
import { incusQualificationFixtures } from "../db/schema";
import { IncusHostLiveWitness } from "./incus-host-live-witness";
import type { IncusQualificationFixtureService, IncusQualificationStore } from "./incus-qualification";

const scope = { installationId: "installation", releaseId: "release", connectionId: "connection",
  presetId: INCUS_PRESETS[0]!.id };
const handle = { sandboxId: "fixture-binding", operationId: "fixture-operation" };
const witness = new IncusHostLiveWitness({ db: {} as Database,
  qualifications: {} as IncusQualificationStore,
  fixtures: {} as IncusQualificationFixtureService });

test("every unmeasured host probe denies instead of reporting a passing fact", async () => {
  const preset = INCUS_PRESETS[0]!;
  for (const call of [
    () => witness.controlFacts(scope, preset),
    () => witness.observeEnforcement(handle),
    () => witness.exerciseLimits(handle),
    () => witness.restartController(),
    () => witness.exerciseFailedCleanupRecovery(handle, handle),
  ]) await expect(call()).rejects.toThrow("Incus live witness unavailable");
});

test("observe requires exact verified setup and rejects forged backend artifact readback", async () => {
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const connection = { revision: 1, configuration: { profile: "compose" } };
  const selected = { snapshot: { release: { releaseDigest: "a".repeat(64) } }, connection,
    preset, presetDigest, effectiveSettingsDigest: "b".repeat(64) };
  const setup = { state: "verified", providerReleaseId: scope.releaseId,
    providerReleaseDigest: selected.snapshot.release.releaseDigest,
    connectionId: scope.connectionId, connectionRevision: 1, recipe: recipe as IncusSetupRecipe };
  const observed = { observation: { backendApi: "incus.v1", backendVersion: "6.0.6",
    architecture: "amd64" as const, storageDriver: "btrfs", isolation: "container" as const,
    nestedCompose: true }, imageDigest: preset.imageDigest,
    helperDigest: preset.helperDigests[0]!, profile: preset.profile };
  const candidate = (receipt: typeof setup, image: typeof observed) => new IncusHostLiveWitness({
    db: {} as Database,
    qualifications: { authorizeFixture: async () => selected } as unknown as IncusQualificationStore,
    fixtures: {} as IncusQualificationFixtureService,
    readSetup: async () => receipt,
    backend: { image: async () => image, instance: async () => ({ state: "absent" }) },
  });
  expect(await candidate(setup, observed).observe(scope, preset)).toEqual(observed);
  await expect(candidate({ ...setup, connectionId: "forged" }, observed).observe(scope, preset))
    .rejects.toThrow("verified setup");
  await expect(candidate(setup, { ...observed, imageDigest: "f".repeat(64) }).observe(scope, preset))
    .rejects.toThrow("backend artifact");
  await expect(candidate(setup, { ...observed, helperDigest: "f".repeat(64) }).observe(scope, preset))
    .rejects.toThrow("backend artifact");
});

test("inspection rejects a backend state that disagrees with the durable fixture", async () => {
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const selected = { snapshot: { release: { releaseDigest: "a".repeat(64) } },
    connection: { revision: 1, configuration: { profile: "compose", guestUser: "sandbox" } },
    preset, presetDigest, effectiveSettingsDigest: "b".repeat(64) };
  const fixture = { ...scope, operationId: handle.operationId, bindingId: handle.sandboxId,
    projectId: "project", connectionRevision: 1, presetDigest,
    effectiveSettingsDigest: selected.effectiveSettingsDigest };
  const binding = { id: handle.sandboxId, projectId: fixture.projectId, resourceKey: handle.sandboxId,
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    connectionId: scope.connectionId, connectionRevision: 1, presetId: preset.id, presetDigest,
    effectiveSettingsDigest: selected.effectiveSettingsDigest, tombstonedAt: null,
    observedState: "STOPPED", desiredState: "STOPPED" };
  const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({
    limit: async () => table === incusQualificationFixtures ? [fixture] : [binding],
  }) }) }) } as unknown as Database;
  const setup = { state: "verified", providerReleaseId: scope.releaseId,
    providerReleaseDigest: selected.snapshot.release.releaseDigest,
    connectionId: scope.connectionId, connectionRevision: 1, recipe: recipe as IncusSetupRecipe };
  const candidate = new IncusHostLiveWitness({ db,
    qualifications: { authorizeFixture: async () => selected } as unknown as IncusQualificationStore,
    fixtures: {} as IncusQualificationFixtureService, readSetup: async () => setup,
    backend: { image: async () => { throw new Error("unused"); },
      instance: async () => ({ state: "absent" }) },
  });
  await expect(candidate.inspectFixture(handle)).rejects.toThrow("backend and durable fixture state disagree");
  binding.observedState = "ABSENT";
  binding.desiredState = "ABSENT";
  expect(await candidate.inspectFixture(handle)).toMatchObject({ sandboxId: handle.sandboxId, state: "absent" });
});

test("discarded create reply must replay the same durable fixture operation", async () => {
  let calls = 0;
  let cleanups = 0;
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const service = { create: async () => ({ id: `operation-${++calls}`, bindingId: "binding" }),
    destroy: async () => { cleanups++; return { state: "SUCCEEDED" }; } };
  const candidate = new IncusHostLiveWitness({ db: {} as Database,
    qualifications: { authorizeFixture: async () => ({ preset, presetDigest }) } as unknown as IncusQualificationStore,
    fixtures: service as unknown as IncusQualificationFixtureService });
  await expect(candidate.createFixture(scope, preset, "fixture", true))
    .rejects.toThrow("replay allocated another fixture");
  expect(calls).toBe(2);
  expect(cleanups).toBe(1);
});

test("guest paths and process requests deny unsafe inputs before any fixture effect", async () => {
  for (const path of ["/etc/passwd", "../outside", "a//b", "a\\b", "a\0b"]) {
    await expect(witness.writeFile(handle, path, new Uint8Array([1]))).rejects.toThrow("invalid guest path");
    await expect(witness.readFile(handle, path)).rejects.toThrow("invalid guest path");
  }
  await expect(witness.writeFile(handle, "large", new Uint8Array(64 * 1024 + 1)))
    .rejects.toThrow("file exceeds one verified guest write");
  await expect(witness.run(handle, [], 1000)).rejects.toThrow("invalid guest process request");
  await expect(witness.run(handle, ["true"], 120_001)).rejects.toThrow("invalid guest process request");
});

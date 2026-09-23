import { expect, test } from "bun:test";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import type { Database } from "../db/connection";
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
    () => witness.observe(scope, preset),
    () => witness.controlFacts(scope, preset),
    () => witness.inspectFixture(handle),
    () => witness.observeEnforcement(handle),
    () => witness.exerciseLimits(handle),
    () => witness.restartController(),
    () => witness.exerciseFailedCleanupRecovery(handle, handle),
  ]) await expect(call()).rejects.toThrow("Incus live witness unavailable");
});

test("discarded create reply must replay the same durable fixture operation", async () => {
  let calls = 0;
  let cleanups = 0;
  const service = { create: async () => ({ id: `operation-${++calls}`, bindingId: "binding" }),
    destroy: async () => { cleanups++; return { state: "SUCCEEDED" }; } };
  const candidate = new IncusHostLiveWitness({ db: {} as Database,
    qualifications: { authorizeFixture: async () => ({ preset: INCUS_PRESETS[0]! }) } as unknown as IncusQualificationStore,
    fixtures: service as unknown as IncusQualificationFixtureService });
  await expect(candidate.createFixture(scope, INCUS_PRESETS[0]!, "fixture", true))
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

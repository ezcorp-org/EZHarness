import { expect, mock, spyOn, test } from "bun:test";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import type { Database } from "../db/connection";
import { incusQualificationFixtures } from "../db/schema";
import type { IncusQualificationFixtureService, IncusQualificationStore } from "./incus-qualification";
import { ProviderConnectionStore } from "./provider-connections/store";

const releaseProcess = await import("../extensions/release-process");
const events: string[] = [];
let fail = false;

class TestReleaseProcess {
  constructor(installationId: string) { events.push(`open:${installationId}`); }
  async callIncusSandboxOperation(bindingId: string, operation: string, input: Record<string, unknown>) {
    events.push(`call:${bindingId}:${operation}:${input.connectionId}`);
    if (fail) throw new Error("guest call failed");
    return { result: { ok: true, path: input.path, revision: "revision-1", sizeBytes: 2 } };
  }
  kill() { events.push("kill"); }
  async whenCallsSettled() { events.push("settled"); }
}

mock.module("../extensions/release-process", () => ({ ...releaseProcess, ReleaseProcess: TestReleaseProcess,
  getReleaseRuntime: () => ({}),
  resolveActiveRelease: async () => ({ installation: { id: "installation", activeReleaseId: "release" },
    release: { id: "release" } }),
}));
const { IncusHostLiveWitness } = await import("./incus-host-live-witness");

test("default guest caller closes its release process after success and failure", async () => {
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const scope = { installationId: "installation", releaseId: "release", connectionId: "connection",
    presetId: preset.id };
  const handle = { sandboxId: "binding", operationId: "fixture" };
  const fixture = { ...scope, operationId: handle.operationId, bindingId: handle.sandboxId,
    projectId: "project", connectionRevision: 1, presetDigest, effectiveSettingsDigest: "b".repeat(64) };
  const binding = { id: handle.sandboxId, projectId: fixture.projectId, resourceKey: handle.sandboxId,
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    connectionId: scope.connectionId, connectionRevision: 1, presetId: preset.id, presetDigest,
    effectiveSettingsDigest: fixture.effectiveSettingsDigest, tombstonedAt: null,
    desiredState: "RUNNING", observedState: "RUNNING", generation: 1 };
  const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({
    limit: async () => table === incusQualificationFixtures ? [fixture] : [binding],
  }) }) }) } as unknown as Database;
  const resolve = spyOn(ProviderConnectionStore.prototype, "resolveForHost").mockImplementation(async () => ({
    id: scope.connectionId, revision: 1, revokedAt: null,
    configuration: { kind: "incus", guestUser: "sandbox" },
  }) as never);
  const witness = new IncusHostLiveWitness({ db,
    qualifications: { authorizeFixture: async () => ({ connection: { revision: 1 }, preset,
      presetDigest, effectiveSettingsDigest: fixture.effectiveSettingsDigest }) } as unknown as IncusQualificationStore,
    fixtures: {} as IncusQualificationFixtureService,
  });
  await witness.writeFile(handle, "marker", new TextEncoder().encode("ok"));
  expect(events.splice(0)).toEqual(["open:installation", "call:binding:files.writeAtomic:connection", "kill", "settled"]);
  fail = true;
  await expect(witness.writeFile(handle, "marker", new TextEncoder().encode("ok"))).rejects.toThrow("guest call failed");
  expect(events.splice(0)).toEqual(["open:installation", "call:binding:files.writeAtomic:connection", "kill", "settled"]);
  fail = false;
  expect(resolve).toHaveBeenCalledTimes(2);
  resolve.mockRestore();
});

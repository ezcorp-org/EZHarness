import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { referenceCodeModelPin, referenceCodeV1, referenceImageV1, referenceS3ReleaseAdapter } from "@ezcorp/factory-sdk";
import { FACTORY_INSTALLATION_S3_RELEASE_DESTINATION } from "../src/factory/provisioning/deployment";
import { parseFactoryFleetRunnerProfiles, parseFactoryFleetSettings } from "../src/factory/provisioning/fleet";
import { makeFactoryTestFleetSettings } from "../src/__tests__/helpers/factory-private-root";
import { LOCAL_MODEL_PROVIDER, LOCAL_RELEASE, LOCAL_RUNNER_PROFILES, factoryFleetInitOptions, localFleetRelease, startFactoryFleetInit } from "./factory-fleet-init-local";

const env = { FACTORY_TEST_POSTGRES_URL: "postgres://u:p@127.0.0.1:5432/db", EZCORP_FACTORY_STORAGE_SECRETS_DIR: "/run/user/1/storage" };

test("options come from flags and the environment, with the pinned local runner", () => {
  const options = factoryFleetInitOptions(["bun", "x", "--fleet", "w16", "--root", "/home/u/fleet", "--image", "img@sha256:x", "--revision", "r"], env, "/bin/bun");
  expect(options).toMatchObject({ fleetId: "w16", root: "/home/u/fleet", image: "img@sha256:x", revision: "r", portBase: 31000, adminUrl: env.FACTORY_TEST_POSTGRES_URL, storageSecretsDirectory: env.EZCORP_FACTORY_STORAGE_SECRETS_DIR, bun: "/bin/bun", runnerProfiles: LOCAL_RUNNER_PROFILES, modelProvider: LOCAL_MODEL_PROVIDER });
  expect(options.release).toEqual(LOCAL_RELEASE.release);
  expect(factoryFleetInitOptions(["--fleet", "w", "--root", "/r", "--image", "i", "--revision", "r", "--port-base", "40000"], env, "/bin/bun").portBase).toBe(40000);
  expect(() => factoryFleetInitOptions(["--root", "/r"], env, "/bin/bun")).toThrow("--fleet is required");
  expect(() => factoryFleetInitOptions(["--fleet", "w", "--root", "/r", "--image", "i", "--revision", "r"], {}, "/bin/bun")).toThrow("FACTORY_TEST_POSTGRES_URL");
});

test("the reference S3 publication adapter is a published, locked artifact, so the local fleet declares the default S3 release profile (W4H-28)", () => {
  const [s3Publication] = referenceImageV1.graph.nodes.flatMap((node) => node.kind === "release" ? [node.adapter] : []);
  expect(s3Publication).toEqual(referenceS3ReleaseAdapter);
  expect(s3Publication!.digest).not.toMatch(/^sha256:([0-9a-f])\1{63}$/);
  expect(LOCAL_RELEASE).toEqual({ release: { profiles: [{ adapter: referenceS3ReleaseAdapter, action: "factory.release.publish", destination: FACTORY_INSTALLATION_S3_RELEASE_DESTINATION, estimatedSpendMicros: 1_000 }] }, refused: [] });
  const settings = makeFactoryTestFleetSettings();
  expect(parseFactoryFleetSettings({ ...settings, installations: { ...settings.installations, release: LOCAL_RELEASE.release } }).installations.release).toEqual(LOCAL_RELEASE.release as never);
});

test("an adapter with a real digest becomes the S3 release profile, and the fleet parser accepts it", () => {
  const adapter = { package: "@ezcorp/s3-immutable-publish", manifestName: "s3-immutable-publish", version: "1.0.1", digest: `sha256:${"0123456789abcdef".repeat(4)}`, export: "publish" };
  const placeholder = { ...adapter, version: "1.0.0", digest: `sha256:${"d".repeat(64)}` };
  const { release, refused } = localFleetRelease([placeholder, adapter]);
  expect(release).toEqual({ profiles: [{ adapter, action: "factory.release.publish", destination: FACTORY_INSTALLATION_S3_RELEASE_DESTINATION, estimatedSpendMicros: 1_000 }] });
  expect(refused).toHaveLength(1);
  const settings = makeFactoryTestFleetSettings();
  expect(parseFactoryFleetSettings({ ...settings, installations: { ...settings.installations, release } }).installations.release).toEqual(release as never);
});

test("the entry runs only as the process entry and returns the written settings path", async () => {
  const script = "/opt/repo/scripts/factory-fleet-init-local.ts";
  const written: unknown[] = [];
  const write = async (options: unknown) => { written.push(options); return { settingsPath: "/r/fleet.json", settings: {} as never }; };
  expect(await startFactoryFleetInit(["bun"], pathToFileURL(script).href, write)).toBeUndefined();
  const original = { ...process.env };
  Object.assign(process.env, env);
  try { expect(await startFactoryFleetInit(["bun", script, "--fleet", "w", "--root", "/r", "--image", "i", "--revision", "r"], pathToFileURL(script).href, write)).toBe("/r/fleet.json"); }
  finally { for (const key of Object.keys(env)) if (!(key in original)) delete process.env[key]; }
  expect(written).toHaveLength(1);
});

test("the local fleet declares every reference.code.v1 task runner, generateCandidate pinned to the installation's model, and the startup parser admits them (W4H-26, W4H-28)", () => {
  const declared = LOCAL_RUNNER_PROFILES.profiles.map(profile => profile.runner);
  const runners = referenceCodeV1.graph.nodes.flatMap(node => node.kind === "task" ? [node.runner] : []);
  expect(runners.map(runner => runner.export)).toEqual(["snapshotRepository", "generateCandidate", "freezeGitTree", "protectedChecks"]);
  for (const runner of runners) expect(declared as unknown[]).toContainEqual(runner);
  for (const profile of LOCAL_RUNNER_PROFILES.profiles) expect(profile.allocation.budget.tokens).toBe(50_000);
  const generate = LOCAL_RUNNER_PROFILES.profiles.find(profile => profile.runner.export === "generateCandidate")!;
  expect(generate.model).toEqual(referenceCodeModelPin);
  expect(LOCAL_MODEL_PROVIDER).toMatchObject({ provider: referenceCodeModelPin.provider, model: referenceCodeModelPin.model });
  expect(() => parseFactoryFleetRunnerProfiles(LOCAL_RUNNER_PROFILES, LOCAL_MODEL_PROVIDER)).not.toThrow();
  // Without the installation's model, a pinned profile is refused: the pin must be the installation's own.
  expect(() => parseFactoryFleetRunnerProfiles(LOCAL_RUNNER_PROFILES)).toThrow("installations.runnerProfiles");
});

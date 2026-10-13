import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { referenceImageV1 } from "@ezcorp/factory-sdk";
import { FACTORY_INSTALLATION_S3_RELEASE_DESTINATION } from "../src/factory/provisioning/deployment";
import { parseFactoryFleetSettings } from "../src/factory/provisioning/fleet";
import { makeFactoryTestFleetSettings } from "../src/__tests__/helpers/factory-private-root";
import { LOCAL_RELEASE, LOCAL_RUNNER_PROFILES, factoryFleetInitOptions, startFactoryFleetInit } from "./factory-fleet-init-local";

const env = { FACTORY_TEST_POSTGRES_URL: "postgres://u:p@127.0.0.1:5432/db", EZCORP_FACTORY_STORAGE_SECRETS_DIR: "/run/user/1/storage" };

test("options come from flags and the environment, with the pinned local runner", () => {
  const options = factoryFleetInitOptions(["bun", "x", "--fleet", "w16", "--root", "/home/u/fleet", "--image", "img@sha256:x", "--revision", "r"], env, "/bin/bun");
  expect(options).toMatchObject({ fleetId: "w16", root: "/home/u/fleet", image: "img@sha256:x", revision: "r", portBase: 31000, adminUrl: env.FACTORY_TEST_POSTGRES_URL, storageSecretsDirectory: env.EZCORP_FACTORY_STORAGE_SECRETS_DIR, bun: "/bin/bun", runnerProfiles: LOCAL_RUNNER_PROFILES, release: LOCAL_RELEASE });
  expect(factoryFleetInitOptions(["--fleet", "w", "--root", "/r", "--image", "i", "--revision", "r", "--port-base", "40000"], env, "/bin/bun").portBase).toBe(40000);
  expect(() => factoryFleetInitOptions(["--root", "/r"], env, "/bin/bun")).toThrow("--fleet is required");
  expect(() => factoryFleetInitOptions(["--fleet", "w", "--root", "/r", "--image", "i", "--revision", "r"], {}, "/bin/bun")).toThrow("FACTORY_TEST_POSTGRES_URL");
});

test("a local fleet declares one default S3 release profile: the reference definitions' S3 publication adapter, to each installation's own store", () => {
  const [s3Publication] = referenceImageV1.graph.nodes.flatMap((node) => node.kind === "release" ? [node.adapter] : []);
  const { package: name, manifestName, version, digest, export: exportName } = s3Publication!;
  expect(LOCAL_RELEASE).toEqual({ profiles: [{ adapter: { package: name, manifestName, version, digest, export: exportName }, action: "factory.release.publish", destination: FACTORY_INSTALLATION_S3_RELEASE_DESTINATION, estimatedSpendMicros: 1_000 }] });
  expect(LOCAL_RELEASE.profiles[0]!.adapter).toMatchObject({ package: "@ezcorp/s3-immutable-publish", export: "publish" });
  expect(LOCAL_RELEASE.github).toBeUndefined();
  // The settings the local fleet writes carry it, and the startup parser behind the fleet parser accepts it.
  const settings = makeFactoryTestFleetSettings();
  expect(parseFactoryFleetSettings({ ...settings, installations: { ...settings.installations, release: LOCAL_RELEASE } }).installations.release).toEqual(LOCAL_RELEASE as never);
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

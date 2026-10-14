import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { referenceCodeV1 } from "@ezcorp/factory-sdk";
import { parseFactoryFleetRunnerProfiles } from "../src/factory/provisioning/fleet";
import { LOCAL_RUNNER_PROFILES, factoryFleetInitOptions, startFactoryFleetInit } from "./factory-fleet-init-local";

const env = { FACTORY_TEST_POSTGRES_URL: "postgres://u:p@127.0.0.1:5432/db", EZCORP_FACTORY_STORAGE_SECRETS_DIR: "/run/user/1/storage" };

test("options come from flags and the environment, with the pinned local runner", () => {
  const options = factoryFleetInitOptions(["bun", "x", "--fleet", "w16", "--root", "/home/u/fleet", "--image", "img@sha256:x", "--revision", "r"], env, "/bin/bun");
  expect(options).toMatchObject({ fleetId: "w16", root: "/home/u/fleet", image: "img@sha256:x", revision: "r", portBase: 31000, adminUrl: env.FACTORY_TEST_POSTGRES_URL, storageSecretsDirectory: env.EZCORP_FACTORY_STORAGE_SECRETS_DIR, bun: "/bin/bun", runnerProfiles: LOCAL_RUNNER_PROFILES });
  expect(factoryFleetInitOptions(["--fleet", "w", "--root", "/r", "--image", "i", "--revision", "r", "--port-base", "40000"], env, "/bin/bun").portBase).toBe(40000);
  expect(() => factoryFleetInitOptions(["--root", "/r"], env, "/bin/bun")).toThrow("--fleet is required");
  expect(() => factoryFleetInitOptions(["--fleet", "w", "--root", "/r", "--image", "i", "--revision", "r"], {}, "/bin/bun")).toThrow("FACTORY_TEST_POSTGRES_URL");
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

test("the local fleet declares reference.code.v1's guest task runners with a slugify-sized budget, and the startup parser admits them (W4H-26)", () => {
  const declared = LOCAL_RUNNER_PROFILES.profiles.map(profile => profile.runner);
  const runners = referenceCodeV1.graph.nodes.flatMap(node => node.kind === "task" && ["snapshotRepository", "freezeGitTree"].includes(node.runner.export) ? [node.runner] : []);
  expect(runners).toHaveLength(2);
  for (const runner of runners) expect(declared as unknown[]).toContainEqual(runner);
  for (const profile of LOCAL_RUNNER_PROFILES.profiles) expect(profile.allocation.budget.tokens).toBe(50_000);
  expect(() => parseFactoryFleetRunnerProfiles(LOCAL_RUNNER_PROFILES)).not.toThrow();
});

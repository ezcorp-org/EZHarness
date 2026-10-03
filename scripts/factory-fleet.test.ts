import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { factoryFleetComposeCommand, startFactoryFleetCli } from "./factory-fleet";

test("the Compose client is resolved by the repository's engine rule", () => {
  expect(factoryFleetComposeCommand({}, 1001, (name) => name === "podman", () => true)).toEqual({ argv: ["docker", "compose"], env: { DOCKER_HOST: "unix:///run/user/1001/podman/podman.sock" } });
  expect(factoryFleetComposeCommand({ DOCKER_HOST: "unix:///custom.sock" }, 1001, () => true, () => false)).toEqual({ argv: ["docker", "compose"], env: { DOCKER_HOST: "unix:///custom.sock" } });
  expect(factoryFleetComposeCommand({ EZCORP_CONTAINER_ENGINE: "docker" }, 1001, () => true, () => false)).toEqual({ argv: ["docker", "compose"], env: {} });
  expect(() => factoryFleetComposeCommand({}, 1001, (name) => name === "podman", () => false)).toThrow();
});

test("the entry runs only as the process entry, and hands the arguments after the script to the commands", async () => {
  const script = "/opt/repo/scripts/factory-fleet.ts";
  const calls: unknown[] = [];
  const run = async (argv: readonly string[]) => { calls.push(argv); };
  expect(startFactoryFleetCli(["bun"], pathToFileURL(script).href, run)).toBeUndefined();
  expect(startFactoryFleetCli(["bun", "/opt/other.ts"], pathToFileURL(script).href, run)).toBeUndefined();
  await startFactoryFleetCli(["bun", script, "/fleet.json", "status"], pathToFileURL(script).href, run);
  expect(calls).toEqual([["/fleet.json", "status"]]);
});

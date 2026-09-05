import { expect, test } from "bun:test";
import { createLazyExtensionRunner, getConfiguredExtensionRunner } from "./runner-connection";
import { RunnerClient } from "@ezcorp/extension-runner";
import type { Runner } from "@ezcorp/extension-contract";

test("runner configuration is deferred until execution and rejects absent or unsafe settings", async () => {
  const previousSocket = process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
  const previousToken = process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
  try {
    delete process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
    delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
    const runner = createLazyExtensionRunner();
    for (const invoke of [() => runner.build({} as never), () => runner.start({} as never, async () => null), () => runner.cancel("id"), () => runner.inspect("id"), () => runner.collectArtifacts("digest")]) await expect(invoke()).rejects.toMatchObject({ code: "runner_unconfigured" });
    process.env.EZCORP_EXTENSION_RUNNER_SOCKET = "relative/socket";
    process.env.EZCORP_EXTENSION_RUNNER_TOKEN = "a".repeat(32);
    expect(() => getConfiguredExtensionRunner()).toThrow();
    process.env.EZCORP_EXTENSION_RUNNER_SOCKET = "/tmp/runner-test.sock";
    process.env.EZCORP_EXTENSION_RUNNER_TOKEN = "short";
    expect(() => getConfiguredExtensionRunner()).toThrow();
    process.env.EZCORP_EXTENSION_RUNNER_TOKEN = "a".repeat(32);
    expect(getConfiguredExtensionRunner()).toBeInstanceOf(RunnerClient);
  } finally {
    if (previousSocket === undefined) delete process.env.EZCORP_EXTENSION_RUNNER_SOCKET; else process.env.EZCORP_EXTENSION_RUNNER_SOCKET = previousSocket;
    if (previousToken === undefined) delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN; else process.env.EZCORP_EXTENSION_RUNNER_TOKEN = previousToken;
  }
});

test("lazy runner forwards every operation and resolves the current connection each time", async () => {
  const calls: unknown[][] = [];
  let resolutions = 0;
  const resolved = Object.fromEntries(["build", "start", "cancel", "inspect", "collectArtifacts"].map((method) => [method, async (...args: unknown[]) => { calls.push([method, ...args]); return method; }])) as unknown as Runner;
  const runner = createLazyExtensionRunner(() => { resolutions++; return resolved; });
  expect(resolutions).toBe(0);
  const input = {} as never;
  const reverse = async () => null;
  await runner.build(input); await runner.start(input, reverse); await runner.cancel("id"); await runner.inspect("id"); await runner.collectArtifacts("digest");
  expect(calls).toEqual([["build", input], ["start", input, reverse], ["cancel", "id"], ["inspect", "id"], ["collectArtifacts", "digest"]]);
  expect(resolutions).toBe(5);
});

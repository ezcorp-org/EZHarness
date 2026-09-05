import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLazyExtensionRunner, getConfiguredExtensionRunner } from "./runner-connection";
import { RunnerClient } from "@ezcorp/extension-runner";
import type { Runner } from "@ezcorp/extension-contract";

test("runner configuration is deferred until execution and rejects absent or unsafe settings", async () => {
  const previousSocket = process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
  const previousToken = process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
  const previousTokenFile = process.env.EZCORP_EXTENSION_RUNNER_TOKEN_FILE;
  try {
    delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN_FILE;
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
    if (previousTokenFile === undefined) delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN_FILE; else process.env.EZCORP_EXTENSION_RUNNER_TOKEN_FILE = previousTokenFile;
  }
});

test("runner reads bounded private secret files and rejects ambiguous or unsafe credentials", () => {
  const names = ["EZCORP_EXTENSION_RUNNER_SOCKET", "EZCORP_EXTENSION_RUNNER_TOKEN", "EZCORP_EXTENSION_RUNNER_TOKEN_FILE"];
  const previous = names.map((name) => process.env[name]);
  const directory = mkdtempSync(join(tmpdir(), "runner-secret-"));
  const path = join(directory, "token");
  const reject = () => expect(() => getConfiguredExtensionRunner()).toThrow("Configure an absolute extension runner socket");
  try {
    process.env.EZCORP_EXTENSION_RUNNER_SOCKET = "/tmp/runner-test.sock";
    delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
    process.env.EZCORP_EXTENSION_RUNNER_TOKEN_FILE = path;
    reject();
    writeFileSync(path, `${"a".repeat(32)}\n`, { mode: 0o600 });
    expect(getConfiguredExtensionRunner()).toBeInstanceOf(RunnerClient);
    process.env.EZCORP_EXTENSION_RUNNER_TOKEN = "b".repeat(32);
    reject();
    delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
    chmodSync(path, 0o622);
    reject();
    chmodSync(path, 0o600);
    for (const value of ["short", "a".repeat(4097), `${"a".repeat(32)}\u0000`, `${"a".repeat(32)} inside`]) {
      writeFileSync(path, value);
      reject();
    }
    writeFileSync(path, "a".repeat(4096));
    expect(getConfiguredExtensionRunner()).toBeInstanceOf(RunnerClient);
    symlinkSync(path, join(directory, "link"));
    for (const value of [directory, join(directory, "link"), "relative/token", ""]) {
      process.env.EZCORP_EXTENSION_RUNNER_TOKEN_FILE = value;
      reject();
    }
    delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN_FILE;
    process.env.EZCORP_EXTENSION_RUNNER_TOKEN = "a".repeat(4097);
    reject();
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compose config uses the application credential reader namespace", async () => {
  const compose = await Bun.file(new URL("../../deploy/extension-runner/compose.runner.yml", import.meta.url)).text();
  expect(compose).toContain("EZCORP_EXTENSION_RUNNER_SOCKET:");
  expect(compose).toContain("EZCORP_EXTENSION_RUNNER_TOKEN_FILE:");
  expect(compose).not.toContain("      EZ_EXTENSION_RUNNER_");
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

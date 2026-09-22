import { afterAll, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSandboxWorkspaceDispatcher } from "../runtime/workspace/target";

let configured = 0;
let commandResult = { code: 0, stdout: JSON.stringify({ host: { cgroupVersion: "v2", security: { rootless: true, seccompEnabled: true } } }), stderr: "", timedOut: false };
const originalCommands = await import("../runtime/sandbox/local-podman/commands");
mock.module("../runtime/sandbox/local-podman/commands", () => ({ ...originalCommands, runBoundedCommand: async () => commandResult }));
mock.module("../runtime/sandbox/controller", () => ({ configureSandboxController: () => { configured++; return { runNativeWorkspaceProcess: async () => ({ stdout: JSON.stringify({ content: [{ type: "text", text: "real route" }], details: {} }), exitCode: 0 }) }; } }));
mock.module("../runtime/sandbox/provider-invoker", () => ({ invokeSandboxProvider: async () => { throw new Error("Provider fixture must not run"); } }));
const { loadLocalSandboxConfig, verifyLocalSandboxHost, initializeLocalSandbox } = await import("../runtime/sandbox/startup");
const root = await mkdtemp(join(tmpdir(), "ez-sandbox-startup-"));
afterAll(async () => { await rm(root, { recursive: true, force: true }); mock.restore(); });
const executable = join(root, "tool");
await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
const config = { stateRoot: join(root, "state"), imageReference: `localhost/example@sha256:${"a".repeat(64)}`, imageId: "b".repeat(64), podmanPath: executable, fuse2fsPath: executable, supervisorPath: executable, nativeToolsArtifact: executable, workspaceUid: 0 as const, workspaceGid: 0 as const };
async function save(name: string, value: unknown = config, mode = 0o600) { const path = join(root, name); await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode }); return path; }

test("loads only private operator configuration and available immutable artifacts", async () => {
  expect(await loadLocalSandboxConfig(await save("valid"))).toEqual(config);
  await expect(loadLocalSandboxConfig("relative")).rejects.toThrow("absolute");
  await expect(loadLocalSandboxConfig(await save("public", config, 0o644))).rejects.toThrow("private");
  await expect(loadLocalSandboxConfig(await save("huge", " ".repeat(16385)))).rejects.toThrow("bounded");
  await expect(loadLocalSandboxConfig(await save("malformed", "{"))).rejects.toThrow();
  await expect(loadLocalSandboxConfig(await save("extra", { ...config, arbitraryCommand: "x" }))).rejects.toThrow();
  await expect(loadLocalSandboxConfig(await save("guest-user", { ...config, workspaceUid: 1000 }))).rejects.toThrow();
  await symlink(join(root, "valid"), join(root, "link"));
  await expect(loadLocalSandboxConfig(join(root, "link"))).rejects.toThrow();
  await mkdir(join(root, "directory"));
  await expect(loadLocalSandboxConfig(await save("dir-tool", { ...config, podmanPath: join(root, "directory") }))).rejects.toThrow("artifacts");
  await chmod(executable, 0o722);
  await expect(loadLocalSandboxConfig(join(root, "valid"))).rejects.toThrow("artifacts");
  await chmod(executable, 0o600);
  await expect(loadLocalSandboxConfig(join(root, "valid"))).rejects.toThrow();
  await chmod(executable, 0o700);
});

test("fails closed for unavailable, privileged, or unsupported runtime", async () => {
  await verifyLocalSandboxHost(config);
  const good = commandResult;
  for (const result of [{ ...good, code: 1 }, { ...good, timedOut: true }, { ...good, stdout: "{}" }, { ...good, stdout: JSON.stringify({ host: { cgroupVersion: "v2", security: { rootless: false, seccompEnabled: true } } }) }, { ...good, stdout: JSON.stringify({ host: { cgroupVersion: "v2", security: { rootless: true, seccompEnabled: false } } }) }]) {
    commandResult = result;
    await expect(verifyLocalSandboxHost(config)).rejects.toThrow();
  }
  commandResult = good;
});

test("startup installs the controller and native dispatcher only after verification", async () => {
  delete process.env.EZHARNESS_LOCAL_SANDBOX_CONFIG;
  expect(await initializeLocalSandbox()).toBe(false);
  expect(getSandboxWorkspaceDispatcher()).toBeNull();
  expect(configured).toBe(0);
  expect(await initializeLocalSandbox(join(root, "valid"))).toBe(true);
  expect(configured).toBe(1);
  const dispatcher = getSandboxWorkspaceDispatcher()!;
  const result = await dispatcher({ kind: "sandbox", projectId: "p", bindingId: "b", revision: 1 }, "readFile", { path: "hello" }, undefined, { userId: "u", conversationId: "c" });
  expect(result).toEqual({ content: [{ type: "text", text: "real route" }], details: {} });
  await expect(initializeLocalSandbox(join(root, "public"))).rejects.toThrow();
  expect(getSandboxWorkspaceDispatcher()).toBeNull();
});

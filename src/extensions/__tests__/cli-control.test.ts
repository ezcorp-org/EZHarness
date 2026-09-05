import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let user: unknown = { id: "admin", role: "admin", status: "active" };
let extension: unknown = { id: "extension" };
let activeReleaseId: string | null = "release";
const uninstall = mock(async () => {});
const createWorkspace = mock(async () => ({ installation: { id: "extension" }, workspace: { id: "workspace" } }));
const imported = mock(async (_actor: unknown, source: unknown) => ({ source }));
const build = mock(async (input: unknown) => ({ state: "succeeded", input }));
mock.module("../../db/queries/users", () => ({ getUserById: async () => user }));
mock.module("../../db/queries/extensions", () => ({ getExtensionByName: async () => extension }));
mock.module("../source-import", () => ({ importExtensionSource: imported }));
mock.module("../extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => ({ inspect: async () => ({ installation: { activeReleaseId } }), createWorkspace, uninstall }) }));
mock.module("@ezcorp/extension-runner", () => ({ buildLimits: { timeoutMs: 1 }, filesDigest: () => "digest", RunnerClient: class { build = build; } }));
const { parseExtensionSource, stageCliExtension, updateCliExtension, removeCliExtension, initCliExtension, verifyCliExtension } = await import("../cli-control");
const directories: string[] = [];
afterEach(async () => {
  delete process.env.EZCORP_USER_ID;
  delete process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
  delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
  user = { id: "admin", role: "admin", status: "active" }; extension = { id: "extension" }; activeReleaseId = "release";
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("source parsing rejects alternate transports and credentialed URLs", () => {
  expect(parseExtensionSource("bundled:scratchpad")).toEqual({ kind: "bundled", name: "scratchpad" });
  expect(parseExtensionSource("https://github.com/org/repo.git")).toEqual({ kind: "github", repository: "org/repo" });
  expect(parseExtensionSource("github:org/repo")).toEqual({ kind: "github", repository: "org/repo" });
  expect(parseExtensionSource("./source")).toMatchObject({ kind: "local" });
  for (const source of ["ssh://github.com/org/repo", "git@github.com:org/repo", "https://github.com.evil/org/repo", "https://user:token@github.com/org/repo", "https://github.com/org/repo?token=x"]) expect(() => parseExtensionSource(source)).toThrow();
});

test("CLI stage and fork require explicit active admin and never approve or activate", async () => {
  await expect(stageCliExtension("bundled:scratchpad")).rejects.toHaveProperty("code", "human_admin_required");
  process.env.EZCORP_USER_ID = "admin";
  expect(await stageCliExtension("bundled:scratchpad")).toMatchObject({ source: { kind: "bundled", name: "scratchpad" } });
  expect(imported).toHaveBeenCalledWith({ principalId: "admin", scope: "global", kind: "human" }, { kind: "bundled", name: "scratchpad" });
  expect(await updateCliExtension("scratchpad")).toHaveProperty("openUrl", "/extensions/author?installation=extension&workspace=workspace");
  expect(createWorkspace).toHaveBeenCalledWith(expect.anything(), { installationId: "extension", releaseId: "release" });
  await removeCliExtension("scratchpad");
  expect(uninstall).toHaveBeenCalledWith(expect.anything(), "extension");
  activeReleaseId = null;
  await expect(updateCliExtension("scratchpad")).rejects.toHaveProperty("code", "release_required");
  extension = undefined;
  await expect(updateCliExtension("missing")).rejects.toHaveProperty("code", "not_found");
  await expect(removeCliExtension("missing")).rejects.toHaveProperty("code", "not_found");
  user = { id: "admin", role: "member", status: "active" };
  await expect(stageCliExtension("bundled:scratchpad")).rejects.toHaveProperty("code", "human_admin_required");
});

test("scaffold is exclusive and standalone validation uses the isolated runner", async () => {
  const parent = await mkdtemp(join(tmpdir(), "extension-cli-")); directories.push(parent);
  const cwd = process.cwd();
  let directory: string;
  try { process.chdir(parent); directory = await initCliExtension("example"); await expect(initCliExtension("example")).rejects.toThrow(); } finally { process.chdir(cwd); }
  expect(await readFile(join(directory!, "extension.ts"), "utf8")).toContain('@ezcorp/sdk/v4');
  await expect(verifyCliExtension(directory!)).rejects.toHaveProperty("code", "runner_unconfigured");
  process.env.EZCORP_EXTENSION_RUNNER_SOCKET = "/tmp/runner.sock";
  process.env.EZCORP_EXTENSION_RUNNER_TOKEN = "x".repeat(64);
  expect(await verifyCliExtension(directory!)).toHaveProperty("state", "succeeded");
  expect(build).toHaveBeenCalledWith(expect.objectContaining({ sourceDigest: "digest", entrypoint: "extension.ts", files: expect.objectContaining({ "src/echo.test.ts": expect.any(String) }) }));
});

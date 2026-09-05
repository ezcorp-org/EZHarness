import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import type { RpcHandlerDeps } from "../tool-executor/rpc-handlers";
import type { JsonRpcRequest } from "../types";

const root = await mkdtemp(join(tmpdir(), "ez-project-git-"));
let active = true;
let owned = true;
let member = true;
let allowed = true;
let local = true;
mock.module("../../db/queries/users", () => ({ getUserById: async () => ({ id: "user", status: active ? "active" : "disabled" }) }));
mock.module("../../db/queries/conversations", () => ({ getConversation: async () => ({ id: "conversation", userId: owned ? "user" : "other", projectId: "project" }) }));
mock.module("../../db/queries/projects", () => ({ getProject: async () => ({ id: "project", path: local ? root : null }) }));
mock.module("../../auth/middleware", () => ({ checkProjectRole: async () => member ? undefined : new Response(null, { status: 403 }) }));
const { handleProjectGit, readProjectGit } = await import("../project-git-broker");
const authorize = mock(async () => ({ decision: allowed ? "allow" : "prompt" }));
const deps = { engine: { authorize } } as unknown as RpcHandlerDeps;
async function git(...args: string[]) {
  const child = Bun.spawn(["git", "-C", root, ...args], { env: { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "test@example.invalid" }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return output.trim();
}
await git("init");
await git("commit", "--allow-empty", "-m", "First commit");
const first = await git("rev-parse", "HEAD");
await git("commit", "--allow-empty", "-m", "Second commit");
const second = await git("rev-parse", "HEAD");
await git("remote", "add", "origin", "https://host-only-token@github.com/owner/repo.git");
beforeEach(() => { active = owned = member = allowed = local = true; authorize.mockClear(); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); restoreModuleMocks(); });

async function invoke(operation = "gitHead", input: Record<string, unknown> = {}, conversationId: string | null = "conversation", actor = "extension") {
  const token = registerCallProvenance({ actorExtensionId: "extension", onBehalfOf: "user", conversationId, runId: null, parentCallId: null, kind: "tool", ownerless: false });
  try {
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: "request", method: `ezcorp/project.${operation}`, params: { ...input, _meta: { ezCallId: token } } };
    return await handleProjectGit(deps, actor, request);
  } finally { releaseCallProvenance(token); }
}

test("real project Git reads return fixed metadata without origin credentials", async () => {
  expect((await invoke()).result).toEqual({ hash: second, subject: "Second commit" });
  expect((await invoke("commitSubjects")).result).toEqual(["Second commit"]);
  expect((await invoke("commitSubjects", { sinceHash: first })).result).toEqual(["Second commit"]);
  expect((await invoke("origin")).result).toBe("https://github.com/owner/repo");
  expect(authorize).toHaveBeenCalledWith({ extensionId: "extension", userId: "user", conversationId: "conversation", toolName: "project.origin" }, [{ kind: "shell" }]);
});

test("project reads reject command input, foreign provenance and unbound schedules", async () => {
  for (const input of [{ path: "/etc" }, { projectId: "foreign" }, { sinceHash: "--all" }, { sinceHash: 1 }]) expect((await invoke("commitSubjects", input)).error).toBeDefined();
  expect((await invoke("unknown")).error).toBeDefined();
  expect((await invoke("gitHead", {}, null)).error?.message).toContain("Bind this operation");
  expect((await invoke("gitHead", {}, "conversation", "foreign")).error?.code).toBe(-32602);
  expect(authorize).not.toHaveBeenCalled();
});

test("project reads recheck ownership membership policy and local project", async () => {
  active = false; expect((await invoke()).error?.message).toContain("own");
  active = true; owned = false; expect((await invoke()).error?.message).toContain("own");
  owned = true; member = false; expect((await invoke()).error?.message).toContain("membership");
  member = true; local = false; expect((await invoke()).error?.message).toContain("local");
  local = true; allowed = false; expect((await invoke()).error?.message).toContain("Approve");
});

test("Git failures and malformed metadata do not expose host errors", async () => {
  for (const operation of ["gitHead", "origin", "commitSubjects"] as const) expect(await readProjectGit(root, operation, undefined, async args => ({ exitCode: args.includes("--name-only") ? 0 : 1, stdout: "", stderr: "host-secret" }))).toEqual(operation === "commitSubjects" ? [] : null);
  expect(await readProjectGit(root, "gitHead", undefined, async () => ({ exitCode: 0, stdout: "invalid", stderr: "" }))).toBeNull();
  expect(await readProjectGit(root, "origin", undefined, async () => ({ exitCode: 0, stdout: "https://github.com.evil/owner/repo", stderr: "" }))).toBeNull();
  await expect(readProjectGit(root, "commitSubjects", "HEAD^{}")).rejects.toThrow("full commit hash");
  await git("config", "include.path", "/host-secret");
  expect((await invoke()).error?.message).toBe("Project read failed.");
  await git("config", "--unset", "include.path");
});

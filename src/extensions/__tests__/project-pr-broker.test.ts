import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import type { RpcHandlerDeps } from "../tool-executor/rpc-handlers";
import type { JsonRpcRequest } from "../types";

let active = true;
let owned = true;
let member = true;
let local = true;
let credential = true;
let allowed = true;
let failure = false;
mock.module("../../db/queries/users", () => ({ getUserById: async () => ({ id: "user", status: active ? "active" : "disabled" }) }));
mock.module("../../db/queries/conversations", () => ({ getConversation: async () => ({ id: "conversation", userId: owned ? "user" : "other", projectId: "project" }) }));
mock.module("../../db/queries/projects", () => ({ getProject: async () => ({ id: "project", path: local ? "/project" : null }) }));
mock.module("../../auth/middleware", () => ({ checkProjectRole: async () => member ? undefined : new Response(null, { status: 403 }) }));
const secret = mock(async () => credential ? "host-only-token" : null);
mock.module("../secrets-store", () => ({ getSecret: secret }));
const open = mock(async () => { if (failure) throw new Error("host-only-token"); return { url: "https://github.com/owner/repo/pull/1" }; });
mock.module("../project-open-pr", () => ({ openProjectPullRequest: open }));
const { handleProjectPullRequest } = await import("../project-pr-broker");
const authorize = mock(async () => ({ decision: allowed ? "allow" : "prompt" }));
const deps = { engine: { authorize } } as unknown as RpcHandlerDeps;

beforeEach(() => {
  active = owned = member = local = credential = allowed = true;
  failure = false;
  open.mockClear(); secret.mockClear(); authorize.mockClear();
});
afterAll(() => restoreModuleMocks());

async function invoke(input: unknown = { runId: "run", title: "Title", body: "Body" }, conversationId: string | null = "conversation", actor = "extension") {
  const token = registerCallProvenance({ actorExtensionId: "extension", onBehalfOf: "user", conversationId, runId: null, parentCallId: null, kind: "tool", ownerless: false });
  try {
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: "request", method: "ezcorp/project.openPr", params: { ...(input as Record<string, unknown>), _meta: { ezCallId: token } } };
    return await handleProjectPullRequest(deps, actor, request);
  } finally { releaseCallProvenance(token); }
}

test("project PR uses the owned project and keeps its credential inside the host", async () => {
  const result = await invoke();
  expect(result.result).toEqual({ url: "https://github.com/owner/repo/pull/1" });
  expect(JSON.stringify(result)).not.toContain("host-only-token");
  expect(secret).toHaveBeenCalledWith("github-projects", "project", "apiToken");
  expect(open).toHaveBeenCalledWith({ projectRoot: "/project", runId: "run", title: "Title", body: "Body" }, { githubToken: "host-only-token" });
  expect(authorize).toHaveBeenCalledWith({ extensionId: "extension", userId: "user", conversationId: "conversation", toolName: "project.openPr" }, [{ kind: "shell" }, { kind: "network", value: "github.com" }, { kind: "network", value: "api.github.com" }]);
});

test("project PR rejects foreign tokens, invalid inputs and background requests", async () => {
  expect((await invoke(undefined, "conversation", "foreign")).error?.code).toBe(-32602);
  for (const input of [{}, { runId: 1, title: "Title", body: "Body" }, { runId: "run", title: false, body: "Body" }, { runId: "run", title: "Title", body: [] }]) expect((await invoke(input)).error?.message).toContain("runId, title, and body");
  expect((await invoke(undefined, null)).error?.message).toContain("project conversation");
  expect(open).not.toHaveBeenCalled();
  expect(secret).not.toHaveBeenCalled();
});

test("project PR rechecks active ownership, membership and caller policy before reading secrets", async () => {
  active = false;
  expect((await invoke()).error?.message).toContain("own the project conversation");
  active = true; owned = false;
  expect((await invoke()).error?.message).toContain("own the project conversation");
  owned = true; member = false;
  expect((await invoke()).error?.message).toContain("membership");
  member = true; local = false;
  expect((await invoke()).error?.message).toContain("local project");
  local = true; allowed = false;
  expect((await invoke()).error?.message).toContain("Approve shell");
  expect(secret).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

test("project PR rejects missing credentials and hides failures", async () => {
  credential = false;
  expect((await invoke()).error?.message).toContain("Configure a GitHub token");
  expect(open).not.toHaveBeenCalled();
  credential = true; failure = true;
  expect((await invoke()).error).toEqual({ code: -32603, message: "Project pull request failed." });
});

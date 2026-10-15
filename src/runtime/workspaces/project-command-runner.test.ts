import { expect, test } from "bun:test";
import { createSandboxProjectCommandRunner } from "./project-command-runner";
import { sandboxWorkspaceTarget, type SandboxWorkspaceBackend } from "./target";

const binding = {
  projectId: "project", workspaceId: "sandbox", connectionId: "connection", providerId: "incus",
  generation: 1, presetId: "preset", releaseDigest: "a".repeat(64),
  presetDigest: "b".repeat(64), effectiveSettingsDigest: "c".repeat(64),
};

test("project commands use the pinned sandbox and quote each argument", async () => {
  const calls: Parameters<SandboxWorkspaceBackend["execute"]>[0][] = [];
  const target = sandboxWorkspaceTarget(binding, { async execute(request) {
    calls.push(request);
    return { content: [], details: { exitCode: 7, stdout: "guest output", stderr: "guest warning" } };
  } });
  const run = createSandboxProjectCommandRunner(target, { userId: "authenticated-member" });
  expect(await run(["git", "show", "a'b", "$(touch /host)"], "/host/project"))
    .toEqual({ exitCode: 7, stdout: "guest output", stderr: "guest warning" });
  expect(await run(["git", "status"], "/elsewhere"))
    .toEqual({ exitCode: 7, stdout: "guest output", stderr: "guest warning" });
  expect(calls[0]?.toolCallId).toMatch(/^project-command-[0-9a-f-]{36}-1$/);
  expect(calls[1]?.toolCallId).toBe(calls[0]?.toolCallId.replace(/-1$/, "-2"));
  expect(calls[0]).toMatchObject({ binding, principal: { userId: "authenticated-member" }, toolName: "shell", params: {
    command: "'git' 'show' 'a'\\''b' '$(touch /host)'", timeout: 10_000,
  } });
});

test("project command runner refuses stdin, local fallback, and transport failures", async () => {
  let calls = 0;
  const target = sandboxWorkspaceTarget(binding, { async execute() {
    calls++;
    return { content: [], details: { isError: true } };
  } });
  const run = createSandboxProjectCommandRunner(target);
  await expect(run(["git"], "/host", "input")).rejects.toMatchObject({ name: "sandbox_workspace_operation_unsupported" });
  expect(calls).toBe(0);
  await expect(run(["git"], "/host")).rejects.toMatchObject({ name: "sandbox_workspace_operation_failed" });
  expect(calls).toBe(1);
});

test("project command runner accepts a reported nonzero exit with explicit complete output", async () => {
  const target = sandboxWorkspaceTarget(binding, { async execute() {
    return { content: [], details: { isError: true, exitCode: 127, stdout: "", stderr: "" } };
  } });
  expect(await createSandboxProjectCommandRunner(target)(["git"], "/host"))
    .toEqual({ exitCode: 127, stdout: "", stderr: "" });
});


test("project command runner denies a missing sandbox backend", async () => {
  const target = sandboxWorkspaceTarget(binding, null as unknown as SandboxWorkspaceBackend);
  await expect(createSandboxProjectCommandRunner(target)(["git"], "/host"))
    .rejects.toMatchObject({ name: "sandbox_workspace_unavailable" });
});


test("project source commands fail closed on explicit output truncation or gaps", async () => {
  for (const details of [{ exitCode: 0, stdout: "partial\0", truncated: true }, { exitCode: 0, stdout: "partial\0", gap: true }]) {
    const target = sandboxWorkspaceTarget(binding, { async execute() { return { content: [], details }; } });
    await expect(createSandboxProjectCommandRunner(target, { userId: "owner" })(["git", "ls-files", "-z"], "."))
      .rejects.toThrow("output is incomplete");
  }
});


test("independent command runners never reuse the same guest mutation identity", async () => {
  const ids: string[] = [];
  const target = sandboxWorkspaceTarget(binding, { async execute(request) {
    ids.push(request.toolCallId);
    return { content: [], details: { exitCode: 0, stdout: "", stderr: "" } };
  } });
  await createSandboxProjectCommandRunner(target, { userId: "owner" })(["git", "init"], ".");
  await createSandboxProjectCommandRunner(target, { userId: "owner" })(["git", "ls-files", "-z"], ".");
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});


test("unknown project command results cannot become empty successful source snapshots", async () => {
  for (const details of [{}, { stdout: "", stderr: "" }, { exitCode: 0 },
    { exitCode: false, stdout: "", stderr: "" }, { exitCode: 0, stdout: null, stderr: "" }, { exitCode: 0, stdout: "", stderr: null }]) {
    const target = sandboxWorkspaceTarget(binding, { async execute() { return { content: [], details }; } });
    await expect(createSandboxProjectCommandRunner(target, { userId: "owner" })(["git", "ls-files", "-z"], "."))
      .rejects.toThrow("incomplete result");
  }
});

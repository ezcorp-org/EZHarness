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
  const run = createSandboxProjectCommandRunner(target);
  expect(await run(["git", "show", "a'b", "$(touch /host)"], "/host/project"))
    .toEqual({ exitCode: 7, stdout: "guest output", stderr: "guest warning" });
  expect(await run(["git", "status"], "/elsewhere"))
    .toEqual({ exitCode: 7, stdout: "guest output", stderr: "guest warning" });
  expect(calls.map(call => call.toolCallId)).toEqual(["project-command-1", "project-command-2"]);
  expect(calls[0]).toMatchObject({ binding, toolName: "shell", params: {
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

test("project command runner accepts a reported nonzero exit and defaults absent output", async () => {
  const target = sandboxWorkspaceTarget(binding, { async execute() {
    return { content: [], details: { isError: true, exitCode: 127 } };
  } });
  expect(await createSandboxProjectCommandRunner(target)(["git"], "/host"))
    .toEqual({ exitCode: 127, stdout: "", stderr: "" });
});


test("project command runner denies a missing sandbox backend", async () => {
  const target = sandboxWorkspaceTarget(binding, null as unknown as SandboxWorkspaceBackend);
  await expect(createSandboxProjectCommandRunner(target)(["git"], "/host"))
    .rejects.toMatchObject({ name: "sandbox_workspace_unavailable" });
});

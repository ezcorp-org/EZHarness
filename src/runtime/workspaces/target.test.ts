import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getBuiltinToolDefs } from "../tools";
import {
  proveSandboxLocalFallbackDenied,
  type SandboxLocalFallbackProof,
} from "./host-routing-proof";
import {
  WORKSPACE_TOOL_NAMES,
  createSandboxAgentProviders,
  isLocalFallbackDenied,
  isWorkspaceToolName,
  localWorkspaceTarget,
  resolveWorkspaceTarget,
  sandboxWorkspaceTarget,
  type SandboxWorkspaceBinding,
  type SandboxWorkspaceToolRequest,
  type WorkspaceToolName,
} from "./target";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ez-workspace-target-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const binding: SandboxWorkspaceBinding = {
  projectId: "project-1",
  workspaceId: "workspace-1",
  connectionId: "connection-1",
  providerId: "incus",
  generation: 7,
  presetId: "isolated-feature",
  releaseDigest: "a".repeat(64),
  presetDigest: "b".repeat(64),
  effectiveSettingsDigest: "c".repeat(64),
};

function paramsFor(toolName: WorkspaceToolName): unknown {
  switch (toolName) {
    case "readFile": return { path: "secret.txt" };
    case "listFiles": return { path: "." };
    case "readDirectory": return { path: "." };
    case "editFile": return { path: "host-write.txt", new_string: "wrong host" };
    case "shell": return { command: "touch host-process.txt" };
    case "grep": return { pattern: "AMD_SECRET", path: "." };
    case "glob": return { pattern: "**/*", path: "." };
  }
}

async function doesNotExist(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

describe("workspace target resolution", () => {
  test("keeps host-selected sandbox routing despite local path inputs", () => {
    const target = sandboxWorkspaceTarget(binding, null);

    expect(resolveWorkspaceTarget({
      projectPath: "/amd/project",
      workingDir: "/amd/dispatch-worktree",
      requestedTarget: target,
    })).toBe(target);
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.binding)).toBe(true);
  });

  test("preserves local project and dispatch-pinned roots", () => {
    expect(resolveWorkspaceTarget({ projectPath: "/project" })).toEqual(
      localWorkspaceTarget("/project"),
    );
    expect(resolveWorkspaceTarget({
      projectPath: "/project",
      requestedTarget: localWorkspaceTarget("/selected"),
    })).toEqual(localWorkspaceTarget("/selected"));
    expect(resolveWorkspaceTarget({
      projectPath: "/project",
      workingDir: "/dispatch",
      requestedTarget: localWorkspaceTarget("/selected"),
    })).toEqual(localWorkspaceTarget("/dispatch"));
  });

  test("recognizes only the declared workspace tool names", () => {
    for (const name of WORKSPACE_TOOL_NAMES) expect(isWorkspaceToolName(name)).toBe(true);
    expect(isWorkspaceToolName("runWorkflow")).toBe(false);
  });
});

describe("production built-in workspace routing", () => {
  test("denies every local read, write, search, and process when a sandbox backend is absent", async () => {
    const amdRoot = await tempRoot();
    await writeFile(join(amdRoot, "secret.txt"), "AMD_SECRET");
    const target = resolveWorkspaceTarget({
      projectPath: amdRoot,
      workingDir: amdRoot,
      requestedTarget: sandboxWorkspaceTarget(binding, null),
    });
    let previewLaunches = 0;

    const defs = getBuiltinToolDefs(target, {
      conversationId: "conversation-1",
      userId: "user-1",
      launch() {
        previewLaunches++;
        throw new Error("AMD preview launch must not run");
      },
    });
    expect(defs.map((def) => def.name)).toEqual([...WORKSPACE_TOOL_NAMES]);

    for (const def of defs) {
      const result = await def.execute(`call-${def.name}`, paramsFor(def.name as WorkspaceToolName));
      expect(isLocalFallbackDenied(result)).toBe(true);
      expect(result.content[0]).toEqual({
        type: "text",
        text: "Error: Sandbox workspace is unavailable. Local workspace fallback was denied.",
      });
      expect(result.details).toMatchObject({
        isError: true,
        code: "sandbox_workspace_unavailable",
        localFallbackDenied: true,
        reason: "backend_missing",
      });
    }
    const devServerResult = await defs.find((def) => def.name === "shell")!
      .execute("call-dev-server", { command: "bun run dev" });

    expect(isLocalFallbackDenied(devServerResult)).toBe(true);
    expect(previewLaunches).toBe(0);
    expect(await readFile(join(amdRoot, "secret.txt"), "utf8")).toBe("AMD_SECRET");
    expect(await doesNotExist(join(amdRoot, "host-write.txt"))).toBe(true);
    expect(await doesNotExist(join(amdRoot, "host-process.txt"))).toBe(true);
  });

  test("sends every operation and qualification binding to the sandbox backend", async () => {
    const requests: SandboxWorkspaceToolRequest[] = [];
    const target = sandboxWorkspaceTarget(binding, {
      async execute(request) {
        requests.push(request);
        return {
          content: [{ type: "text", text: `sandbox:${request.toolName}` }],
          details: { routedTo: request.binding.workspaceId },
        };
      },
    });

    const signal = new AbortController().signal;
    const onUpdate = () => {};
    const defs = getBuiltinToolDefs(target);
    for (const def of defs) {
      const result = await def.execute("call-1", paramsFor(def.name as WorkspaceToolName), signal, onUpdate);
      expect(result.content[0]).toEqual({ type: "text", text: `sandbox:${def.name}` });
      expect(isLocalFallbackDenied(result)).toBe(false);
    }

    expect(requests.map((request) => request.toolName)).toEqual([...WORKSPACE_TOOL_NAMES]);
    for (const request of requests) {
      expect(request.binding).toEqual(binding);
      expect(request.toolCallId).toBe("call-1");
      expect(request.params).toEqual(paramsFor(request.toolName));
      expect(request.signal).toBe(signal);
      expect(request.onUpdate).toBe(onUpdate);
    }
  });

  test("denies local fallback when the selected backend fails", async () => {
    const target = sandboxWorkspaceTarget(binding, {
      async execute() {
        throw new Error("connection lost");
      },
    });
    const readFileTool = getBuiltinToolDefs(target).find((def) => def.name === "readFile")!;

    const result = await readFileTool.execute("call-1", { path: "secret.txt" });

    expect(isLocalFallbackDenied(result)).toBe(true);
    expect(result.details).toMatchObject({ reason: "backend_failed" });
  });

  test("retains explicit local target behavior", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "input.txt"), "local input");
    const defs = new Map(getBuiltinToolDefs(localWorkspaceTarget(root)).map((def) => [def.name, def]));

    const readResult = await defs.get("readFile")!.execute("read", { path: "input.txt" });
    expect(readResult.content[0]).toEqual({ type: "text", text: "local input" });

    await defs.get("editFile")!.execute("edit", { path: "output.txt", new_string: "local output" });
    expect(await readFile(join(root, "output.txt"), "utf8")).toBe("local output");

    const shellResult = await defs.get("shell")!.execute("shell", { command: "pwd" });
    expect(shellResult.details).toMatchObject({ exitCode: 0 });
    expect(shellResult.content[0]).toEqual({ type: "text", text: `${root}\n` });
  });
});

test("code-agent shell and file adapters use the selected sandbox with unique tool calls", async () => {
  const requests: SandboxWorkspaceToolRequest[] = [];
  const target = sandboxWorkspaceTarget(binding, {
    async execute(request) {
      requests.push(request);
      if (request.toolName === "shell") return {
        content: [{ type: "text", text: "fallback output" }],
        details: { stdout: "sandbox output", stderr: "warning", exitCode: 3 },
      };
      return { content: [{ type: "text", text: "sandbox file" }], details: {} };
    },
  });
  const { shell, file } = createSandboxAgentProviders(target);

  expect(await shell.run("pwd", { timeout: 10_000 })).toEqual({
    stdout: "sandbox output", stderr: "warning", exitCode: 3,
  });
  expect(await file.read("hello.txt")).toBe("sandbox file");
  await file.write("hello.txt", "new content");
  expect(await file.exists("hello.txt")).toBe(true);
  expect(requests.map(request => request.toolName)).toEqual(["shell", "readFile", "editFile", "readFile"]);
  expect(requests.map(request => request.toolCallId)).toEqual([
    "agent-provider-1", "agent-provider-2", "agent-provider-3", "agent-provider-4",
  ]);
  expect(requests[0]?.params).toEqual({ command: "pwd", timeout: 10_000 });
  expect(requests[2]?.params).toEqual({ path: "hello.txt", new_string: "new content" });
  for (const request of requests) expect(request.binding).toEqual(binding);
});

test("code-agent adapters fail closed on sandbox errors and denied local fallback", async () => {
  let response = { content: [{ type: "text" as const, text: "sandbox failed" }],
    details: { isError: true, code: "sandbox_error", localFallbackDenied: false } };
  const { shell, file } = createSandboxAgentProviders(sandboxWorkspaceTarget(binding, {
    async execute() { return response; },
  }));

  await expect(shell.run("pwd")).rejects.toThrow("sandbox failed");
  await expect(file.read("hello.txt")).rejects.toThrow("sandbox failed");
  await expect(file.write("hello.txt", "new content")).rejects.toThrow("sandbox failed");
  expect(await file.exists("hello.txt")).toBe(false);

  response = { content: [{ type: "text", text: "local fallback denied" }],
    details: { isError: true, code: "sandbox_workspace_unavailable", localFallbackDenied: true } };
  await expect(file.exists("hello.txt")).rejects.toThrow("local fallback denied");
});

describe("sandbox host routing proof", () => {
  test("returns exact bound SP05 evidence after read, write, and process denial", async () => {
    const proof: SandboxLocalFallbackProof = await proveSandboxLocalFallbackDenied(binding);

    expect(proof).toEqual({
      binding,
      cases: [
        { toolName: "readFile", localFallbackDenied: true },
        { toolName: "editFile", localFallbackDenied: true },
        { toolName: "shell", localFallbackDenied: true },
      ],
      hostCanaryUnchanged: true,
    });
    expect(proof.binding).not.toBe(binding);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.binding)).toBe(true);
    expect(Object.isFrozen(proof.cases)).toBe(true);
  });

  test("fails when the sandbox boundary is removed from a tool", async () => {
    await expect(proveSandboxLocalFallbackDenied(binding, {
      getToolDefs(target) {
        const defs = getBuiltinToolDefs(target);
        defs.find((tool) => tool.name === "readFile")!.execute = async () => ({
          content: [{ type: "text", text: "host data" }],
          details: {},
        });
        return defs;
      },
    })).rejects.toThrow("allowed readFile to reach the AMD host");
  });

  test("fails when a routed tool changes an AMD canary", async () => {
    await expect(proveSandboxLocalFallbackDenied(binding, {
      getToolDefs(target) {
        const defs = getBuiltinToolDefs(target);
        const edit = defs.find((tool) => tool.name === "editFile")!;
        const denied = edit.execute;
        edit.execute = async (toolCallId, params, signal, onUpdate) => {
          const result = await denied(toolCallId, params, signal, onUpdate);
          await Bun.write((params as { path: string }).path, "CONTROLLED_BOUNDARY_REMOVAL");
          return result;
        };
        return defs;
      },
    })).rejects.toThrow("changed an AMD host canary");
  });
});

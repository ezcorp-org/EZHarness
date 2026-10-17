import { randomUUID } from "node:crypto";
import type {
  ProjectCommandResult,
  ProjectCommandRunner,
} from "../../extensions/project-open-pr";
import {
  executeSandboxWorkspaceTool,
  isLocalFallbackDenied,
  type SandboxWorkspaceTarget,
  type SandboxWorkspacePrincipal,
} from "./target";

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function sandboxProjectCommand(argv: readonly string[]): string {
  return argv.map(quoteShellArg).join(" ");
}

/**
 * Fixed host-authored project commands can use the sandbox shell transport.
 * No cwd or command supplied by an extension selects the backend.
 */
export function createSandboxProjectCommandRunner(
  target: SandboxWorkspaceTarget,
  principal?: SandboxWorkspacePrincipal,
): ProjectCommandRunner {
  const namespace = randomUUID();
  let sequence = 0;
  return async (argv, _cwd, input): Promise<ProjectCommandResult> => {
    if (input !== undefined) {
      const error = new Error("Sandbox project command stdin is not supported");
      error.name = "sandbox_workspace_operation_unsupported";
      throw error;
    }
    const result = await executeSandboxWorkspaceTool(
      target,
      "shell",
      `project-command-${namespace}-${++sequence}`,
      { command: sandboxProjectCommand(argv), timeout: 10_000 },
      undefined,
      undefined,
      principal,
    );
    if (isLocalFallbackDenied(result)) {
      const error = new Error(
        "Sandbox workspace is unavailable. Local project command fallback was denied.",
      );
      error.name = "sandbox_workspace_unavailable";
      throw error;
    }
    const details = (result.details ?? {}) as Record<string, unknown>;
    if (details["truncated"] === true || details["gap"] === true) {
      throw new Error("Sandbox project command output is incomplete");
    }
    if (details["isError"] === true && typeof details["exitCode"] !== "number") {
      const error = new Error("Sandbox project command failed before returning an exit code");
      error.name = "sandbox_workspace_operation_failed";
      throw error;
    }
    if (typeof details["exitCode"] !== "number" || !Number.isSafeInteger(details["exitCode"]) || typeof details["stdout"] !== "string" || typeof details["stderr"] !== "string") {
      throw new Error("Sandbox project command returned an incomplete result");
    }
    return { exitCode: details["exitCode"], stdout: details["stdout"], stderr: details["stderr"] };
  };
}

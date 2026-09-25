import type {
  ProjectCommandResult,
  ProjectCommandRunner,
} from "../../extensions/project-open-pr";
import {
  executeSandboxWorkspaceTool,
  isLocalFallbackDenied,
  type SandboxWorkspaceTarget,
} from "./target";

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Fixed host-authored project commands can use the sandbox shell transport.
 * No cwd or command supplied by an extension selects the backend.
 */
export function createSandboxProjectCommandRunner(
  target: SandboxWorkspaceTarget,
): ProjectCommandRunner {
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
      `project-command-${++sequence}`,
      { command: argv.map(quoteShellArg).join(" "), timeout: 10_000 },
    );
    if (isLocalFallbackDenied(result)) {
      const error = new Error(
        "Sandbox workspace is unavailable. Local project command fallback was denied.",
      );
      error.name = "sandbox_workspace_unavailable";
      throw error;
    }
    const details = (result.details ?? {}) as Record<string, unknown>;
    if (details["isError"] === true && typeof details["exitCode"] !== "number") {
      const error = new Error("Sandbox project command failed before returning an exit code");
      error.name = "sandbox_workspace_operation_failed";
      throw error;
    }
    return {
      exitCode: typeof details["exitCode"] === "number" ? details["exitCode"] : 0,
      stdout: typeof details["stdout"] === "string" ? details["stdout"] : "",
      stderr: typeof details["stderr"] === "string" ? details["stderr"] : "",
    };
  };
}

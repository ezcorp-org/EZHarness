import { NATIVE_TOOL_ARTIFACT, decodeNativeToolResult, encodeNativeToolRequest } from "../sandbox/native-tool-protocol";
import { toolError } from "../tools/types";
import { validateTimeout } from "../tools/validate";
import type { SandboxWorkspaceDispatcher, WorkspaceTarget } from "./target";

export interface NativeWorkspaceProcessRequest {
  argv: string[];
  timeoutMs: number;
}

/** The controller authorizes the saved binding, owns the writer lease, and
 * rechecks the approved provider before each process effect. It waits until
 * the container is stopped before releasing the writer or returning. */
export type RunNativeWorkspaceProcess = (
  target: Extract<WorkspaceTarget, { kind: "sandbox" }>,
  request: NativeWorkspaceProcessRequest,
  signal?: AbortSignal,
) => Promise<{ stdout: string; exitCode: number }>;

export function createSandboxWorkspaceDispatcher(run: RunNativeWorkspaceProcess): SandboxWorkspaceDispatcher {
  return async (target, operation, params, signal) => {
    if (signal?.aborted) return toolError("Workspace tool cancelled");
    try {
      const timeout = operation === "shell" && params && typeof params === "object" && "timeout" in params && typeof params.timeout === "number" && Number.isFinite(params.timeout) ? params.timeout : undefined;
      const encoded = encodeNativeToolRequest(operation, params);
      const result = await run(target, {
        argv: ["/usr/local/bin/bun", NATIVE_TOOL_ARTIFACT, ...encoded.match(/.{1,4096}/g)!],
        timeoutMs: validateTimeout(timeout),
      }, signal);
      if (result.exitCode !== 0) return toolError("Workspace tool did not complete");
      return decodeNativeToolResult(result.stdout);
    } catch {
      return toolError("Sandbox workspace is unavailable");
    }
  };
}

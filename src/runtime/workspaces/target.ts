import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { FileProvider, ShellProvider, ShellResult } from "../../types";

import { toolError } from "../tools/types";

/** The built-in tools whose effects belong to a project workspace. */
export const WORKSPACE_TOOL_NAMES = [
  "readFile",
  "listFiles",
  "readDirectory",
  "editFile",
  "shell",
  "grep",
  "glob",
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

/**
 * Host-owned identity for one qualified sandbox workspace.
 *
 * The binding travels with every backend request. A path, model, provider
 * selection, or tool argument cannot select or weaken the execution target.
 */
export interface SandboxWorkspaceBinding {
  projectId: string;
  workspaceId: string;
  connectionId: string;
  providerId: string;
  generation: number;
  presetId: string;
  releaseDigest: string;
  presetDigest: string;
  effectiveSettingsDigest: string;
}

export interface SandboxAttachmentWriteRequest {
  binding: Readonly<SandboxWorkspaceBinding>;
  conversationId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface SandboxAttachmentReadRequest {
  binding: Readonly<SandboxWorkspaceBinding>;
  storageKey: string;
}

export interface SandboxAttachmentDeleteRequest {
  binding: Readonly<SandboxWorkspaceBinding>;
  conversationId: string;
  messageId?: string;
}

/** Provider capability for attachment bytes that belong to a sandbox workspace.
 * `storageKey` is opaque to the host and must be scoped to the supplied binding. */
export interface SandboxAttachmentBackend {
  write(request: SandboxAttachmentWriteRequest): Promise<{ storageKey: string; sizeBytes: number }>;
  read(request: SandboxAttachmentReadRequest): Promise<Uint8Array>;
  delete(request: SandboxAttachmentDeleteRequest): Promise<void>;
}

export interface SandboxPreviewServeRequest {
  binding: Readonly<SandboxWorkspaceBinding>;
  previewId: string;
  userId: string;
  targetPort: number | null;
  requestPath: string;
  request: Request;
  expiresAt: Date;
}

export interface SandboxPreviewOpenRequest {
  binding: Readonly<SandboxWorkspaceBinding>;
  previewId: string;
  userId: string;
  conversationId: string;
  targetPort: number | null;
  expiresAt: Date;
}

export interface SandboxPreviewCloseRequest {
  binding: Readonly<SandboxWorkspaceBinding>;
  previewId: string;
  userId: string;
  targetPort: number | null;
}

/** Provider capability for an authenticated preview relay. The provider must
 * keep the registered port and binding pinned for the complete request. */
export interface SandboxPreviewBackend {
  open(request: SandboxPreviewOpenRequest): Promise<void>;
  serve(request: SandboxPreviewServeRequest): Promise<Response>;
  close(request: SandboxPreviewCloseRequest): Promise<void>;
}

export interface SandboxWorkspaceToolRequest {
  binding: Readonly<SandboxWorkspaceBinding>;
  toolName: WorkspaceToolName;
  toolCallId: string;
  params: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}

/** Transport-independent workspace interface. The live Incus transport can
 * implement this interface without making the runtime tools depend on it. */
export interface SandboxWorkspaceBackend {
  execute(request: SandboxWorkspaceToolRequest): Promise<AgentToolResult<unknown>>;
  readonly attachments?: SandboxAttachmentBackend;
  readonly previews?: SandboxPreviewBackend;
}

export interface LocalWorkspaceTarget {
  readonly kind: "local";
  readonly root: string;
}

export interface SandboxWorkspaceTarget {
  readonly kind: "sandbox";
  readonly binding: Readonly<SandboxWorkspaceBinding>;
  /** Null means that the selected sandbox cannot currently be reached. */
  readonly backend: SandboxWorkspaceBackend | null;
}

export type WorkspaceTarget = LocalWorkspaceTarget | SandboxWorkspaceTarget;

/** Serializable part of a host-selected target. Backend handles and local
 * host paths never cross a durable or process boundary. */
export type WorkspaceTargetReference =
  | { readonly kind: "local" }
  | { readonly kind: "sandbox"; readonly binding: Readonly<SandboxWorkspaceBinding> };

export interface ResolveWorkspaceTargetInput {
  projectPath: string;
  workingDir?: string;
  requestedTarget?: WorkspaceTarget;
}

export function localWorkspaceTarget(root: string): LocalWorkspaceTarget {
  return Object.freeze({ kind: "local", root });
}

export function sandboxWorkspaceTarget(
  binding: SandboxWorkspaceBinding,
  backend: SandboxWorkspaceBackend | null,
): SandboxWorkspaceTarget {
  return Object.freeze({
    kind: "sandbox",
    binding: Object.freeze({ ...binding }),
    backend,
  });
}

export function workspaceTargetReference(target: WorkspaceTarget): WorkspaceTargetReference {
  return target.kind === "local"
    ? Object.freeze({ kind: "local" })
    : Object.freeze({ kind: "sandbox", binding: Object.freeze({ ...target.binding }) });
}

export function sameSandboxWorkspaceBinding(
  left: Readonly<SandboxWorkspaceBinding>,
  right: Readonly<SandboxWorkspaceBinding>,
): boolean {
  return left.projectId === right.projectId
    && left.workspaceId === right.workspaceId
    && left.connectionId === right.connectionId
    && left.providerId === right.providerId
    && left.generation === right.generation
    && left.presetId === right.presetId
    && left.releaseDigest === right.releaseDigest
    && left.presetDigest === right.presetDigest
    && left.effectiveSettingsDigest === right.effectiveSettingsDigest;
}

export function sandboxCapabilityUnavailable(operation: string): Error {
  const error = new Error(
    `Sandbox workspace route for ${operation} is unavailable. Local workspace fallback was denied.`,
  );
  error.name = "sandbox_workspace_operation_unsupported";
  return error;
}

/**
 * Resolve the host-selected target. A dispatch-pinned working directory still
 * overrides a local root. It can never replace a sandbox target.
 */
export function resolveWorkspaceTarget({
  projectPath,
  workingDir,
  requestedTarget,
}: ResolveWorkspaceTargetInput): WorkspaceTarget {
  if (requestedTarget?.kind === "sandbox") return requestedTarget;
  return localWorkspaceTarget(workingDir ?? requestedTarget?.root ?? projectPath);
}

export function isWorkspaceToolName(name: string): name is WorkspaceToolName {
  return (WORKSPACE_TOOL_NAMES as readonly string[]).includes(name);
}

const UNAVAILABLE_MESSAGE =
  "Sandbox workspace is unavailable. Local workspace fallback was denied.";

function unavailable(reason: "backend_missing" | "backend_failed"): AgentToolResult<unknown> {
  return toolError(UNAVAILABLE_MESSAGE, {
    code: "sandbox_workspace_unavailable",
    localFallbackDenied: true,
    reason,
  });
}

/** Execute only through the bound sandbox backend. This function contains no
 * local path or process primitive, including its error path. */
export async function executeSandboxWorkspaceTool(
  target: SandboxWorkspaceTarget,
  toolName: WorkspaceToolName,
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
): Promise<AgentToolResult<unknown>> {
  if (!target.backend) return unavailable("backend_missing");
  try {
    return await target.backend.execute({
      binding: target.binding,
      toolName,
      toolCallId,
      params,
      signal,
      onUpdate,
    });
  } catch {
    return unavailable("backend_failed");
  }
}

export function isLocalFallbackDenied(result: AgentToolResult<unknown>): boolean {
  const details = result.details as Record<string, unknown> | undefined;
  return details?.["code"] === "sandbox_workspace_unavailable"
    && details["localFallbackDenied"] === true;
}

/** Refuse a host-only project path before it can inspect an AMD path or
 * launch a host process. Callers use this until that operation has a real
 * sandbox transport. */
export function denyUnsupportedSandboxHostAccess(
  target: WorkspaceTarget | undefined,
  operation: string,
): void {
  if (target?.kind !== "sandbox") return;
  const error = new Error(
    `Sandbox workspace route for ${operation} is unavailable. Local workspace fallback was denied.`,
  );
  error.name = target.backend
    ? "sandbox_workspace_operation_unsupported"
    : "sandbox_workspace_unavailable";
  throw error;
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function workspaceResultError(result: AgentToolResult<unknown>): Error | null {
  const details = result.details as Record<string, unknown> | undefined;
  if (details?.["isError"] !== true) return null;
  const error = new Error(resultText(result) || "Sandbox workspace operation failed");
  error.name = typeof details["code"] === "string"
    ? details["code"]
    : "sandbox_workspace_operation_failed";
  return error;
}

/**
 * Code-based agents use the older ShellProvider/FileProvider surface rather
 * than built-in tools. Adapt that surface to the same sandbox backend so a
 * workflow or nested code agent cannot bypass the selected target.
 */
export function createSandboxAgentProviders(
  target: SandboxWorkspaceTarget,
): { shell: ShellProvider; file: FileProvider } {
  let callSequence = 0;
  const execute = async (
    toolName: WorkspaceToolName,
    params: Record<string, unknown>,
  ): Promise<AgentToolResult<unknown>> => executeSandboxWorkspaceTool(
    target,
    toolName,
    `agent-provider-${++callSequence}`,
    params,
  );

  const shell: ShellProvider = {
    async run(command, options): Promise<ShellResult> {
      const result = await execute("shell", {
        command,
        ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
      });
      const failure = workspaceResultError(result);
      if (failure) throw failure;
      const details = (result.details ?? {}) as Record<string, unknown>;
      return {
        stdout: typeof details["stdout"] === "string" ? details["stdout"] : resultText(result),
        stderr: typeof details["stderr"] === "string" ? details["stderr"] : "",
        exitCode: typeof details["exitCode"] === "number" ? details["exitCode"] : 0,
      };
    },
  };

  const file: FileProvider = {
    async read(path) {
      const result = await execute("readFile", { path });
      const failure = workspaceResultError(result);
      if (failure) throw failure;
      return resultText(result);
    },
    async write(path, content) {
      const result = await execute("editFile", { path, new_string: content });
      const failure = workspaceResultError(result);
      if (failure) throw failure;
    },
    async exists(path) {
      const result = await execute("readFile", { path });
      if (isLocalFallbackDenied(result)) throw workspaceResultError(result)!;
      return (result.details as Record<string, unknown> | undefined)?.["isError"] !== true;
    },
  };

  return { shell, file };
}

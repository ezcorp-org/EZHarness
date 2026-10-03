import { realpath } from "node:fs/promises";
import { authorizeProjectOperation } from "./project-access";
import { checkProjectGitConfiguration, createProjectCommandRunner, type ProjectCommandRunner } from "./project-open-pr";
import { redactToolCallOutputContent } from "./audit-redaction";
import { resolveReverseRpcMeta } from "./tool-executor/provenance";
import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import { LifecycleError } from "./v4/types";
import type { WorkspaceTarget } from "../runtime/workspaces/target";
import { createSandboxProjectCommandRunner } from "../runtime/workspaces/project-command-runner";
import { resolveProjectWorkspaceTarget } from "../runtime/workspaces/project-target";

export type ProjectGitOperation = "gitHead" | "commitSubjects" | "origin";

async function readProjectGitWithRunner(projectRoot: string, operation: ProjectGitOperation, sinceHash: string | undefined, run: ProjectCommandRunner): Promise<unknown> {
  if (sinceHash !== undefined && !/^[a-f0-9]{40}$/.test(sinceHash)) throw new LifecycleError("invalid_input", "The starting commit must be a full commit hash.");
  await checkProjectGitConfiguration(run, projectRoot);
  const args = operation === "origin" ? ["config", "--local", "--no-includes", "--get", "remote.origin.url"] : ["log", "--no-show-signature", "--no-decorate", "--no-color", operation === "gitHead" || sinceHash === undefined ? "-1" : "-1000", operation === "gitHead" ? "--format=%H%x00%s" : "--format=%s", sinceHash ? `${sinceHash}..HEAD` : "HEAD", "--"];
  const result = await run(["git", ...args], projectRoot);
  if (result.exitCode !== 0) return operation === "commitSubjects" ? [] : null;
  const output = result.stdout.trim();
  if (operation === "origin") {
    const match = /^(?:https:\/\/(?:[^\s/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(output);
    return match ? `https://github.com/${match[1]}` : null;
  }
  if (operation === "commitSubjects") return redactToolCallOutputContent(output.split("\n").filter(Boolean));
  const separator = output.indexOf("\0");
  const hash = output.slice(0, separator);
  if (separator !== 40 || !/^[a-f0-9]{40}$/.test(hash)) return null;
  return { hash, subject: redactToolCallOutputContent(output.slice(separator + 1)) };
}

export async function readProjectGit(projectRoot: string, operation: ProjectGitOperation, sinceHash?: string, run: ProjectCommandRunner = createProjectCommandRunner(undefined, { timeoutMs: 10_000, outputBytes: 1024 * 1024 })): Promise<unknown> {
  return readProjectGitWithRunner(await realpath(projectRoot), operation, sinceHash, run);
}

export async function readProjectGitForTarget(
  target: WorkspaceTarget | undefined,
  projectRoot: string,
  operation: ProjectGitOperation,
  sinceHash?: string,
): Promise<unknown> {
  if (target?.kind !== "sandbox") {
    return readProjectGit(projectRoot, operation, sinceHash);
  }
  // The virtual root is interpreted by the backend. Never canonicalize the
  // AMD project path for a sandbox-selected call.
  return readProjectGitWithRunner(
    ".",
    operation,
    sinceHash,
    createSandboxProjectCommandRunner(target),
  );
}

export async function handleProjectGit(deps: RpcHandlerDeps, extensionId: string, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const resolved = resolveReverseRpcMeta(extensionId, request);
  if (!resolved.ok) return resolved.errorResponse;
  try {
    const operation = request.method.slice("ezcorp/project.".length);
    if (!["gitHead", "commitSubjects", "origin"].includes(operation)) throw new LifecycleError("invalid_input", "Unknown project read operation.");
    const input = request.params as Record<string, unknown> | undefined;
    if (!input || Object.keys(input).some(key => key !== "_meta" && key !== "_toolName" && !(operation === "commitSubjects" && key === "sinceHash")) || (input.sinceHash !== undefined && (typeof input.sinceHash !== "string" || !/^[a-f0-9]{40}$/.test(input.sinceHash)))) throw new LifecycleError("invalid_input", "Provide only a valid starting commit hash for commitSubjects.");
    const { project } = await authorizeProjectOperation(deps, extensionId, resolved.onBehalfOf, resolved.conversationId, `project.${operation}`, [{ kind: "shell" }], resolved.prov.projectId, resolved.prov.projectBindingId);
    const target = await resolveProjectWorkspaceTarget(project, `project ${operation}`, resolved.prov.workspaceTarget);
    const result = await readProjectGitForTarget(
      target,
      project.path!,
      operation as ProjectGitOperation,
      input.sinceHash as string | undefined,
    );
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (cause) {
    return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: cause instanceof LifecycleError ? cause.message : "Project read failed." } };
  }
}

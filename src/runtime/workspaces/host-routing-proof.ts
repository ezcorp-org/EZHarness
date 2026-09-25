import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getBuiltinToolDefs, type BuiltinToolDef } from "../tools";
import {
  isLocalFallbackDenied,
  sandboxWorkspaceTarget,
  type SandboxWorkspaceBinding,
  type SandboxWorkspaceTarget,
} from "./target";

export type SandboxLocalFallbackProofCase = {
  toolName: "readFile" | "editFile" | "shell";
  localFallbackDenied: true;
};

/** Host-produced SP05 receipt. Candidate conformance compares every binding
 * field and case before it records the static qualification. */
export interface SandboxLocalFallbackProof {
  binding: Readonly<SandboxWorkspaceBinding>;
  cases: readonly SandboxLocalFallbackProofCase[];
  hostCanaryUnchanged: true;
}

/** @internal Fault-injection seam for the controlled boundary-removal test. */
export interface SandboxLocalFallbackProofDependencies {
  getToolDefs?: (target: SandboxWorkspaceTarget) => BuiltinToolDef[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute the production workspace-tool route with no sandbox backend.
 *
 * This proof is intentionally provider-independent: candidate qualification
 * has no live connection. The exact synthetic release/provider/preset binding
 * still travels through the same target and tool dispatch used at runtime.
 */
export async function proveSandboxLocalFallbackDenied(
  binding: SandboxWorkspaceBinding,
  dependencies: SandboxLocalFallbackProofDependencies = {},
): Promise<SandboxLocalFallbackProof> {
  const hostRoot = await mkdtemp(join(tmpdir(), "ez-sandbox-routing-proof-"));
  const readCanary = join(hostRoot, "amd-read-canary.txt");
  const writeCanary = join(hostRoot, "amd-write-canary.txt");
  const processCanary = join(hostRoot, "amd-process-canary.txt");
  const readValue = "AMD_LOCAL_READ_CANARY";

  try {
    await writeFile(readCanary, readValue);
    const target = sandboxWorkspaceTarget(binding, null);
    const toolDefs: BuiltinToolDef[] = (dependencies.getToolDefs ?? getBuiltinToolDefs)(target);
    const tools = new Map(toolDefs.map((tool) => [tool.name, tool]));
    const calls = [
      { toolName: "readFile" as const, params: { path: readCanary } },
      { toolName: "editFile" as const, params: { path: writeCanary, new_string: "LOCAL_WRITE" } },
      { toolName: "shell" as const, params: { command: `touch ${processCanary}` } },
    ];

    const cases: SandboxLocalFallbackProofCase[] = [];
    for (const call of calls) {
      const tool = tools.get(call.toolName);
      if (!tool) throw new Error(`Workspace routing proof is missing ${call.toolName}`);
      const result = await tool.execute(`sp05-${call.toolName}`, call.params);
      if (!isLocalFallbackDenied(result)) {
        throw new Error(`Workspace routing proof allowed ${call.toolName} to reach the AMD host`);
      }
      cases.push({ toolName: call.toolName, localFallbackDenied: true });
    }

    if (
      await readFile(readCanary, "utf8") !== readValue
      || await exists(writeCanary)
      || await exists(processCanary)
    ) {
      throw new Error("Workspace routing proof changed an AMD host canary");
    }

    return Object.freeze({
      binding: target.binding,
      cases: Object.freeze(cases),
      hostCanaryUnchanged: true,
    });
  } finally {
    await rm(hostRoot, { recursive: true, force: true });
  }
}

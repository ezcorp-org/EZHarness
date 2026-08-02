/**
 * The three tools ez-factory's workflow templates dispatch to, assembled
 * into the handler map `createToolDispatcher` wants.
 *
 * ── No `rbacScope` on any of them ──────────────────────────────────────
 *
 * `ToolExecutor.executeToolCall` enforces a DECLARED tool-level
 * `rbacScope` by resolving the grant against a project **derived from the
 * conversation** (`src/extensions/tool-executor/executor.ts`, the
 * `requiredScope` block). That is the one remaining conversation-derived
 * decision left on the workflow tool path, and a workflow tool step runs
 * under the synthetic key `workflow-run:<uuid>`
 * (`src/runtime/workflow-executor.ts`) — a conversation row that does not
 * exist and therefore has no project. Declaring a scope on any of these
 * would not tighten anything; it would deny every call made from inside a
 * workflow, which is the only place they are called from.
 *
 * The extension's three `rbacScopes` stay what the manifest says they are:
 * declarations for CONSOLE BUTTONS, queried through `ctx.rbac.check`,
 * which resolves the extension from the subprocess identity rather than
 * from a conversation.
 *
 * ── Where the size ceiling is enforced ─────────────────────────────────
 *
 * In `runTool` (`./shared.ts`), once, for all three — not per tool. A tool
 * cannot forget it, and a fourth tool added later inherits it.
 */
import { toolError, toolResult, type ToolHandler } from "@ezcorp/sdk/runtime";
import type { ToolCallResult } from "@ezcorp/sdk";

import { EMIT_ARTIFACT_TOOL, createEmitArtifact } from "./emit-artifact";
import { READ_FILES_TOOL, createReadFiles } from "./read-files";
import { WRITE_FILE_TOOL, createWriteFile } from "./write-file";
import type { ToolDeps, ToolOutcome } from "./shared";

/** Every tool this extension exposes, in manifest order. `tools.test.ts`
 *  asserts this is exactly the manifest's `tools[].name` set, so adding a
 *  tool in one place and not the other fails a named test rather than
 *  producing a manifest whose declaration nothing serves. */
export const FACTORY_TOOL_NAMES = [
  READ_FILES_TOOL,
  WRITE_FILE_TOOL,
  EMIT_ARTIFACT_TOOL,
] as const;

/** Convert the internal outcome into the SDK's wire result. Kept in one
 *  place so `isError` and the error `code` cannot drift per tool. */
function toResult(outcome: ToolOutcome): ToolCallResult {
  return outcome.ok ? toolResult(outcome.text) : toolError(outcome.text, outcome.code);
}

export function createFactoryToolHandlers(deps: ToolDeps): Record<string, ToolHandler> {
  const impls: Record<string, (input: unknown) => Promise<ToolOutcome>> = {
    [READ_FILES_TOOL]: createReadFiles(deps),
    [WRITE_FILE_TOOL]: createWriteFile(deps),
    [EMIT_ARTIFACT_TOOL]: createEmitArtifact(deps),
  };
  const handlers: Record<string, ToolHandler> = {};
  for (const name of FACTORY_TOOL_NAMES) {
    const impl = impls[name] as (input: unknown) => Promise<ToolOutcome>;
    handlers[name] = async (args) => toResult(await impl(args));
  }
  return handlers;
}

export { EMIT_ARTIFACT_TOOL, READ_FILES_TOOL, WRITE_FILE_TOOL };
export type { ToolDeps, ToolOutcome };

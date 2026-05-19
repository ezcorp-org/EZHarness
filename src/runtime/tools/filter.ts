import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { BuiltinToolDef } from "./types";

/**
 * Orchestration tools that are always preserved even under the most restrictive
 * scoping — agents still need to delegate, coordinate, and ask for input even
 * when all other tools are filtered out.
 */
export const ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set([
  "invoke_agent",
  // Human-in-the-loop is provided by the bundled `ask-user` extension.
  // The registry exposes the tool under the namespaced form, which is
  // what the LLM sees and what the filter must preserve. Auto-wired
  // every turn — see src/runtime/ask-user-host.ts.
  "ask-user__ask_user_question",
  // Scratchpad tools live in the `scratchpad` bundled extension as of
  // Phase 1 of the built-in-to-extension conversion. The namespaced
  // form (`<ext>__<tool>`) is what the filter sees at runtime — see
  // src/extensions/tool-executor.ts:326-329 for the `__` separator.
  "scratchpad__scratchpad_write",
  "scratchpad__scratchpad_read",
  "task_plan",
  "task_start",
  "task_complete",
  "task_fail",
  "task_update",
  "task_list",
  "task_subtask_toggle",
  "task_assign",
  "task_unassign",
]);

export interface ToolFilterOptions {
  /**
   * Coarse restriction by tool category.
   * - 'all'       — no category-level filter (the default)
   * - 'read-only' — keep only tools whose builtinDef.category === 'read'
   * - 'none'      — strip every non-orchestration tool
   * - 'allowlist' — pass-through; the actual filtering happens in the
   *                 `allowedTools` step below. This value exists so a mode
   *                 row can declaratively state "tool selection is governed
   *                 by allowed_tools" without a separate flag column. The
   *                 Ez concierge mode uses this. (Phase 48.)
   */
  toolRestriction?: "all" | "read-only" | "none" | "allowlist";
  /** If set & non-empty, only these tool names are kept (plus orchestration tools). */
  allowedTools?: string[];
  /** Tool names to always remove (applied after allow list). Orchestration tools are never removed. */
  deniedTools?: string[];
}

/**
 * Apply layered tool filters in order: restriction → allow → deny.
 * Orchestration tools are always preserved.
 *
 * @param tools The full set of agent tools to filter
 * @param builtinDefs Map of tool name → builtin def (for category lookup). Extension
 *                    tools that are not in the map are treated as non-read (filtered
 *                    out under "read-only"). Pass an empty map to skip category checks.
 * @param opts Filter options. Any undefined / empty list is a no-op for that layer.
 */
export function applyToolFilters(
  tools: AgentTool[],
  builtinDefs: ReadonlyMap<string, BuiltinToolDef>,
  opts: ToolFilterOptions,
): AgentTool[] {
  let out = tools;

  if (opts.toolRestriction === "read-only") {
    out = out.filter((t) => {
      if (ORCHESTRATION_TOOLS.has(t.name)) return true;
      const def = builtinDefs.get(t.name);
      return def ? def.category === "read" : false;
    });
  } else if (opts.toolRestriction === "none") {
    out = out.filter((t) => ORCHESTRATION_TOOLS.has(t.name));
  } else if (opts.toolRestriction === "allowlist") {
    // Fail-closed: 'allowlist' restriction without an allowedTools list is a
    // misconfiguration. Strip everything except orchestration tools so a stray
    // mode update can't accidentally expose the full toolset to the LLM.
    // The intended path supplies allowedTools below; this branch only fires
    // if allowedTools is missing/empty alongside restriction='allowlist'.
    if (!opts.allowedTools || opts.allowedTools.length === 0) {
      out = out.filter((t) => ORCHESTRATION_TOOLS.has(t.name));
    }
  }

  if (opts.allowedTools && opts.allowedTools.length > 0) {
    const allow = new Set(opts.allowedTools);
    out = out.filter((t) => ORCHESTRATION_TOOLS.has(t.name) || allow.has(t.name));
  }

  if (opts.deniedTools && opts.deniedTools.length > 0) {
    const deny = new Set(opts.deniedTools);
    out = out.filter((t) => ORCHESTRATION_TOOLS.has(t.name) || !deny.has(t.name));
  }

  return out;
}

/**
 * Orchestration tools that are always preserved even under the most restrictive
 * scoping — agents still need to delegate, coordinate, and ask for input even
 * when all other tools are filtered out.
 *
 * ONE exception: `forceDeniedTools` (the conversation's explicit per-tool
 * toggles from the composer's Tools dropdown) removes them too — that list
 * is always direct user intent, never a broad mode/team scope.
 */
export const ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set([
  "invoke_agent",
  // Phase B2 background sub-agents: the counterpart to `invoke_agent` for
  // fetching a background child's result. Preserved for the same reason — an
  // orchestrator that can dispatch a background agent under a restrictive
  // scope must still be able to collect it, or the result is unreachable.
  // Un-namespaced (the form the host wires via wireOrchestrationToolsForTurn),
  // matching `invoke_agent`.
  "collect_agent_result",
  // Claude-Code SendMessage parity: steer a running child (enqueue a message
  // onto its sub-conversation) or continue a terminal one (a fresh run on the
  // reused sub-conversation). Preserved for the same reason as
  // `collect_agent_result` — an orchestrator under a restrictive scope must
  // still be able to steer/continue a child it already spawned. Bare name,
  // wired every turn by wireOrchestrationToolsForTurn.
  "send_to_agent",
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

/**
 * Bare tool names the HOST's orchestration wiring makes legitimately
 * LONG-BLOCKING: they await async events (sub-agent completion / background
 * poll) the host does not observe as forward-call traffic, so the flat 30s
 * subprocess RPC timeout (and the ~90s parent-run watchdog) would otherwise
 * kill them mid-wait — and killing the SHARED orchestration subprocess drops
 * every backgroundSpawn + in-flight invoke across all conversations.
 *
 * HOST-CONTROLLED — a third-party manifest CANNOT self-grant this exemption:
 *   1. These bare names are only ever produced by the host's own
 *      `wireOrchestrationToolsForTurn`; every third-party extension tool is
 *      wired NAMESPACED (`<ext>__<tool>`), so its `event.toolName` / dispatch
 *      name never bare-matches this set.
 *   2. The subprocess-timeout skip additionally requires the tool to belong to
 *      a BUNDLED extension (`registry.isBundled`) — the same trust root the
 *      integrity-skip uses.
 * A third-party tool that blocks a long time is still bounded by the parent-run
 * watchdog (which it cannot defer — the widened budget below is host-only).
 */
export const LONG_BLOCKING_ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set([
  // Blocks up to its resolved (sliding) give-up timeout awaiting the child's
  // terminal `task:assignment_update`.
  "invoke_agent",
  // Blocks up to `waitSeconds` (sliding on child activity) awaiting a
  // background child's terminal.
  "collect_agent_result",
]);

/**
 * BOUNDED parent-run watchdog defer budget for a synchronous
 * {@link LONG_BLOCKING_ORCHESTRATION_TOOLS} call. Only `collect_agent_result`
 * reaches the run watchdog — `invoke_agent`'s tool:start is suppressed in
 * subscribe-bridge (it streams its own agent:* liveness), so the orchestrator
 * run stays alive via those bumps. A blocking `collect` emits no such events,
 * so without this it trips the ~90s idle kill (F1).
 *
 * Bounded (not indefinite) per the "prefer bounded" preference: sized to the
 * `invoke_agent` per-call timeout ceiling (3600s) so a legitimate collect wait
 * (≤600s of child idle, extended while the child keeps emitting activity) is
 * never killed, while a genuinely-wedged collect is still bounded rather than
 * deferred forever. A subprocess-level `skipTimeout` (see tool-executor) keeps
 * the shared subprocess alive across the same window — the subprocess cap must
 * be UNBOUNDED there because the activity-sliding deadline + configurable
 * `maxCycles` exceed any fixed cap, and the tool self-bounds via its own
 * reap/gate.
 */
export const LONG_BLOCKING_WATCHDOG_BUDGET_MS = 3_600_000;

/** Strip a leading `<ns>__` namespace prefix. Extension tools reach the filter
 *  under their runtime AgentTool name, which is `<ext>__<tool>` for every
 *  extension EXCEPT orchestration (wired bare), so a bare set entry never
 *  matches a namespaced tool name without this. Returns the input unchanged
 *  when there's no `__`. */
function stripToolNamespace(name: string): string {
  const i = name.indexOf("__");
  return i === -1 ? name : name.slice(i + 2);
}

/**
 * True iff `name` is an always-preserved orchestration/coordination tool.
 * Matches BOTH forms so the carve-out works regardless of how a tool is wired:
 *   • the raw name — for entries listed namespaced (e.g.
 *     `ask-user__ask_user_question`, `scratchpad__scratchpad_write`) and for
 *     orchestration's bare-wired `invoke_agent` / `collect_agent_result`;
 *   • the namespace-stripped name — for tools wired NAMESPACED whose set entry
 *     is bare. task-tracking wires `task-tracking__task_plan` etc., but the set
 *     lists bare `task_plan` — without the stripped check those bare entries
 *     were DEAD and the task tools got stripped under `read-only` / `none` /
 *     restrictive `deniedTools` scopes (an orchestrator lost task_plan et al.).
 */
export function isPreservedOrchestrationTool(name: string): boolean {
  return (
    ORCHESTRATION_TOOLS.has(name) ||
    ORCHESTRATION_TOOLS.has(stripToolNamespace(name))
  );
}

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
  /**
   * Tool names to remove UNCONDITIONALLY — the only layer that strips
   * orchestration tools. Reserved for the conversation's explicit per-tool
   * toggles (computeModeToolScope compiles conv.extensionTools into this);
   * broad mode/team scopes must use `deniedTools` instead.
   */
  forceDeniedTools?: string[];
  /**
   * Tool names the CALLER vouches are read-only, honored ONLY inside the
   * `toolRestriction: 'read-only'` branch. Exists for extension tools,
   * which carry no builtin category and would otherwise be stripped
   * wholesale under read-only — the Daily Briefing pipeline passes the
   * web-search extension's namespaced tool names here so an unattended
   * run can research watchlist topics (spec §5.2) without re-admitting
   * any write/execute capability. Fail-closed: empty/absent means the
   * pre-existing behavior (category === 'read' builtins only). This is a
   * HOST-CODE trust declaration — never populate it from user input.
   */
  readOnlyAllowedTools?: string[];
}

/**
 * Apply layered tool filters in order: restriction → allow → deny.
 * Orchestration tools are always preserved.
 *
 * Generic over any `{ name }` shape: the executor passes `AgentTool[]`,
 * the `/api/tools` listing endpoint passes its metadata rows — both get
 * the SAME filter semantics, which is what keeps the header badge in
 * lock-step with the runtime tool surface.
 *
 * @param tools The full set of tools to filter (matched by `.name`)
 * @param builtinDefs Map of tool name → builtin def (for category lookup). Extension
 *                    tools that are not in the map are treated as non-read (filtered
 *                    out under "read-only"). Pass an empty map to skip category checks.
 * @param opts Filter options. Any undefined / empty list is a no-op for that layer.
 */
export function applyToolFilters<T extends { name: string }>(
  tools: T[],
  builtinDefs: ReadonlyMap<string, { category: string }>,
  opts: ToolFilterOptions,
): T[] {
  let out = tools;

  if (opts.toolRestriction === "read-only") {
    const readOnlyVouched = new Set(opts.readOnlyAllowedTools ?? []);
    out = out.filter((t) => {
      if (isPreservedOrchestrationTool(t.name)) return true;
      if (readOnlyVouched.has(t.name)) return true;
      const def = builtinDefs.get(t.name);
      return def ? def.category === "read" : false;
    });
  } else if (opts.toolRestriction === "none") {
    out = out.filter((t) => isPreservedOrchestrationTool(t.name));
  } else if (opts.toolRestriction === "allowlist") {
    // Fail-closed: 'allowlist' restriction without an allowedTools list is a
    // misconfiguration. Strip everything except orchestration tools so a stray
    // mode update can't accidentally expose the full toolset to the LLM.
    // The intended path supplies allowedTools below; this branch only fires
    // if allowedTools is missing/empty alongside restriction='allowlist'.
    if (!opts.allowedTools || opts.allowedTools.length === 0) {
      out = out.filter((t) => isPreservedOrchestrationTool(t.name));
    }
  }

  if (opts.allowedTools && opts.allowedTools.length > 0) {
    const allow = new Set(opts.allowedTools);
    out = out.filter((t) => isPreservedOrchestrationTool(t.name) || allow.has(t.name));
  }

  if (opts.deniedTools && opts.deniedTools.length > 0) {
    const deny = new Set(opts.deniedTools);
    out = out.filter((t) => isPreservedOrchestrationTool(t.name) || !deny.has(t.name));
  }

  if (opts.forceDeniedTools && opts.forceDeniedTools.length > 0) {
    const deny = new Set(opts.forceDeniedTools);
    out = out.filter((t) => !deny.has(t.name));
  }

  return out;
}

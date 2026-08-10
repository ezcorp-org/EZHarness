import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";

/**
 * Error convention for built-in tools: NEVER throw — a thrown tool kills
 * the whole turn, a returned error result lets the LLM read it and
 * recover. 17 of the 28 files under `src/runtime/tools/` hand-rolled this
 * exact `{ content, details }` envelope (`run-workflow.ts` was the first to
 * extract it locally, as `errorResult`); this is that helper promoted to a
 * shared home so the shape lives in one place.
 *
 * `extra` is merged in AFTER `isError: true` so a tool that carries richer
 * failure details than the bare convention — `shell`'s
 * `exitCode`/`stdout`/`stderr`/`streaming`, `grep`'s
 * `matchCount`/`pattern`/`timeout`/`aborted` — can still shape its own
 * `details` without re-deriving the envelope. Omit `extra` for the plain
 * `{ isError: true }` case the majority of call sites use.
 */
export function toolError(
  message: string,
  extra?: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { isError: true, ...extra },
  };
}

/**
 * The message text a caught value contributes to a `toolError` call:
 * `e.message` for a real `Error`, `String(e)` for anything else (a thrown
 * string, a rejected non-Error value). Every built-in's catch block reduces
 * to `toolError(errorMessage(e))` (or with `extra` for the richer shapes
 * above) instead of repeating the `instanceof Error ? … : …` ternary.
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * "ez" was added in Phase 48 for the in-app concierge tools (propose_*,
 * summarize_conversation, find_agents, fill_form, navigate_to). Adding a
 * dedicated category — rather than reusing read/write/execute — keeps the
 * Ez allowlist mode self-describing and lets the /api/tools listing group
 * them under their own section.
 */
export type ToolCategory = "read" | "write" | "execute" | "ez";

export type PermissionMode = "ask" | "auto-edit" | "yolo";

// `ez-propose` routes the propose_* concierge tools' results to the
// frontend EzToolResultCard — a one-button "Open prefilled form" card
// built from the tool's `{ draftId, openUrl }` output. Without it the
// result falls through to DefaultCard and the form is never surfaced
// (the EZ system prompt promises "a card with a button that opens the
// prefilled form").
export type CardType = "terminal" | "diff" | "search-results" | "table" | "default" | "ez-propose";

export interface BuiltinToolDef {
  name: string;
  label: string;
  description: string;
  category: ToolCategory;
  cardType: CardType;
  /** Built-ins are always inline — this field exists for wire compat with
   *  the extension `ToolDefinition.cardLayout` and is not exercised today. */
  cardLayout?: "inline" | "dock";
  /**
   * Phase 48 client-side directive marker. When `true`, the tool is NOT a
   * pure server-side computation — its `execute` body is a stub that emits
   * an `ez:client-tool` event on the runtime bus and returns a deferred
   * placeholder. The Ez panel intercepts the event, runs the actual UI
   * operation (filling a form, navigating), and POSTs the resolution back
   * to `/api/conversations/.../tool-results` so the LLM continues. Wave 3
   * wires the panel side; Wave 2 ships the stub + the event-emit. The
   * field is optional so non-Ez tools don't need to think about it.
   */
  clientSide?: boolean;
  /** TypeBox schema wrapping the JSON-Schema describing the tool's args.
   *  Tool factories construct this with `Type.Unsafe({...})`; the inner
   *  parameter type is the pi-ai `Tool<TSchema>["parameters"]` default —
   *  kept at the base `TSchema` because each tool carries its own narrow
   *  shape and we don't gain much from threading a generic through this
   *  union. */
  parameters: Tool["parameters"];
  /**
   * Maximum size (in bytes) of the tool's text output that will be forwarded
   * to the model. Populated by getBuiltinToolDefs via getToolOutputLimit; the
   * individual tool factories do not need to set this themselves.
   */
  maxOutputBytes?: number;
  /**
   * Optional per-call timeout (ms) the watchdog uses to defer the idle kill
   * while this built-in is in flight. Mirrors the manifest
   * `resources.callTimeoutMs` field for extension tools. Omit for the
   * default ({@link DEFAULT_BUILTIN_CALL_TIMEOUT_MS}, which equals
   * `WATCHDOG_IDLE_MS` so undeclared built-ins behave exactly as
   * pre-Tier-2). Declare only when the tool can legitimately exceed the
   * idle threshold under normal load (e.g. shell builds, LLM-backed
   * summarization). See `.planning/watchdog-builtins-hotfix.md`.
   */
  callTimeoutMs?: number;
  /**
   * Tool entry point. `params` is `unknown` because pi-agent-core delivers
   * args as a decoded-JSON blob without validating against `parameters`
   * at runtime — each tool factory is responsible for narrowing via
   * destructuring + type guards before use.
   */
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ) => Promise<AgentToolResult<unknown>>;
}

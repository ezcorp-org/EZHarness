/**
 * Phase 48 Wave 3 — client-tool dispatcher.
 *
 * The runtime emits an `ez:client-tool` event when the LLM calls a
 * tool flagged `clientSide: true` (today: `fill_form` and
 * `navigate_to`). The Ez panel forwards each event to `dispatch()`,
 * which:
 *
 *   - looks up the registered handler in `registry.ts` for `fill_form`
 *     and runs it; or
 *   - calls SvelteKit's `goto(path)` for `navigate_to` after a
 *     same-origin allowlist check.
 *
 * The function returns a `DispatchResult` describing the outcome —
 * the runtime already received the deferred-marker tool result; this
 * return value is for *panel-side* logging and tests, not for the LLM.
 *
 * Why we re-validate `navigate_to` here even though the server tool
 * already does: defense-in-depth. The server check guards against a
 * malicious or buggy LLM. This check guards against a malicious or
 * buggy *server* — if someone compromises the SSE stream (or a future
 * extension emits the event directly), the panel still refuses to
 * navigate off-origin.
 */
import { findFormHandler } from "./registry";

const ALLOWED_ROUTE_PREFIXES = [
  "/project/", "/agents/", "/agents", "/new-project", "/marketplace",
  "/extensions/", "/extensions", "/settings", "/active-agents",
  "/memories", "/pipelines", "/runs", "/observability", "/account",
  "/admin/", "/admin", "/docs/", "/docs",
] as const;

export interface EzClientToolEvent {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type DispatchResult =
  | { ok: true; toolName: string; toolCallId: string; detail?: Record<string, unknown> }
  | { ok: false; toolName: string; toolCallId: string; error: string; code: "no-handler" | "invalid-input" | "rejected" | "unknown-tool" };

export interface DispatcherDeps {
  /** Page-level navigator. Pass SvelteKit's `goto` in production. */
  goto: (path: string) => Promise<unknown> | unknown;
  /** Override the form-handler lookup (tests). */
  findHandler?: typeof findFormHandler;
}

function isInAppPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("://")) return false;
  if (/[\r\n]/.test(path)) return false;
  // Strip query/hash for prefix matching but keep the original for goto().
  const justPath = path.replace(/[?#].*$/, "");
  return ALLOWED_ROUTE_PREFIXES.some((p) =>
    p.endsWith("/") ? justPath.startsWith(p) : justPath === p || justPath.startsWith(p + "/") || justPath.startsWith(p + "?") || justPath.startsWith(p + "#"),
  );
}

export function isAllowedNavigateTarget(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && isInAppPath(path);
}

export async function dispatch(event: EzClientToolEvent, deps: DispatcherDeps): Promise<DispatchResult> {
  const findHandler = deps.findHandler ?? findFormHandler;

  if (event.toolName === "fill_form") {
    const input = event.input as { formId?: unknown; values?: unknown } | null | undefined;
    const formId = typeof input?.formId === "string" ? input.formId : "";
    const values = (input?.values && typeof input.values === "object") ? input.values as Record<string, unknown> : null;

    if (!formId) {
      return {
        ok: false,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        error: "fill_form requires a non-empty formId",
        code: "invalid-input",
      };
    }
    if (!values) {
      return {
        ok: false,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        error: "fill_form requires a values object",
        code: "invalid-input",
      };
    }

    const handler = findHandler(formId);
    if (!handler) {
      return {
        ok: false,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        error: `No handler registered for form '${formId}'. The current page does not expose this form to Ez.`,
        code: "no-handler",
      };
    }

    try {
      handler.fill(values);
    } catch (err) {
      return {
        ok: false,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        error: `fill_form handler threw: ${(err as Error)?.message ?? String(err)}`,
        code: "rejected",
      };
    }

    return { ok: true, toolName: event.toolName, toolCallId: event.toolCallId, detail: { formId } };
  }

  if (event.toolName === "navigate_to") {
    const input = event.input as { path?: unknown } | null | undefined;
    const path = input?.path;
    if (!isAllowedNavigateTarget(path)) {
      return {
        ok: false,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        error: `navigate_to refused: '${String(path)}' is not a same-origin in-app route.`,
        code: "rejected",
      };
    }
    try {
      await deps.goto(path);
    } catch (err) {
      return {
        ok: false,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        error: `navigate_to failed: ${(err as Error)?.message ?? String(err)}`,
        code: "rejected",
      };
    }
    return { ok: true, toolName: event.toolName, toolCallId: event.toolCallId, detail: { path } };
  }

  return {
    ok: false,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    error: `Unknown ez client tool '${event.toolName}'`,
    code: "unknown-tool",
  };
}

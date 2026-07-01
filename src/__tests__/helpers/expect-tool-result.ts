/**
 * Type-narrowing assertion helpers for Ez/builtin tool results.
 *
 * PROBLEM: `BuiltinToolDef.execute` returns `Promise<AgentToolResult<unknown>>`
 * — the runtime contract is intentionally loose so the registry can hold
 * heterogeneous tools in one array without leaking each tool's details
 * shape into the type system. That looseness shows up at the assertion
 * site as ~50 spurious errors:
 *
 *   - `result.details` is `unknown` → can't read `.kind`, `.draftId`, etc.
 *   - `result.content[0]` is `TextContent | ImageContent | undefined`
 *     under `noUncheckedIndexedAccess`, and `.text` is only on TextContent.
 *
 * Tightening the production return type to a discriminated union over the
 * five-tool family was considered (and is still a reasonable cleanup),
 * but two of the seven Ez tools — `fill_form` and `navigate_to` — have
 * mid-flight wiring changes touching the same lines (a parallel
 * `fix-wiring` agent owns them). Adding a return-type generic across
 * all seven on top of that change would produce a merge churn out of
 * proportion to the gain.
 *
 * Helpers below let test code narrow at the assertion site instead. They
 * throw with a useful message when the shape doesn't match — same effect
 * as the previous `(result as any)` casts but with a real runtime
 * sanity check thrown in.
 *
 * Usage:
 *   const result = await tool.execute("call-1", { name: "x", path: "/x" });
 *   const text = expectText(result);                       // string
 *   const details = expectDetails<{ draftId: string; kind: 'project' }>(result);
 *   expect(details.kind).toBe('project');
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/**
 * Loose result shape — accepts any tool's return without committing to a
 * details type. Both `unknown` (the production signature) and a
 * narrowed-by-helper return value satisfy this.
 */
export type AnyToolResult = AgentToolResult<unknown>;

/**
 * Asserts the tool returned at least one TextContent block and returns
 * the joined text of all leading TextContent entries (in practice a
 * single-element array, but defensively handles multi-block text).
 *
 * Optionally asserts the text contains a substring — saves a follow-up
 * `expect(text).toContain(...)` in the common error-message-asserting
 * tests. Pass `undefined` (or omit) to skip the substring check.
 */
export function expectText(result: AnyToolResult, contains?: string): string {
  if (!result || !Array.isArray(result.content) || result.content.length === 0) {
    throw new Error(
      `expectText: tool result has no content blocks. Got: ${JSON.stringify(result)}`,
    );
  }
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error(
      `expectText: first content block is not text (got type='${first?.type}'). Full content: ${JSON.stringify(result.content)}`,
    );
  }
  const text = first.text;
  if (typeof text !== "string") {
    throw new Error(`expectText: TextContent.text is not a string (got ${typeof text}).`);
  }
  if (contains !== undefined && !text.includes(contains)) {
    throw new Error(
      `expectText: text does not contain '${contains}'. Got: ${JSON.stringify(text)}`,
    );
  }
  return text;
}

/**
 * Narrows `result.details` to a caller-supplied details type and returns
 * it. The function performs no structural validation beyond "details is a
 * non-null object" — the caller's `expect(details.foo).toBe(...)` calls
 * are the real assertion. This is intentional: per-test details shapes
 * vary widely (project drafts, summaries, ranked agent hits, deferred
 * client-tool sentinels), and a one-size-fits-all schema check would be
 * either too loose to catch anything or too rigid to allow new fields.
 *
 * Generic parameter:
 *   T - the expected details shape. The function trusts the caller. If
 *       the runtime shape doesn't match, individual `expect` calls in
 *       the test will surface the mismatch with a per-property message.
 */
// Note: T is unconstrained so that named `interface` declarations (which
// don't structurally satisfy `Record<string, unknown>` due to TS-2344
// quirks around index signatures and optional fields) flow through. The
// caller commits to the shape; this helper only checks "is an object".
export function expectDetails<T>(result: AnyToolResult): T {
  if (!result || typeof result.details !== "object" || result.details === null) {
    throw new Error(
      `expectDetails: result.details is not an object. Got: ${JSON.stringify(result?.details)}`,
    );
  }
  return result.details as T;
}

/**
 * Convenience: parses the first text block as JSON and returns the typed
 * payload. Used by Ez tools that emit a JSON envelope as their text
 * channel (propose_create_*, find_agents, propose_install_extension —
 * the JSON IS the LLM-facing tool result).
 */
export function expectJson<T>(result: AnyToolResult): T {
  const text = expectText(result);
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(
      `expectJson: text is not valid JSON. Got: ${JSON.stringify(text)}. Parse error: ${(e as Error).message}`,
    );
  }
}

/**
 * The ONE implementation of "unwrap a tool result".
 *
 * Every tool card, every streaming event handler and the inline-tool store all
 * receive the same `ToolCallResult` envelope — `{ content: [{ type: "text",
 * text: "…" }] }` — and every one of them used to unwrap it with its own
 * hand-copied re-implementation. Six copies existed when issue #142 was
 * written: `extractToolOutput` in `stores.svelte.ts`, `stringifyError` in
 * `inline-tool-store.svelte.ts`, and four in test files asserting against
 * their own private clone rather than the shipped code.
 *
 * Deliberately a plain `.ts` module (no runes, no imports): it has to be
 * loadable from the rune stores, from Svelte components, and from plain
 * bun:test suites alike.
 */

/** A text part of a `ToolCallResult.content` array. */
type ToolTextPart = { type: "text"; text: string };

/**
 * Unwrap a `ToolCallResult`-shaped object to its joined text, or return the
 * value unchanged when it isn't that shape (strings, numbers, null/undefined,
 * plain objects and content arrays with no text parts all pass through).
 */
export function extractToolOutput(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return value;
  const texts = (content as ReadonlyArray<{ type?: unknown; text?: unknown }>)
    .filter((c): c is ToolTextPart => c?.type === "text" && typeof c?.text === "string")
    .map((c) => c.text);
  return texts.length > 0 ? texts.join("\n") : value;
}

/**
 * {@link extractToolOutput}, narrowed to the string a display slot needs:
 * anything that doesn't unwrap to text is JSON-serialised. This is the form
 * the inline-tool store stores in `InlineToolCall.output` / `.error`, whose
 * only alternative was a `[object Object]` on screen.
 */
export function stringifyToolOutput(value: unknown): string {
  const unwrapped = extractToolOutput(value);
  return typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped);
}

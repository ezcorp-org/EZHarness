/**
 * Tool output size limits.
 *
 * OpenAI's Responses API rejects any single input string longer than 10 MiB
 * (error: "Invalid 'input[N].output': string too long. Expected a string with
 * maximum length 10485760..."). When a tool returns a result that gets replayed
 * into the model on the next turn, an oversized output kills the whole chat.
 *
 * We cap each tool's text output below that limit with headroom, so a single
 * runaway tool call can't poison the conversation history. The cap is visible
 * in each tool's description (appended automatically in tools/index.ts) so the
 * LLM knows it exists, and exposed on BuiltinToolDef.maxOutputBytes so any UI
 * can show the per-tool value.
 */

/** Default output cap for any tool not listed in TOOL_OUTPUT_LIMITS. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MiB — 2 MiB under OpenAI's 10 MiB

/**
 * Per-tool overrides. Anything not listed uses DEFAULT_MAX_OUTPUT_BYTES.
 * Keep this map authoritative — it is the single source of truth consulted by
 * every tool and surfaced in each tool's description.
 */
export const TOOL_OUTPUT_LIMITS: Record<string, number> = {
  // Shell output is streamed back in real time; 1 MiB is the sweet spot
  // between "useful for build/test logs" and "won't flood the UI or context".
  shell: 1 * 1024 * 1024,
};

/** Look up the output cap for a tool by name. */
export function getToolOutputLimit(name: string): number {
  return TOOL_OUTPUT_LIMITS[name] ?? DEFAULT_MAX_OUTPUT_BYTES;
}

/** Human-readable byte count (e.g. "8 MB", "1 MB", "512 KB", "128 B"). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    const kb = bytes / 1024;
    return Number.isInteger(kb) ? `${kb} KB` : `${kb.toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Shared truncation marker for tools that have the full output in memory and
 * can report precise numbers (e.g. readFile, grep via truncateText below).
 */
export function buildTruncationMarker(
  toolName: string,
  omittedBytes: number,
  totalBytes: number,
  capBytes: number,
): string {
  return `\n[output truncated: ${formatBytes(omittedBytes)} omitted of ${formatBytes(totalBytes)} total — ${toolName} cap is ${formatBytes(capBytes)}]`;
}

/**
 * Marker for streaming tools (shell) where draining the rest of the stream
 * to measure the true total would block on unbounded processes like `yes`.
 * The cap itself is the actionable number here.
 */
export function buildStreamTruncationMarker(toolName: string, capBytes: number): string {
  return `\n[output truncated: ${toolName} cap is ${formatBytes(capBytes)} (stream terminated at cap)]`;
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, appending a clear
 * truncation marker when content is dropped. The marker itself is allowed to
 * push the final result slightly past maxBytes — the goal is staying well
 * under OpenAI's 10 MiB hard limit, not exactly matching the cap byte-for-byte.
 */
export function truncateText(
  text: string,
  maxBytes: number,
  toolName: string,
): { text: string; truncated: boolean; originalBytes: number } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) {
    return { text, truncated: false, originalBytes: encoded.byteLength };
  }

  // Decode in non-fatal mode so a split multi-byte sequence at the cut point
  // becomes U+FFFD instead of throwing.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const head = decoder.decode(encoded.slice(0, maxBytes));
  const omitted = encoded.byteLength - maxBytes;
  const marker = buildTruncationMarker(toolName, omitted, encoded.byteLength, maxBytes);
  return { text: head + marker, truncated: true, originalBytes: encoded.byteLength };
}

/**
 * Describe a tool's cap in a form suitable for appending to its description.
 * Kept here so wording is consistent across every tool.
 */
export function describeOutputCap(toolName: string): string {
  const cap = getToolOutputLimit(toolName);
  return `Output is capped at ${formatBytes(cap)}; anything beyond the cap is truncated with an inline marker.`;
}

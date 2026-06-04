/**
 * Provider connection-error translation.
 *
 * When a chat run's resolved model points at an unreachable endpoint
 * (e.g. an Ollama / custom model configured as `http://localhost:11434`
 * that the server process can't actually reach), the underlying `fetch`
 * throws a raw runtime connection error. pi-agent-core catches LLM errors
 * internally and stores only the `.message` string; the executor rethrows
 * it as a plain `Error` (see `executor.ts` — `throw new Error(piAgent.state.error)`),
 * so by the time the error reaches the chat UI the original `.code`/`.name`
 * are gone and only the message TEXT survives.
 *
 * Bun's text for those failures ("Unable to connect. Is the computer able to
 * access the url?" / "Was there a typo in the url or port?") is cryptic and
 * un-actionable when it lands verbatim in a chat bubble. These helpers detect
 * the connection-failure class (primarily from the message text, since codes
 * are usually lost across the rethrow) and rewrite it into a clear message
 * that names the provider, model, and base URL.
 */

/** Substrings emitted by Bun/Node/undici for connection-class fetch failures. */
const CONNECTION_MESSAGE_PATTERNS: RegExp[] = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /ETIMEDOUT/i,
  /ConnectionRefused/i,
  /ConnectionClosed/i,
  /FailedToOpenSocket/i,
  /unable to connect/i,
  /able to access the url/i,
  /typo in the url or port/i, // Bun 1.3.x ConnectionRefused hint
  /failed to (?:open|connect)/i,
  /connection (?:refused|closed|reset|timed out)/i,
  /fetch failed/i,
  /network ?error/i,
  /socket connection was closed/i,
];

/** Error codes/names set directly on the thrown error (when not flattened). */
const CONNECTION_CODES = new Set([
  "ConnectionRefused",
  "ConnectionClosed",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "FailedToOpenSocket",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export interface ProviderTarget {
  provider?: string | null;
  model?: string | null;
  baseUrl?: string | null;
}

/**
 * True when `err` looks like a network/connection failure reaching a
 * provider endpoint (refused, host not found, socket closed, timed out).
 */
export function isProviderConnectionError(err: unknown): boolean {
  if (err == null) return false;

  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return true;

  const name = (err as { name?: unknown }).name;
  if (typeof name === "string" && CONNECTION_CODES.has(name)) return true;

  const message = err instanceof Error ? err.message : String(err);
  return CONNECTION_MESSAGE_PATTERNS.some((re) => re.test(message));
}

/**
 * Translate a connection-class error into a clear, actionable chat message.
 * Returns `null` when the error is NOT a connection failure, so callers can
 * fall back to the original message for unrelated errors.
 *
 * The returned string is the message BODY only — callers add any `Error: `
 * prefix themselves (matching the existing `finalize*` convention).
 */
export function friendlyProviderError(
  err: unknown,
  target: ProviderTarget = {},
): string | null {
  if (!isProviderConnectionError(err)) return null;

  const provider = target.provider?.trim();
  const model = target.model?.trim();
  const baseUrl = target.baseUrl?.trim();

  const who = provider ? `the ${provider} endpoint` : "the model provider";
  const where = baseUrl ? ` at ${baseUrl}` : "";
  const which = model ? ` for model "${model}"` : "";

  return (
    `Couldn't reach ${who}${where}${which}. ` +
    `The host couldn't be resolved or the connection was refused — ` +
    `check the server's network/DNS and outbound access, and that the ` +
    `base URL and port are correct.`
  );
}

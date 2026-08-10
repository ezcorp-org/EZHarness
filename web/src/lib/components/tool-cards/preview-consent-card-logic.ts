/**
 * Pure parsing for the requester-scoped expose-consent card
 * (`cardType: "ez-preview-consent"`) — Secure User-Site Preview / Port
 * Exposure, Phase 2 (§3.3 + D3).
 *
 * The port watcher's `preview:detected` event is surfaced into the
 * originating conversation as a tool-result-style card. Its payload (built
 * server-side by `buildConsentCardPayload`) reaches us on
 * `ToolCallState.output` — by the time it lands the store has unwrapped any
 * MCP envelope to joined text, so `output` is a JSON string here (or,
 * defensively, the raw object). We surface a usable `{conversationId,
 * port}` or return null so the router falls back to DefaultCard (matching
 * the propose-card degradation contract).
 *
 * Like ez-propose-card-logic, this is render-time pure: no fetch, no
 * Svelte runes — the card component owns the POST to /api/preview/consent.
 */

export interface PreviewConsentCardData {
  conversationId: string;
  port: number;
  title: string;
  summary: string;
}

/** Extract a plain object from a tool-result `output` that may be a JSON
 *  string, a raw object, or an MCP-style `{ content:[{text}] }` envelope.
 *  Mirrors `extractEzCardObject` semantics but kept local so the consent
 *  card has no dependency on the install/propose parsers. */
function extractObject(output: unknown): Record<string, unknown> | null {
  if (output == null) return null;
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    // Unwrap an MCP content envelope if present.
    const content = obj.content;
    if (Array.isArray(content)) {
      const text = content
        .map((c) =>
          c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
            ? (c as { text: string }).text
            : "",
        )
        .join("");
      if (text) return extractObject(text);
      return obj;
    }
    return obj;
  }
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function parseConsentCardResult(output: unknown): PreviewConsentCardData | null {
  const obj = extractObject(output);
  if (!obj) return null;
  const conversationId = typeof obj.conversationId === "string" ? obj.conversationId : "";
  const port = typeof obj.port === "number" ? obj.port : NaN;
  if (!conversationId || !Number.isInteger(port) || port <= 0) return null;
  const title =
    typeof obj.title === "string" && obj.title ? obj.title : `A site started on port ${port}`;
  const summary =
    typeof obj.summary === "string" && obj.summary
      ? obj.summary
      : "Expose it to your browser? Nothing is served until you choose.";
  return { conversationId, port, title, summary };
}

/** The consent actions the card posts to /api/preview/consent. */
export type ConsentAction = "expose" | "ignore" | "always-expose";

/** Build the request body for a consent action. Pure — unit-testable. */
export function buildConsentRequest(
  data: PreviewConsentCardData,
  action: ConsentAction,
): { conversationId: string; port: number; action: ConsentAction } {
  return { conversationId: data.conversationId, port: data.port, action };
}

/**
 * Compose the served preview URL from the API response's `subdomainLabel`.
 * The label is the opaque preview id; the host completes it into the
 * wildcard subdomain. `appHost` defaults to the current origin's host at
 * call time (the card passes window.location.host). Returns the
 * `/__open?c=<code>` handoff URL the browser opens to set the cookie.
 */
export function buildOpenUrl(
  subdomainLabel: string,
  code: string,
  appHost: string,
  protocol = "https:",
): string {
  // Reuse the app's host suffix: <label>.preview.<host-without-port>.
  // appHost may include a port (dev). Strip the app's own port and host
  // prefix down to the registrable suffix used for *.preview.<host>.
  const hostNoPort = appHost.split(":")[0] ?? appHost;
  return `${protocol}//${subdomainLabel}.preview.${hostNoPort}/__open?c=${encodeURIComponent(code)}`;
}

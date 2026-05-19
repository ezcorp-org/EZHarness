/** Shared response helpers for ai-kit MCP tool handlers.
 *
 *  Every tool that produces a user-facing entity (conversation, agent,
 *  run, sub-conversation) wraps its JSON payload with `withLink` so
 *  the LLM sees BOTH a machine-consumable `url` field AND a pre-formatted
 *  `markdownLink` string. A client that just echoes the tool result
 *  into chat therefore renders a clickable link without extra prompt
 *  engineering; a client that wants to build its own chip can read the
 *  raw `url`.
 */

export interface ToolTextResponse {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

/** Wrap a payload with `url` + `markdownLink` fields and render to MCP
 *  text-content shape. When `payload` is an object, fields merge in;
 *  when it's a primitive/array/null, it's preserved under `result`. */
export function withLink(
  payload: unknown,
  url: string,
  label: string,
): ToolTextResponse {
  const augmented =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>), url, markdownLink: `[${label}](${url})` }
      : { result: payload, url, markdownLink: `[${label}](${url})` };
  return { content: [{ type: "text" as const, text: JSON.stringify(augmented) }] };
}

/** Wrap a payload with multiple labelled URLs. Useful when one response
 *  relates to multiple entities (e.g. `start_assignment` returns both a
 *  sub-conversation and a run). The first entry is also promoted to
 *  `markdownLink` for one-click affordance. */
export function withLinks(
  payload: unknown,
  links: Array<{ url: string; label: string; field: string }>,
): ToolTextResponse {
  const base =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : ({ result: payload } as Record<string, unknown>);
  for (const l of links) base[l.field] = l.url;
  const primary = links[0];
  if (primary) base["markdownLink"] = `[${primary.label}](${primary.url})`;
  return { content: [{ type: "text" as const, text: JSON.stringify(base) }] };
}

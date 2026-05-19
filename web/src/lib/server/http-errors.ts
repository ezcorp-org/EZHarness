import { json } from "@sveltejs/kit";

/**
 * Shared HTTP error-response helpers for +server.ts route handlers.
 *
 * Before this module the repo used three different shapes:
 *   return json({ error: "..." }, { status: 4xx })
 *   return new Response(JSON.stringify({ error: "..." }), { status: 4xx, headers: { ... } })
 *   throw new Response("...", { status: 4xx })
 *
 * The audit (tasks/audit/02-dry-maintainability.md §1.1) flagged this as
 * the single largest duplication hotspot across ~100 handlers. `errorJson`
 * pins the shape; `validateRequired` pins the missing-param contract.
 *
 * Intentionally narrow: only covers the common error shape. Success
 * responses stay on `json()` directly — there's no benefit to a wrapper
 * for the happy path.
 */

type ExtraHeaders = Record<string, string>;

export function errorJson(
  status: number,
  message: string,
  details?: Record<string, unknown>,
  extraHeaders?: ExtraHeaders,
): Response {
  const body = details ? { error: message, ...details } : { error: message };
  if (extraHeaders) {
    return json(body, { status, headers: extraHeaders });
  }
  return json(body, { status });
}

/**
 * Guard for required scalar parameters on query strings, path params, or
 * JSON bodies. Returns the value narrowed to a non-empty string, or
 * throws a 400 Response so the handler's existing try/catch (or
 * SvelteKit's internal error boundary) surfaces it.
 *
 * Usage:
 *   const id = validateRequired(params.id, "id");
 *   const name = validateRequired(body.name, "name");
 */
function validateRequired(
  value: unknown,
  paramName: string,
  status: number = 400,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw errorJson(status, `${paramName} is required`);
  }
  return value;
}

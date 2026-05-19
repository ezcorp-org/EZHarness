/**
 * Reusable ETag and caching utilities for stable API endpoints.
 * Only use for reference data (agent lists, extension manifests, API docs).
 * Do NOT use for session data, chat messages, or user-specific data.
 */

export async function etagFor(data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return `"${Buffer.from(hash).toString("hex").slice(0, 16)}"`;
}

export async function cacheableResponse(
  request: Request,
  data: unknown,
  options?: { maxAge?: number; staleWhileRevalidate?: number }
): Promise<Response> {
  const etag = await etagFor(data);
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }
  const maxAge = options?.maxAge ?? 60;
  const swr = options?.staleWhileRevalidate ?? 300;
  return Response.json(data, {
    headers: {
      "ETag": etag,
      "Cache-Control": `private, max-age=${maxAge}, stale-while-revalidate=${swr}`
    }
  });
}

import { addToast } from "$lib/toast.svelte";

/**
 * Handle 429 rate limit responses by showing a toast with wait time.
 * Call this after any fetch that might be rate-limited.
 * Returns true if the response was a 429 (caller should stop processing).
 */
export function handleRateLimitResponse(res: Response): boolean {
  if (res.status !== 429) return false;

  const retryAfter = res.headers.get("Retry-After");
  const seconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
  const message = seconds && !isNaN(seconds)
    ? `Rate limit exceeded. Try again in ${seconds} seconds.`
    : "Rate limit exceeded. Please wait before trying again.";

  addToast({ type: "warning", message }, (seconds ?? 10) * 1000);
  return true;
}

/**
 * Fetch wrapper that automatically handles 429 responses with toast.
 * Use as a drop-in replacement for fetch in API calls.
 */
export async function secureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  handleRateLimitResponse(res);
  return res;
}

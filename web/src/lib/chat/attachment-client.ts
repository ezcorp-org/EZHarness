/**
 * Client-side mirror of src/providers/model-capabilities.ts.
 *
 * Fetches `/api/models/capabilities?provider=X&model=Y` and caches the result
 * per (provider, model) pair for the lifetime of the page. The server owns
 * the capability table; the client just reflects it to drive the file picker's
 * accepted MIME list and the pre-upload gating UX.
 */

export type AttachmentKind = "image" | "text" | "pdf" | "audio" | "extension-handle";

export interface ClientCapabilities {
  provider: string;
  model: string;
  kinds: AttachmentKind[];
  acceptedMimeTypes: string[];
  maxBytesPerFile: number;
  maxFilesPerMessage: number;
}

const cache = new Map<string, Promise<ClientCapabilities>>();

function cacheKey(provider: string, model: string) {
  return `${provider}::${model}`;
}

export async function getClientCapabilities(
  provider: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
  conversationId?: string,
  /**
   * Names of extensions the user has *drafted* via `!ext:NAME` mentions
   * in the composer but not yet sent. Picker uses these to accept files
   * for not-yet-wired extensions — so dragging an .xlsx into a fresh
   * chat that mentions `!ext:excel` works on the first message.
   * Order-insensitive — sorted into the cache key for stability.
   */
  pendingExtensionNames?: readonly string[],
): Promise<ClientCapabilities> {
  const sortedExt = pendingExtensionNames && pendingExtensionNames.length > 0
    ? [...new Set(pendingExtensionNames)].sort().join(",")
    : "";
  // Cache key includes conversationId AND the pending-extensions set so
  // the picker re-fetches whenever the user types or removes an `!ext:`
  // mention.
  const key = `${cacheKey(provider, model)}::${conversationId ?? ""}::${sortedExt}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const qs = new URLSearchParams({ provider, model });
    if (conversationId) qs.set("conversationId", conversationId);
    if (sortedExt) qs.set("extensions", sortedExt);
    const res = await fetchImpl(`/api/models/capabilities?${qs}`);
    if (!res.ok) throw new Error(`Capability fetch failed: ${res.status}`);
    return (await res.json()) as ClientCapabilities;
  })();
  cache.set(key, p);
  // On failure, evict so the next call retries.
  p.catch(() => cache.delete(key));
  return p;
}

export function __resetCapabilityCacheForTests() {
  cache.clear();
}

/**
 * True if the capability entry accepts the file's MIME type (after stripping
 * a `;charset=…` suffix that some browsers emit on text files).
 */
export function capabilityAcceptsFile(caps: ClientCapabilities, file: File): boolean {
  const mime = (file.type || "application/octet-stream").split(";")[0]!.trim();
  return caps.acceptedMimeTypes.includes(mime);
}

export function describeRejection(caps: ClientCapabilities, file: File): string {
  const mime = (file.type || "application/octet-stream").split(";")[0]!.trim();
  if (file.size > caps.maxBytesPerFile) {
    const mb = Math.round(caps.maxBytesPerFile / (1024 * 1024));
    return `"${file.name}" exceeds the ${mb}MB per-file limit.`;
  }
  if (!caps.acceptedMimeTypes.includes(mime)) {
    return `The selected model (${caps.model}) doesn't accept ${mime || "this file type"}.`;
  }
  return `"${file.name}" was rejected.`;
}

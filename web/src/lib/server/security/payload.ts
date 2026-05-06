const PAYLOAD_LIMITS: Record<string, number> = {
  "/api/knowledge-base": 50 * 1024 * 1024, // 50MB
  // Multi-modal chat attachments: up to N files per message with per-file caps
  // enforced by the model-capability validator downstream. This outer limit
  // just needs to be generous enough to accommodate a full batch.
  "/api/conversations": 100 * 1024 * 1024, // 100MB
  // Extension uploads (e.g. kokoro-tts WAV blobs). The route at
  // `/api/extensions/[name]/uploads` enforces its own 25 MB MIME-aware
  // cap; this outer limit is set just above that so the route's own
  // 413 (with the structured `TOO_LARGE` code) is what callers see,
  // instead of the generic hook-level 413.
  "/api/extensions": 25 * 1024 * 1024, // 25MB
};

const DEFAULT_MAX = 1024 * 1024; // 1MB

export function getMaxPayload(pathname: string): number {
  for (const [prefix, limit] of Object.entries(PAYLOAD_LIMITS)) {
    if (pathname.startsWith(prefix)) return limit;
  }
  return DEFAULT_MAX;
}

export function payloadTooLarge(maxBytes?: number): Response {
  return Response.json(
    {
      error: "Payload too large",
      maxBytes: maxBytes ?? DEFAULT_MAX,
    },
    { status: 413 },
  );
}

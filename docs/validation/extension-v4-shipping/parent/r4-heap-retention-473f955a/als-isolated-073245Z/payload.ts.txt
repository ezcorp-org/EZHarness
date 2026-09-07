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
  if (pathname === "/api/extensions/control") return 128 * 1024 * 1024;
  for (const [prefix, limit] of Object.entries(PAYLOAD_LIMITS)) {
    if (pathname.startsWith(prefix)) return limit;
  }
  return DEFAULT_MAX;
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const advertised = request.headers.get("content-length");
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) throw payloadTooLarge(maxBytes);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw payloadTooLarge(maxBytes); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function admitRequestPayload(request: Request, pathname: string): Promise<Request> {
  if (!request.body) return request;
  const bytes = await readBoundedBody(request, getMaxPayload(pathname));
  const headers = new Headers(request.headers);
  headers.set("content-length", String(bytes.length));
  return new Request(request, { headers, body: new Uint8Array(bytes).buffer });
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

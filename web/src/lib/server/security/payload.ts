const PAYLOAD_LIMITS: Record<string, number> = {
  "/api/knowledge-base": 50 * 1024 * 1024, // 50MB
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

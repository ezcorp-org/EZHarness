// One HTTP relay: up to 13 output pages plus start/inspect at observed 3.1s
// per RPC, with the unchanged guest HTTP 8s limit. Reserve 5s for settlement.
export const PREVIEW_HTTP_RESPONSE_MS = 60_000;
export const HTTP_SETTLEMENT_MS = 5_000;

/** The pinned Bun adapter otherwise closes an idle response after 10 seconds. */
export function configurePreviewHttpResponse(platform?: {
  server?: { timeout?(request: Request, seconds: number): void }; request?: unknown;
}): void {
  if (platform?.request instanceof Request) {
    platform.server?.timeout?.(platform.request, PREVIEW_HTTP_RESPONSE_MS / 1_000);
  }
}

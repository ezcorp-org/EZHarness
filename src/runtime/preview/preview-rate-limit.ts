/**
 * preview-rate-limit.ts — per-preview request-rate + byte-budget quotas for
 * the dynamic passthrough (Secure User-Site Preview / Port Exposure, Phase
 * 3b — mirrors the MCP-proxy quota pattern, see src/extensions/mcp-proxy.ts +
 * rate-limit.ts).
 *
 * An untrusted dev server reached through the proxy must not be able to (a)
 * hammer the host with unbounded requests, or (b) stream unbounded bytes back
 * to the browser through us. We cap BOTH per preview id:
 *   - a request token-bucket (`maxRequestsPerSecond`), and
 *   - a rolling byte budget (`maxBytesPerWindow` over `windowMs`).
 *
 * Over-limit is REJECTED + LOGGED (no silent truncation — project policy).
 * The accounting is per-preview-id so one preview can never starve another's
 * budget (isolation), reusing the same token-bucket primitive as the MCP
 * proxy (DRY).
 *
 * Pure + injectable clock so the under/over-cap + per-preview-isolation +
 * window-rollover behavior is 100% unit-tested without real time.
 */

import { createRateLimiter } from "../../extensions/rate-limit";
import { logger } from "../../logger";

const log = logger.child("preview.rate-limit");

/** Default: 50 requests/sec per preview — generous for HMR + asset bursts,
 *  far below an abuse flood. */
export const DEFAULT_MAX_REQ_PER_SEC = 50;
/** Default rolling byte budget: 512 MB per 60s window per preview. Covers a
 *  large SPA + HMR churn; an unbounded exfil/stream trips it. */
export const DEFAULT_MAX_BYTES_PER_WINDOW = 512 * 1024 * 1024;
export const DEFAULT_WINDOW_MS = 60_000;

export interface PreviewQuotaConfig {
  maxRequestsPerSecond?: number;
  maxBytesPerWindow?: number;
  windowMs?: number;
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface PreviewQuota {
  /** Charge ONE request against the preview's rate bucket. Returns false
   *  (logged) when over the per-second cap. */
  allowRequest(previewId: string): boolean;
  /** Charge `bytes` against the preview's rolling byte budget. Returns false
   *  (logged) when the window budget is exhausted. */
  allowBytes(previewId: string, bytes: number): boolean;
  /** Drop a preview's accounting (called on reap so a freed id doesn't leak
   *  memory). Idempotent. */
  forget(previewId: string): void;
}

interface ByteWindow {
  windowStart: number;
  bytesUsed: number;
}

/**
 * Create an isolated per-preview quota. Each preview id gets its own request
 * token-bucket + byte window; ids never share budget.
 */
export function createPreviewQuota(config: PreviewQuotaConfig = {}): PreviewQuota {
  const maxReq = config.maxRequestsPerSecond ?? DEFAULT_MAX_REQ_PER_SEC;
  const maxBytes = config.maxBytesPerWindow ?? DEFAULT_MAX_BYTES_PER_WINDOW;
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
  const now = config.now ?? Date.now;

  // Reuse the MCP token-bucket primitive for the request rate.
  const requestLimiter = createRateLimiter(maxReq);
  const byteWindows = new Map<string, ByteWindow>();

  return {
    allowRequest(previewId: string): boolean {
      if (!previewId) return false;
      const ok = requestLimiter(previewId, 1);
      if (!ok) {
        log.warn("preview request rate limit exceeded — rejecting", {
          previewId,
          maxRequestsPerSecond: maxReq,
        });
      }
      return ok;
    },

    allowBytes(previewId: string, bytes: number): boolean {
      if (!previewId) return false;
      if (!Number.isFinite(bytes) || bytes < 0) return false;
      const t = now();
      let w = byteWindows.get(previewId);
      if (!w || t - w.windowStart >= windowMs) {
        // Fresh / rolled-over window.
        w = { windowStart: t, bytesUsed: 0 };
        byteWindows.set(previewId, w);
      }
      if (w.bytesUsed + bytes > maxBytes) {
        log.warn("preview byte budget exhausted — rejecting", {
          previewId,
          maxBytesPerWindow: maxBytes,
          windowMs,
          bytesUsed: w.bytesUsed,
          requested: bytes,
        });
        return false;
      }
      w.bytesUsed += bytes;
      return true;
    },

    forget(previewId: string): void {
      // Drop BOTH the byte window AND the request token-bucket so a reaped
      // preview leaves no accounting behind in either map (no per-id leak).
      byteWindows.delete(previewId);
      requestLimiter.forget(previewId);
    },
  };
}

/**
 * Process-wide default quota singleton — the dynamic proxy charges every
 * request/response against it. A singleton (not per-request) is what makes
 * the budget rolling + cross-request. Tests use `createPreviewQuota` directly
 * with an injected clock.
 */
let singleton: PreviewQuota | null = null;
export function getPreviewQuota(): PreviewQuota {
  if (!singleton) singleton = createPreviewQuota();
  return singleton;
}

/** Test-only: reset the singleton. */
export function _resetPreviewQuotaForTests(): void {
  singleton = null;
}

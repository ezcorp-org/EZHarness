/**
 * Capability detection for secure previews (Secure User-Site Preview /
 * Port Exposure — see docs/features/tools/preview-port-exposure.md).
 *
 * D2 (LOCKED): a host that cannot isolate a dynamic preview FAILS CLOSED
 * for dynamic previews (static still works), with a clear reason.
 * `previewCapabilities()` is the boot/runtime probe that encodes this.
 *
 * A per-conversation network-namespace tier was planned but never built
 * (no veth pairs, no netns port reader). It was removed: selecting it
 * refused every dev-server launch on hosts that passed its probes.
 */

import { isPreviewSpawnHelperPresent } from "./preview-spawn";

/**
 * The isolation MODE the host can offer for dynamic previews:
 *
 *   - `uid`    — per-conversation preview uid + the setuid-root spawn
 *                helper + .ezcorp/data chmod 0700. fs-isolation + uid
 *                attribution of the dev server's LISTEN socket.
 *   - `static` — fail-closed. No dynamic previews; static still serves.
 */
export type PreviewMode = "uid" | "static";

export interface PreviewCapabilities {
  /** Static previews work on EVERY host — always true. */
  static: boolean;
  /** Dynamic previews available (uid mode). When false, mode is `static`. */
  dynamic: boolean;
  mode: PreviewMode;
  /** Why dynamic previews are unavailable (null in uid mode). Surfaced to
   *  the user + logged (no silent degradation per policy). */
  reason: string | null;
}

let capabilitiesCache: PreviewCapabilities | null = null;

/** Detect preview capabilities once; cached for the process lifetime. */
export function previewCapabilities(): PreviewCapabilities {
  if (capabilitiesCache !== null) return capabilitiesCache;
  capabilitiesCache = computePreviewCapabilities();
  return capabilitiesCache;
}

/** uid mode when the setuid spawn helper works, else static. The helper
 *  check is injectable for tests. */
export function computePreviewCapabilities(
  deps: { helperPresent?: () => boolean } = {},
): PreviewCapabilities {
  const helperPresent = deps.helperPresent ?? (() => isPreviewSpawnHelperPresent());
  if (helperPresent()) {
    return { static: true, dynamic: true, mode: "uid", reason: null };
  }
  return {
    static: true,
    dynamic: false,
    mode: "static",
    reason: "dynamic previews disabled: setuid spawn helper not present/functional",
  };
}

/** Test-only: drop the cached capabilities so a test can re-probe. */
export function _resetPreviewCapabilitiesForTests(): void {
  capabilitiesCache = null;
}

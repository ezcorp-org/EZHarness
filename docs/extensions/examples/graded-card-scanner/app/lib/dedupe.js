// @ts-check
// Per-frame scan dedupe — a slab held in frame decodes many times a
// second. The gate turns that stream into "one physical card → one
// capture": a per-cert recently-seen cooldown plus an in-flight guard
// for certs whose lookup is still running.
//
// The cooldown window REFRESHES on every sighting, so a card sitting in
// frame is captured exactly once no matter how long it's held; it only
// becomes scannable again after ~8s out of frame.

/**
 * @param {{cooldownMs?: number, now?: () => number}} [opts]
 * @returns {{
 *   tryAcquire: (cert: string) => "new" | "cooldown" | "in-flight",
 *   settle: (cert: string) => void,
 *   reset: () => void,
 * }}
 */
export function createScanGate(opts = {}) {
  const cooldownMs = opts.cooldownMs ?? 8000;
  const now = opts.now ?? Date.now;

  /** @type {Map<string, number>} cert → last-seen timestamp */
  const lastSeen = new Map();
  /** @type {Set<string>} certs with a lookup currently running */
  const inFlight = new Set();

  return {
    /**
     * Ask whether this sighting should trigger a capture.
     * "new" also marks the cert in-flight — call `settle` when its
     * lookup finishes (success or failure).
     */
    tryAcquire(cert) {
      const t = now();
      if (inFlight.has(cert)) {
        lastSeen.set(cert, t);
        return "in-flight";
      }
      const seen = lastSeen.get(cert);
      lastSeen.set(cert, t);
      if (seen !== undefined && t - seen < cooldownMs) return "cooldown";
      inFlight.add(cert);
      return "new";
    },

    /** Mark the cert's lookup finished so a future sighting can re-fire. */
    settle(cert) {
      inFlight.delete(cert);
    },

    /** Forget everything (used when the user clears all data). */
    reset() {
      lastSeen.clear();
      inFlight.clear();
    },
  };
}

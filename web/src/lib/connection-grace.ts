export const CONNECTION_GRACE_MS = 5000;

export type RawConnState = "connected" | "disconnected" | "reconnecting" | "failed";

/**
 * Visible connection state given the raw transport state and how long the
 * connection has been continuously in a problem state. Blips shorter than
 * graceMs report "connected" so no banner / disabled input flashes for
 * transient network hiccups. "failed" bypasses the grace — it is only
 * reachable after the full reconnect backoff (far longer than the grace
 * window) and is terminal.
 */
export function gatedConnectionState(
	raw: RawConnState,
	msSinceProblemStart: number,
	graceMs = CONNECTION_GRACE_MS,
): RawConnState {
	if (raw === "connected") return "connected";
	if (raw === "failed") return "failed";
	return msSinceProblemStart >= graceMs ? raw : "connected";
}

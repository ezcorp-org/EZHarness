/**
 * Convert a timestamp (ISO string or ms number) to a human-readable relative string.
 * Examples: "in 2h", "30 min ago", "in < 1 min", "3d ago"
 */
export function relativeTime(isoOrMs: string | number): string {
	const ms = typeof isoOrMs === "string" ? new Date(isoOrMs).getTime() : isoOrMs;
	const diff = ms - Date.now();
	const absDiff = Math.abs(diff);
	const future = diff > 0;

	if (absDiff < 60_000) {
		return future ? "in < 1 min" : "< 1 min ago";
	}

	if (absDiff < 3600_000) {
		const mins = Math.round(absDiff / 60_000);
		return future ? `in ${mins} min` : `${mins} min ago`;
	}

	if (absDiff < 86400_000) {
		const hours = Math.round(absDiff / 3600_000);
		return future ? `in ${hours}h` : `${hours}h ago`;
	}

	const days = Math.round(absDiff / 86400_000);
	return future ? `in ${days}d` : `${days}d ago`;
}

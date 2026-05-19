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

/**
 * Format a duration in milliseconds as a human-readable string with no
 * directional suffix. Used by the capability-expiry re-approve modal /
 * banner copy ("expired 30 days ago", "Approve 90 days").
 *
 * Picks the largest unit that yields a value >= 1: days for >= 1d,
 * hours for >= 1h, minutes for >= 1 min, "< 1 min" otherwise. Plurals
 * are pluralized only when the integer is != 1, so "1 day" reads
 * naturally next to "30 days".
 *
 * Negative or non-finite inputs collapse to "< 1 min" — callers
 * (modal copy, banner rows) should not pass those, but we don't want
 * a typo in metadata to brick the UI.
 */
export function humanizeDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 60_000) return "< 1 min";
	if (ms < 3600_000) {
		const mins = Math.round(ms / 60_000);
		return `${mins} min${mins === 1 ? "" : "s"}`;
	}
	if (ms < 86400_000) {
		const hours = Math.round(ms / 3600_000);
		return `${hours} hour${hours === 1 ? "" : "s"}`;
	}
	const days = Math.round(ms / 86400_000);
	return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Phase 56 (per-capability TTL UI): locale-aware relative-time formatter.
 *
 * Modes:
 *   • "past":     "30 days ago" / "yesterday" (Intl.RelativeTimeFormat negative)
 *   • "future":   "in 30 days" / "tomorrow"   (Intl.RelativeTimeFormat positive)
 *   • "absolute": "30 days"                    (delegates to humanizeDuration so
 *                                                 the modal button label's
 *                                                 verbatim-copy contract is
 *                                                 preserved — parallel-formatter
 *                                                 approach per RESEARCH Open
 *                                                 Question 3).
 *
 * `ms === null` is the "Never" branch — returns the literal "Never" regardless
 * of direction. Used by sticky / picker code paths after a user picks Never.
 *
 * Locale is hardcoded to "en" — matches `humanizeDuration`'s English unit
 * names. If the project adds i18n later, change here and audit the verbatim-
 * copy contract module (`expiry-copy.ts`).
 *
 * Defense (Pitfall 5 — SSR/jsdom locale fallback): sub-minute inputs (incl.
 * NaN, negatives, Infinity) collapse to a `< 1 min` sentinel — corrupt audit
 * rows must never brick the banner.
 */
const RTF_EN = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatTtl(
	ms: number | null,
	direction: "past" | "future" | "absolute",
): string {
	if (ms === null) return "Never";
	if (!Number.isFinite(ms) || ms < 60_000) {
		if (direction === "past") return "less than a minute ago";
		if (direction === "future") return "in less than a minute";
		return "< 1 min";
	}
	if (direction === "absolute") {
		// Preserves "30 days" verbatim for the modal "Approve N days" label.
		return humanizeDuration(ms);
	}
	// Pick the best unit using the same ladder humanizeDuration uses.
	let value: number;
	let unit: Intl.RelativeTimeFormatUnit;
	if (ms < 3_600_000) {
		value = Math.round(ms / 60_000);
		unit = "minute";
	} else if (ms < 86_400_000) {
		value = Math.round(ms / 3_600_000);
		unit = "hour";
	} else {
		value = Math.round(ms / 86_400_000);
		unit = "day";
	}
	return RTF_EN.format(direction === "past" ? -value : value, unit);
}

/** Plain-language formatting for the run inspector. Pure, so it is tested directly. */
import type { FactoryRunStreamStatus, FactoryStreamState } from "./run-stream";

/** Plain words for every stream state; none of them claims a status it has not seen. */
export const FACTORY_STREAM_LABELS: Readonly<Record<FactoryStreamState, string>> = {
	connecting: "Connecting",
	live: "Live",
	lagging: "Live · status catching up",
	"catching-up": "Catching up missed events",
	reconnecting: "Reconnecting",
	offline: "Offline · status may be stale",
	ended: "Finished",
	revoked: "Access ended",
};

export function streamSummary(status: FactoryRunStreamStatus): string {
	const parts = [`sequence ${status.applied}`];
	if (status.lag > 0) parts.push(`${status.lag} event${status.lag === 1 ? "" : "s"} not yet in status`);
	if (status.duplicates > 0) parts.push(`${status.duplicates} duplicate${status.duplicates === 1 ? "" : "s"} ignored`);
	if (status.gaps > 0) parts.push(`${status.gaps} gap${status.gaps === 1 ? "" : "s"} recovered`);
	if (status.reconnects > 0) parts.push(`${status.reconnects} reconnect${status.reconnects === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

export function formatMicros(value: string): string {
	const micros = BigInt(value);
	const whole = micros / 1_000_000n;
	const fraction = (micros % 1_000_000n).toString().padStart(6, "0").slice(0, 4);
	return `${whole.toLocaleString("en-US")}.${fraction}`;
}

export function shortDigest(value: string): string {
	const hex = value.startsWith("sha256:") ? value.slice(7) : value;
	return hex.slice(0, 12);
}

/** Appends a page, keeping the first copy of any item that moved between pages while they were read. */
export function appendUnique<T>(current: readonly T[], next: readonly T[], key: (item: T) => string): readonly T[] {
	const seen = new Set(current.map(key));
	return [...current, ...next.filter(item => !seen.has(key(item)))];
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * How far a horizontal strip must scroll so one of its items is fully in view:
 * negative scrolls left, positive right, 0 when it already shows. An item wider
 * than the strip is aligned by its left edge.
 */
export function horizontalRevealOffset(strip: { readonly left: number; readonly right: number }, item: { readonly left: number; readonly right: number }): number {
	if (item.left < strip.left) return item.left - strip.left;
	if (item.right > strip.right) return Math.min(item.right - strip.right, item.left - strip.left);
	return 0;
}

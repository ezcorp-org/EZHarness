/** Plain-language formatting for the run inspector. Pure, so it is tested directly. */
import type { FactoryRunReleaseCostResource, FactoryRunReleaseResource, FactoryRunReleaseStopEffect } from "@ezcorp/factory-sdk/types";
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

/** What a stopped release did at its provider, in plain words: a stopped run never hides a publish. */
export const FACTORY_RELEASE_STOP_LABELS: Readonly<Record<FactoryRunReleaseStopEffect, string>> = {
	no_effect: "Stopped before publish · nothing was published",
	uncertain: "Stopped during publish · effect uncertain",
	published: "Stopped after publish · the release was published",
	unknown_at_deadline: "Stopped during publish · no answer by the deadline, effect unknown",
};

/** An instant in UTC to the minute, the same for every viewer. */
export function formatInstant(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The stop line of a release in two parts, the effect and the deadline, so a narrow view never breaks inside
 * the date; undefined when its run was not stopped during it.
 */
export function releaseStopSummary(release: Pick<FactoryRunReleaseResource, "stop" | "deadlineMs">): { readonly effect: string; readonly deadline: string } | undefined {
	if (!release.stop) return undefined;
	return { effect: FACTORY_RELEASE_STOP_LABELS[release.stop.effect], deadline: formatInstant(release.deadlineMs) };
}

/**
 * What a stopped release's cost line says beside its figure: a held bound names its hold; a settled figure
 * names its source and basis, so the reader sees how it was decided.
 */
export function releaseCostNote(line: FactoryRunReleaseCostResource): string {
	return line.state === "held" ? `held at its bound · ${line.hold}` : `${line.source} · ${line.basis}`;
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

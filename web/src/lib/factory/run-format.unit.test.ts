import { describe, expect, test } from "vitest";
import { FACTORY_RELEASE_STOP_LABELS, FACTORY_STREAM_LABELS, appendUnique, formatBytes, formatInstant, formatMicros, horizontalRevealOffset, releaseStopSummary, shortDigest, streamSummary } from "./run-format";
import type { FactoryRunStreamStatus } from "./run-stream";

const status = (overrides: Partial<FactoryRunStreamStatus> = {}): FactoryRunStreamStatus => ({ state: "live", applied: 7, lag: 0, duplicates: 0, gaps: 0, reconnects: 0, ...overrides }) as FactoryRunStreamStatus;

describe("run formatting", () => {
	test("a stopped release names its effect and its deadline; a release its run did not stop has no stop line", () => {
		expect(Object.keys(FACTORY_RELEASE_STOP_LABELS).sort()).toEqual(["no_effect", "published", "uncertain", "unknown_at_deadline"]);
		expect(new Set(Object.values(FACTORY_RELEASE_STOP_LABELS)).size).toBe(4);
		expect(formatInstant(1_900_000_000_000)).toBe("2030-03-17 17:46 UTC");
		expect(releaseStopSummary({ deadlineMs: 1_900_000_000_000, stop: { requestedAtMs: 1, effect: "unknown_at_deadline" } })).toEqual({ effect: "Stopped during publish · no answer by the deadline, effect unknown", deadline: "2030-03-17 17:46 UTC" });
		expect(releaseStopSummary({ deadlineMs: 1_900_000_000_000 })).toBeUndefined();
	});

	test("every stream state has its own plain label", () => {
		expect(FACTORY_STREAM_LABELS).toEqual({
			connecting: "Connecting",
			live: "Live",
			lagging: "Live · status catching up",
			"catching-up": "Catching up missed events",
			reconnecting: "Reconnecting",
			offline: "Offline · status may be stale",
			ended: "Finished",
			revoked: "Access ended",
		});
	});

	test("a stream summary names only the counts that happened, singular or plural", () => {
		expect(streamSummary(status())).toBe("sequence 7");
		expect(streamSummary(status({ lag: 1, duplicates: 1, gaps: 1, reconnects: 1 }))).toBe("sequence 7 · 1 event not yet in status · 1 duplicate ignored · 1 gap recovered · 1 reconnect");
		expect(streamSummary(status({ applied: 0, lag: 2, duplicates: 3, gaps: 4, reconnects: 5 }))).toBe("sequence 0 · 2 events not yet in status · 3 duplicates ignored · 4 gaps recovered · 5 reconnects");
	});

	test("micros read as whole units with four decimals, grouped, never rounded up", () => {
		expect(formatMicros("0")).toBe("0.0000");
		expect(formatMicros("1")).toBe("0.0000");
		expect(formatMicros("999999")).toBe("0.9999");
		expect(formatMicros("1000000")).toBe("1.0000");
		expect(formatMicros("1234567890123")).toBe("1,234,567.8901");
		expect(formatMicros("50000")).toBe("0.0500");
	});

	test("a digest shows its first twelve hex digits, with or without its prefix", () => {
		expect(shortDigest(`sha256:${"0123456789abcdef".repeat(4)}`)).toBe("0123456789ab");
		expect(shortDigest("fedcba9876543210")).toBe("fedcba987654");
		expect(shortDigest("sha256")).toBe("sha256");
		expect(shortDigest("abc")).toBe("abc");
	});

	test("a page appends only items not already listed, keeping the first copy and the order", () => {
		const key = (item: { id: string }) => item.id;
		const first = { id: "a", v: 1 };
		expect(appendUnique([first, { id: "b", v: 1 }], [{ id: "a", v: 2 }, { id: "c", v: 1 }, { id: "c", v: 2 }], key)).toEqual([first, { id: "b", v: 1 }, { id: "c", v: 1 }, { id: "c", v: 2 }]);
		expect(appendUnique([], [{ id: "x" }], key)).toEqual([{ id: "x" }]);
		expect(appendUnique([{ id: "x" }], [], key)).toEqual([{ id: "x" }]);
	});

	test("sizes read in bytes, KiB, or MiB at the exact boundaries", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1023)).toBe("1023 B");
		expect(formatBytes(1024)).toBe("1.0 KiB");
		expect(formatBytes(1536)).toBe("1.5 KiB");
		expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KiB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
		expect(formatBytes(5 * 1024 * 1024 + 512 * 1024)).toBe("5.5 MiB");
	});

	test("a strip scrolls just enough to show an item, and not at all when it shows", () => {
		const strip = { left: 100, right: 400 };
		expect(horizontalRevealOffset(strip, { left: 150, right: 350 })).toBe(0);
		expect(horizontalRevealOffset(strip, { left: 100, right: 400 })).toBe(0);
		expect(horizontalRevealOffset(strip, { left: 40, right: 240 })).toBe(-60);
		expect(horizontalRevealOffset(strip, { left: 350, right: 550 })).toBe(150);
		// Wider than the strip: its left edge comes into view first.
		expect(horizontalRevealOffset(strip, { left: 450, right: 900 })).toBe(350);
	});
});

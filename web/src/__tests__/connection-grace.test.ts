import { test, expect, describe } from "bun:test";
import {
	gatedConnectionState,
	CONNECTION_GRACE_MS,
	type RawConnState,
} from "../lib/connection-grace.js";

describe("gatedConnectionState", () => {
	test("connected is always connected, regardless of elapsed", () => {
		expect(gatedConnectionState("connected", 0)).toBe("connected");
		expect(gatedConnectionState("connected", 999_999)).toBe("connected");
	});

	test("failed bypasses the grace window (visible immediately)", () => {
		expect(gatedConnectionState("failed", 0)).toBe("failed");
		expect(gatedConnectionState("failed", CONNECTION_GRACE_MS - 1)).toBe("failed");
	});

	test("reconnecting is hidden (reported connected) below the grace window", () => {
		expect(gatedConnectionState("reconnecting", 0)).toBe("connected");
		expect(gatedConnectionState("reconnecting", CONNECTION_GRACE_MS - 1)).toBe("connected");
	});

	test("disconnected is hidden (reported connected) below the grace window", () => {
		expect(gatedConnectionState("disconnected", 0)).toBe("connected");
		expect(gatedConnectionState("disconnected", 1000)).toBe("connected");
	});

	test("reconnecting surfaces exactly at the grace boundary", () => {
		expect(gatedConnectionState("reconnecting", CONNECTION_GRACE_MS)).toBe("reconnecting");
	});

	test("disconnected surfaces at/after the grace window", () => {
		expect(gatedConnectionState("disconnected", CONNECTION_GRACE_MS)).toBe("disconnected");
		expect(gatedConnectionState("disconnected", CONNECTION_GRACE_MS + 10_000)).toBe("disconnected");
	});

	test("respects a custom graceMs override", () => {
		expect(gatedConnectionState("reconnecting", 999, 1000)).toBe("connected");
		expect(gatedConnectionState("reconnecting", 1000, 1000)).toBe("reconnecting");
	});

	test("CONNECTION_GRACE_MS default is 5 seconds", () => {
		expect(CONNECTION_GRACE_MS).toBe(5000);
	});

	test("every non-connected raw state stays hidden until the boundary", () => {
		const problems: RawConnState[] = ["disconnected", "reconnecting"];
		for (const raw of problems) {
			expect(gatedConnectionState(raw, CONNECTION_GRACE_MS - 1)).toBe("connected");
			expect(gatedConnectionState(raw, CONNECTION_GRACE_MS)).toBe(raw);
		}
	});
});

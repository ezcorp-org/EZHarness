import { test, expect, describe } from "bun:test";
import { isBannerVisible, bannerColorClass, type ConnectionState } from "../lib/connection-banner-logic.js";

// ── isBannerVisible ──────────────────────────────────────────────────

describe("isBannerVisible", () => {
	test("hidden when connected and showConnected is false", () => {
		expect(isBannerVisible("connected", false)).toBe(false);
	});

	test("visible when connected but showConnected is true (just reconnected)", () => {
		expect(isBannerVisible("connected", true)).toBe(true);
	});

	test("visible when disconnected", () => {
		expect(isBannerVisible("disconnected", false)).toBe(true);
	});

	test("visible when reconnecting", () => {
		expect(isBannerVisible("reconnecting", false)).toBe(true);
	});

	test("visible when failed", () => {
		expect(isBannerVisible("failed", false)).toBe(true);
	});

	test("visible when failed even if showConnected is true", () => {
		expect(isBannerVisible("failed", true)).toBe(true);
	});

	test("visible when disconnected even if showConnected is true", () => {
		expect(isBannerVisible("disconnected", true)).toBe(true);
	});
});

// ── bannerColorClass ─────────────────────────────────────────────────

describe("bannerColorClass", () => {
	test("green class when connected and showConnected is true", () => {
		expect(bannerColorClass("connected", true)).toBe("bg-green-600/90 text-white");
	});

	test("red class when state is failed", () => {
		expect(bannerColorClass("failed", false)).toBe("bg-red-600/90 text-white");
	});

	test("amber class when disconnected", () => {
		expect(bannerColorClass("disconnected", false)).toBe("bg-amber-500/90 text-white");
	});

	test("amber class when reconnecting", () => {
		expect(bannerColorClass("reconnecting", false)).toBe("bg-amber-500/90 text-white");
	});

	test("red class when failed even with showConnected true", () => {
		// failed takes precedence over showConnected in bannerColorClass
		// showConnected && state === "connected" is false when state === "failed"
		expect(bannerColorClass("failed", true)).toBe("bg-red-600/90 text-white");
	});

	test("amber class when disconnected even with showConnected true", () => {
		// showConnected && state === "connected" only matches "connected"
		expect(bannerColorClass("disconnected", true)).toBe("bg-amber-500/90 text-white");
	});
});

// ── connection state transitions (derived logic from the component) ───

describe("connection state transition visibility", () => {
	/**
	 * Simulates the wasDisconnected tracking logic from the component:
	 * The "Connected" flash only shows if the connection was previously lost.
	 */
	function simulateTransitions(
		states: ConnectionState[],
	): { showConnected: boolean; wasDisconnected: boolean } {
		let wasDisconnected = false;
		let showConnected = false;

		for (const state of states) {
			if (state !== "connected") {
				wasDisconnected = true;
				showConnected = false;
			} else if (wasDisconnected) {
				// Would trigger the 2500ms timer in component; we just track the flag
				showConnected = true;
			}
		}

		return { showConnected, wasDisconnected };
	}

	test("no flash if always connected from start", () => {
		const { showConnected } = simulateTransitions(["connected", "connected"]);
		expect(showConnected).toBe(false);
	});

	test("flash shown after reconnect following disconnection", () => {
		const { showConnected } = simulateTransitions([
			"connected",
			"disconnected",
			"reconnecting",
			"connected",
		]);
		expect(showConnected).toBe(true);
	});

	test("wasDisconnected is set once a non-connected state is seen", () => {
		const { wasDisconnected } = simulateTransitions(["connected", "failed"]);
		expect(wasDisconnected).toBe(true);
	});

	test("wasDisconnected stays false if always connected", () => {
		const { wasDisconnected } = simulateTransitions(["connected"]);
		expect(wasDisconnected).toBe(false);
	});

	test("banner remains visible across reconnecting sequence", () => {
		const steps: ConnectionState[] = ["disconnected", "reconnecting", "reconnecting"];
		for (const s of steps) {
			expect(isBannerVisible(s, false)).toBe(true);
		}
	});
});

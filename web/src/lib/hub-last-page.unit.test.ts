/**
 * Unit tests for the per-project "last viewed hub page" helpers. Covers the
 * load/persist round-trip, the unknown-project (null) and corrupted-storage
 * (null) fallbacks, the silent no-op write paths (SSR / quota), and the
 * per-project isolation that distinguishes this from the global diff-view-mode
 * preference.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
	hubLastPageKey,
	loadLastHubPage,
	persistLastHubPage,
} from "./hub-last-page";

// jsdom ships a real localStorage — clear it between tests so keys don't leak.
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("hubLastPageKey", () => {
	test("suffixes the projectId onto the ezcorp- prefix", () => {
		expect(hubLastPageKey("proj-1")).toBe("ezcorp-hub-last-page:proj-1");
		expect(hubLastPageKey("other")).toBe("ezcorp-hub-last-page:other");
	});
});

describe("loadLastHubPage", () => {
	test("returns null when the project has nothing stored", () => {
		expect(loadLastHubPage("proj-1")).toBeNull();
	});

	test("returns the stored page id after a persist", () => {
		persistLastHubPage("proj-1", "ext:cron-dashboard:dashboard");
		expect(loadLastHubPage("proj-1")).toBe("ext:cron-dashboard:dashboard");
	});

	test("returns null when getItem throws (private mode / corrupted storage)", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("private mode");
			},
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
		});
		expect(loadLastHubPage("proj-1")).toBeNull();
	});

	test("returns null under SSR (no localStorage)", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(loadLastHubPage("proj-1")).toBeNull();
	});
});

describe("persistLastHubPage", () => {
	test("round-trips through load", () => {
		persistLastHubPage("proj-1", "core:briefing");
		expect(loadLastHubPage("proj-1")).toBe("core:briefing");
		persistLastHubPage("proj-1", "ext:x:home");
		expect(loadLastHubPage("proj-1")).toBe("ext:x:home");
	});

	test("is a silent no-op when setItem throws (quota)", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => null,
			setItem: () => {
				throw new Error("quota exceeded");
			},
			removeItem: () => {},
			clear: () => {},
		});
		expect(() => persistLastHubPage("proj-1", "core:briefing")).not.toThrow();
	});

	test("is a silent no-op under SSR (no localStorage)", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(() => persistLastHubPage("proj-1", "core:briefing")).not.toThrow();
	});
});

describe("per-project isolation", () => {
	test("two projects keep independent last-page memory (no collision)", () => {
		persistLastHubPage("proj-1", "core:briefing");
		persistLastHubPage("proj-2", "ext:cron-dashboard:dashboard");
		expect(loadLastHubPage("proj-1")).toBe("core:briefing");
		expect(loadLastHubPage("proj-2")).toBe("ext:cron-dashboard:dashboard");

		// Overwriting one project's memory leaves the other untouched.
		persistLastHubPage("proj-1", "ext:other:page");
		expect(loadLastHubPage("proj-1")).toBe("ext:other:page");
		expect(loadLastHubPage("proj-2")).toBe("ext:cron-dashboard:dashboard");
	});
});

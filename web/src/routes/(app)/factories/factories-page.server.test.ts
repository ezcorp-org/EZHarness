import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ enabled: true }));
vi.mock("$server/factory/boot", () => ({
	factoryBootConfig: { get enabled() { return state.enabled; } },
}));

const route = await import("./+page.server");

describe("factory console route", () => {
	beforeEach(() => {
		state.enabled = true;
	});

	test("loads only when the factory feature is enabled", () => {
		expect(route.load()).toEqual({});
		state.enabled = false;
		expect(() => route.load()).toThrow(expect.objectContaining({ status: 404 }));
	});
});

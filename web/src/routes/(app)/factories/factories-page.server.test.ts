import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ enabled: true, application: null as { tenantId: string } | null }));
vi.mock("$server/factory/boot", () => ({
	factoryBootConfig: { get enabled() { return state.enabled; } },
}));
vi.mock("$server/factory/application", () => ({ getFactoryApplication: () => state.application }));

const route = await import("./+page.server");
const load = (role?: "admin" | "member") => route.load({ locals: role ? { user: { id: "u", role } } : {} } as never);

describe("factory console route", () => {
	beforeEach(() => {
		state.enabled = true;
		state.application = { tenantId: "tenant-1" };
	});

	test("loads only when the factory feature is enabled", () => {
		expect(load("admin")).toEqual({ tenantId: "tenant-1", administrator: true });
		state.enabled = false;
		expect(() => load("admin")).toThrow(expect.objectContaining({ status: 404 }));
	});

	test("names the tenant only when the application is composed, and the role only for an administrator", () => {
		expect(load("member")).toEqual({ tenantId: "tenant-1", administrator: false });
		expect(load()).toEqual({ tenantId: "tenant-1", administrator: false });
		state.application = null;
		expect(load("admin")).toEqual({ tenantId: null, administrator: true });
	});
});

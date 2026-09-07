import { describe, expect, test } from "vitest";
import { providerAccess } from "$lib/provider-access.js";

describe("providerAccess", () => {
	test("lets admins configure instance providers", () => {
		expect(providerAccess("admin")).toEqual({
			canConfigure: true,
			message: "Connect a provider to start chatting",
		});
	});

	test("keeps members away from server-refused provider controls", () => {
		expect(providerAccess("member")).toEqual({
			canConfigure: false,
			message: "An administrator needs to connect a provider before you can chat",
		});
	});
});

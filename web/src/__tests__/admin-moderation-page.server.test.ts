import { describe, expect, test } from "vitest";

import { load } from "../routes/(app)/admin/moderation/+page.server";

type LoadEvent = Parameters<typeof load>[0];

function loadFor(role?: "admin" | "member") {
	return load({
		locals: role
			? { user: { id: "user-1", email: "user@example.test", name: "User", role } }
			: {},
	} as LoadEvent);
}

describe("/(app)/admin/moderation/+page.server load", () => {
	test("allows an administrator to load the moderation page", async () => {
		await expect(loadFor("admin")).resolves.toBeUndefined();
	});

	test.each([undefined, "member"] as const)("redirects %s visitors to the home page", async (role) => {
		await expect(loadFor(role)).rejects.toMatchObject({ status: 302, location: "/" });
	});
});

import { afterEach, describe, expect, test, vi } from "vitest";

const requireAdminSession = vi.fn();

vi.mock("$server/auth/middleware", () => ({
	requireAdminSession: (locals: unknown) => requireAdminSession(locals),
}));

afterEach(() => vi.resetAllMocks());

describe("Incus management page access", () => {
	test("returns the page breadcrumb for an administrator", async () => {
		requireAdminSession.mockReturnValue({ id: "admin" });
		const { load } = await import("../+page.server");

		await expect(load({ locals: { user: { role: "admin" } } } as never)).resolves.toEqual({
			breadcrumbTail: "Incus sandboxes", operatorId: "admin",
		});
		expect(requireAdminSession).toHaveBeenCalledOnce();
	});

	test("rejects sessions that are not administrators", async () => {
		requireAdminSession.mockReturnValue(new Response(null, { status: 403 }));
		const { load } = await import("../+page.server");

		await expect(load({ locals: {} } as never)).rejects.toMatchObject({ status: 403 });
	});
});

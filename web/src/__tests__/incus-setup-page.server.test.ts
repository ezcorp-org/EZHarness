import { expect, test, vi } from "vitest";

vi.mock("$server/auth/middleware", () => ({
	requireAdminSession: (locals: { user?: { id: string; role: string }; authMethod?: string }) =>
		locals.user?.role === "admin" && locals.authMethod === "session"
			? locals.user
			: Response.json({ code: "forbidden" }, { status: locals.user ? 403 : 401 }),
}));

const { load } = await import("../routes/(app)/extensions/incus-setup/+page.server");

test("Incus setup page requires an administrator session", async () => {
	await expect(load({ locals: {} } as Parameters<typeof load>[0])).rejects.toMatchObject({ status: 401 });
	await expect(load({ locals: { user: { id: "member", role: "member" }, authMethod: "session" } } as Parameters<typeof load>[0])).rejects.toMatchObject({ status: 403 });
	await expect(load({ locals: { user: { id: "admin", role: "admin" }, authMethod: "api-key" } } as Parameters<typeof load>[0])).rejects.toMatchObject({ status: 403 });
});

test("Incus setup page gives administrators its breadcrumb", async () => {
	expect(await load({ locals: { user: { id: "admin", role: "admin" }, authMethod: "session" } } as Parameters<typeof load>[0])).toEqual({ breadcrumbTail: "Incus setup" });
});

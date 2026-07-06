/**
 * Coverage for `toPublicGrantView` — the server-side grant response mapper.
 * A bun:test (not vitest) so this module is instrumented by the bun route
 * shard ONLY, keeping its lcov attribution clean (see rbac-grants-view.ts's
 * header). The security-critical assertion is that a full `users` row can
 * never leak `passwordHash` (or any non-allowlisted column) into the wire view.
 */
import { describe, test, expect } from "bun:test";
import { toPublicGrantView } from "../rbac-grants-view";

describe("toPublicGrantView", () => {
	const grant = {
		id: "g-1",
		userId: "u-1",
		projectId: "proj-1" as string | null,
		extensionId: "github-projects" as string | null,
		scopes: ["use", "approve-runs"],
		grantedByUserId: "admin-1" as string | null,
		updatedAt: new Date("2026-07-01T12:00:00.000Z") as Date | string,
	};

	test("copies fields explicitly and stringifies a Date updatedAt", () => {
		const view = toPublicGrantView(grant, { id: "u-1", email: "m@t.local", name: "M" });
		expect(view).toEqual({
			id: "g-1",
			user: { id: "u-1", email: "m@t.local", name: "M" },
			projectId: "proj-1",
			extensionId: "github-projects",
			scopes: ["use", "approve-runs"],
			grantedBy: "admin-1",
			updatedAt: "2026-07-01T12:00:00.000Z",
		});
	});

	test("passes a string updatedAt through", () => {
		const view = toPublicGrantView({ ...grant, updatedAt: "2026-07-02T00:00:00.000Z" }, null);
		expect(view.updatedAt).toBe("2026-07-02T00:00:00.000Z");
	});

	test("null projectId/extensionId (covers-all) pass through untouched", () => {
		const view = toPublicGrantView({ ...grant, projectId: null, extensionId: null }, null);
		expect(view.projectId).toBeNull();
		expect(view.extensionId).toBeNull();
	});

	test("missing user degrades to empty email/name keyed by the grant's userId", () => {
		expect(toPublicGrantView(grant, null).user).toEqual({ id: "u-1", email: "", name: "" });
		expect(toPublicGrantView(grant, undefined).user).toEqual({ id: "u-1", email: "", name: "" });
	});

	test("never copies unknown user fields — a full users row (passwordHash) cannot leak", () => {
		const fullRow = {
			id: "u-1",
			email: "m@t.local",
			name: "M",
			passwordHash: "SECRET-HASH",
			role: "member",
		};
		const view = toPublicGrantView(grant, fullRow);
		expect(Object.keys(view.user).sort()).toEqual(["email", "id", "name"]);
		expect(JSON.stringify(view)).not.toContain("SECRET-HASH");
	});

	test("copies the scope list (mutating the view never touches the source row)", () => {
		const source = { ...grant, scopes: ["use", "approve-runs"] };
		const view = toPublicGrantView(source, null);
		view.scopes.push("manage");
		expect(source.scopes).toEqual(["use", "approve-runs"]);
	});
});

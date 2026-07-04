/**
 * Unit coverage for the pure RBAC-grants logic module
 * (`web/src/lib/rbac-grants-logic.ts`): scope-option derivation from a
 * manifest (core verbs + declared custom scopes, grammar/collision
 * filtering, degradation), the public grant view (explicit field copies —
 * no credential material can leak), display-row shaping, the scope
 * multi-select toggle, and the create-form pre-flight. 100% line coverage.
 */
import { describe, test, expect } from "vitest";
import {
	ALL_EXTENSIONS_LABEL,
	ALL_PROJECTS_LABEL,
	CORE_RBAC_SCOPE_OPTIONS,
	isRenderableCustomScopeName,
	scopeOptionsForExtension,
	shapeGrantRow,
	toPublicGrantView,
	toggleScope,
	validateGrantDraft,
	type PublicGrantView,
} from "../rbac-grants-logic";

const CORE_NAMES = ["use", "configure", "secrets", "approve-runs", "manage"];

describe("CORE_RBAC_SCOPE_OPTIONS", () => {
	test("mirrors the five backend core verbs, in order, all non-custom", () => {
		expect(CORE_RBAC_SCOPE_OPTIONS.map((o) => o.name)).toEqual(CORE_NAMES);
		expect(CORE_RBAC_SCOPE_OPTIONS.every((o) => o.custom === false)).toBe(true);
		expect(CORE_RBAC_SCOPE_OPTIONS.every((o) => o.description.length > 0)).toBe(true);
	});
});

describe("isRenderableCustomScopeName", () => {
	test("accepts grammar-valid non-core names", () => {
		expect(isRenderableCustomScopeName("write-tickets")).toBe(true);
		expect(isRenderableCustomScopeName("a1-b2")).toBe(true);
	});

	test("rejects grammar violations", () => {
		expect(isRenderableCustomScopeName("Write-Tickets")).toBe(false);
		expect(isRenderableCustomScopeName("1bad")).toBe(false);
		expect(isRenderableCustomScopeName("-bad")).toBe(false);
		expect(isRenderableCustomScopeName("bad_scope")).toBe(false);
		expect(isRenderableCustomScopeName("")).toBe(false);
	});

	test("rejects core-verb collisions", () => {
		for (const core of CORE_NAMES) {
			expect(isRenderableCustomScopeName(core)).toBe(false);
		}
	});
});

describe("scopeOptionsForExtension", () => {
	test("no extension selected (All extensions) → core verbs only", () => {
		expect(scopeOptionsForExtension(null).map((o) => o.name)).toEqual(CORE_NAMES);
		expect(scopeOptionsForExtension(undefined).map((o) => o.name)).toEqual(CORE_NAMES);
	});

	test("extension without a declared rbacScopes block degrades to core verbs", () => {
		expect(scopeOptionsForExtension({}).map((o) => o.name)).toEqual(CORE_NAMES);
		expect(scopeOptionsForExtension({ manifest: null }).map((o) => o.name)).toEqual(CORE_NAMES);
		expect(scopeOptionsForExtension({ manifest: "bogus" }).map((o) => o.name)).toEqual(CORE_NAMES);
		expect(scopeOptionsForExtension({ manifest: { permissions: null } }).map((o) => o.name)).toEqual(CORE_NAMES);
		expect(scopeOptionsForExtension({ manifest: { permissions: "x" } }).map((o) => o.name)).toEqual(CORE_NAMES);
		expect(
			scopeOptionsForExtension({ manifest: { permissions: { rbacScopes: "not-an-array" } } }).map((o) => o.name),
		).toEqual(CORE_NAMES);
	});

	test("declared custom scopes are appended after the core verbs, flagged custom", () => {
		const options = scopeOptionsForExtension({
			manifest: {
				permissions: {
					rbacScopes: [
						{ name: "write-tickets", description: "Create/move board tickets" },
						{ name: "read-metrics" },
					],
				},
			},
		});
		expect(options.map((o) => o.name)).toEqual([...CORE_NAMES, "write-tickets", "read-metrics"]);
		const custom = options.find((o) => o.name === "write-tickets")!;
		expect(custom.custom).toBe(true);
		expect(custom.description).toBe("Create/move board tickets");
		// A missing description degrades to the empty string.
		expect(options.find((o) => o.name === "read-metrics")!.description).toBe("");
	});

	test("invalid names, core collisions, non-object entries, and duplicates are dropped", () => {
		const options = scopeOptionsForExtension({
			manifest: {
				permissions: {
					rbacScopes: [
						{ name: "use", description: "shadowing a core verb" },
						{ name: "Bad_Grammar", description: "" },
						{ name: 42, description: "non-string name" },
						"not-an-object",
						null,
						{ name: "write-tickets", description: "first wins" },
						{ name: "write-tickets", description: "duplicate dropped" },
					],
				},
			},
		});
		expect(options.map((o) => o.name)).toEqual([...CORE_NAMES, "write-tickets"]);
		expect(options.find((o) => o.name === "write-tickets")!.description).toBe("first wins");
	});

	test("returns a fresh array — the core option list is never mutated", () => {
		const before = CORE_RBAC_SCOPE_OPTIONS.length;
		scopeOptionsForExtension({
			manifest: { permissions: { rbacScopes: [{ name: "write-tickets", description: "" }] } },
		});
		expect(CORE_RBAC_SCOPE_OPTIONS.length).toBe(before);
	});
});

describe("toPublicGrantView", () => {
	const grant = {
		id: "g-1",
		userId: "u-1",
		projectId: "proj-1",
		extensionId: "github-projects",
		scopes: ["use", "approve-runs"],
		grantedByUserId: "admin-1",
		updatedAt: new Date("2026-07-01T12:00:00.000Z"),
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
		const view = toPublicGrantView(grant, null);
		view.scopes.push("manage");
		expect(grant.scopes).toEqual(["use", "approve-runs"]);
	});
});

describe("shapeGrantRow", () => {
	const projects = [{ id: "proj-1", name: "Proj One" }];
	const base: PublicGrantView = {
		id: "g-1",
		user: { id: "u-1", email: "m@t.local", name: "M" },
		projectId: "proj-1",
		extensionId: "github-projects",
		scopes: ["use"],
		grantedBy: "admin-1",
		updatedAt: "2026-07-01T12:00:00.000Z",
	};

	test("resolves the project name and shows the extension slug", () => {
		const row = shapeGrantRow(base, projects);
		expect(row).toEqual({
			id: "g-1",
			userLabel: "m@t.local",
			projectLabel: "Proj One",
			extensionLabel: "github-projects",
			scopes: ["use"],
			grantedBy: "admin-1",
			updatedAt: "2026-07-01T12:00:00.000Z",
		});
	});

	test("NULL coordinates render the covers-all labels", () => {
		const row = shapeGrantRow({ ...base, projectId: null, extensionId: null }, projects);
		expect(row.projectLabel).toBe(ALL_PROJECTS_LABEL);
		expect(row.extensionLabel).toBe(ALL_EXTENSIONS_LABEL);
	});

	test("an unknown projectId falls back to the raw id", () => {
		expect(shapeGrantRow({ ...base, projectId: "ghost" }, projects).projectLabel).toBe("ghost");
	});

	test("user label falls back email → name → id", () => {
		expect(shapeGrantRow({ ...base, user: { id: "u-1", email: "", name: "M" } }, projects).userLabel).toBe("M");
		expect(shapeGrantRow({ ...base, user: { id: "u-1", email: "", name: "" } }, projects).userLabel).toBe("u-1");
	});
});

describe("toggleScope", () => {
	test("adds an absent scope (immutably)", () => {
		const input = ["use"];
		const out = toggleScope(input, "configure");
		expect(out).toEqual(["use", "configure"]);
		expect(input).toEqual(["use"]);
	});

	test("removes a present scope (immutably)", () => {
		const input = ["use", "configure"];
		const out = toggleScope(input, "use");
		expect(out).toEqual(["configure"]);
		expect(input).toEqual(["use", "configure"]);
	});
});

describe("validateGrantDraft", () => {
	test("requires a user first", () => {
		expect(validateGrantDraft({ userId: "", scopes: ["use"] })).toBe("Select a user.");
	});

	test("requires at least one scope", () => {
		expect(validateGrantDraft({ userId: "u-1", scopes: [] })).toBe("Select at least one scope.");
	});

	test("a complete draft passes", () => {
		expect(validateGrantDraft({ userId: "u-1", scopes: ["use"] })).toBeNull();
	});
});

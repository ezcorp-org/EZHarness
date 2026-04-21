import { test, expect, describe } from "bun:test";

/**
 * Pure editability logic matching the `isEditable` derived in
 * web/src/routes/(app)/agents/[name]/+page.svelte
 */
function isEditable(agent: {
	category: string | null;
	source: "file" | "config";
	id: string | null;
	shared?: boolean;
	permission?: "read" | "edit";
}): boolean {
	return (
		agent.category !== "team" &&
		agent.source === "config" &&
		!!agent.id &&
		!(agent.shared && agent.permission === "read")
	);
}

describe("agent editability", () => {
	test("config agent with id is editable", () => {
		expect(isEditable({ category: null, source: "config", id: "cfg-1" })).toBe(true);
	});

	test("config agent with category is editable", () => {
		expect(isEditable({ category: "productivity", source: "config", id: "cfg-2" })).toBe(true);
	});

	test("file-based agent is not editable", () => {
		expect(isEditable({ category: null, source: "file", id: null })).toBe(false);
	});

	test("config agent without id is not editable", () => {
		expect(isEditable({ category: null, source: "config", id: null })).toBe(false);
	});

	test("shared read-only agent is not editable", () => {
		expect(isEditable({ category: null, source: "config", id: "cfg-3", shared: true, permission: "read" })).toBe(false);
	});

	test("shared edit-permission agent is editable", () => {
		expect(isEditable({ category: null, source: "config", id: "cfg-4", shared: true, permission: "edit" })).toBe(true);
	});

	test("team agent is not editable (uses TeamBuilderForm instead)", () => {
		expect(isEditable({ category: "team", source: "config", id: "cfg-5" })).toBe(false);
	});

	test("non-shared config agent without permission field is editable", () => {
		expect(isEditable({ category: null, source: "config", id: "cfg-6", shared: false })).toBe(true);
	});
});

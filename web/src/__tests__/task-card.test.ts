import { test, expect, describe } from "bun:test";
import {
	getCardComponentName,
	parseTaskOutput,
	getStatusBadge,
	parseListOutput,
	isStackList,
	getStatusColor,
	getStatusIcon,
} from "../lib/components/tool-cards/utils.js";

describe("getCardComponentName – task-stack cardTypes", () => {
	test("maps 'task-list' cardType to TaskListCard", () => {
		expect(getCardComponentName("task-list", false)).toBe("TaskListCard");
	});

	test("maps 'task-detail' cardType to TaskDetailCard", () => {
		expect(getCardComponentName("task-detail", false)).toBe("TaskDetailCard");
	});

	test("returns PermissionGate for task-list when permissionPending is true", () => {
		expect(getCardComponentName("task-list", true)).toBe("PermissionGate");
	});

	test("returns PermissionGate for task-detail when permissionPending is true", () => {
		expect(getCardComponentName("task-detail", true)).toBe("PermissionGate");
	});

	test("task-list returns correct card when permissionPending is undefined", () => {
		expect(getCardComponentName("task-list", undefined)).toBe("TaskListCard");
	});

	test("task-detail returns correct card when permissionPending is undefined", () => {
		expect(getCardComponentName("task-detail", undefined)).toBe("TaskDetailCard");
	});

	// Verify existing card types still work (regression)
	test("existing cardTypes are unaffected", () => {
		expect(getCardComponentName("terminal", false)).toBe("TerminalCard");
		expect(getCardComponentName("diff", false)).toBe("DiffCard");
		expect(getCardComponentName("search-results", false)).toBe("SearchResultsCard");
		expect(getCardComponentName(undefined, false)).toBe("DefaultCard");
		expect(getCardComponentName("unknown-type", false)).toBe("DefaultCard");
	});
});

// ── TaskDetailCard utils ──

describe("parseTaskOutput", () => {
	test("parses valid JSON task object", () => {
		const task = { id: "1", title: "Test", status: "active" };
		const result = parseTaskOutput(JSON.stringify(task));
		expect(result).toEqual(task);
	});

	test("parses object input directly", () => {
		const task = { id: "2", title: "Direct", status: "pending" };
		expect(parseTaskOutput(task)).toEqual(task);
	});

	test("returns null for array of tasks", () => {
		expect(parseTaskOutput([{ id: "1" }, { id: "2" }])).toBeNull();
	});

	test("returns null for null output", () => {
		expect(parseTaskOutput(null)).toBeNull();
	});

	test("returns null for undefined output", () => {
		expect(parseTaskOutput(undefined)).toBeNull();
	});

	test("returns null for invalid JSON string", () => {
		expect(parseTaskOutput("not valid json {")).toBeNull();
	});

	test("returns null for empty string", () => {
		expect(parseTaskOutput("")).toBeNull();
	});

	test("returns null for JSON array string", () => {
		expect(parseTaskOutput('[{"id":"1"}]')).toBeNull();
	});

	test("returns null for JSON primitive string", () => {
		expect(parseTaskOutput('"just a string"')).toBeNull();
	});
});

describe("getStatusBadge", () => {
	test("completed → green badge", () => {
		const badge = getStatusBadge("completed");
		expect(badge.text).toBe("Completed");
		expect(badge.classes).toContain("green");
	});

	test("active → blue badge", () => {
		const badge = getStatusBadge("active");
		expect(badge.text).toBe("Active");
		expect(badge.classes).toContain("blue");
	});

	test("pending → yellow badge", () => {
		const badge = getStatusBadge("pending");
		expect(badge.text).toBe("Pending");
		expect(badge.classes).toContain("yellow");
	});

	test("unknown status → gray badge with status text", () => {
		const badge = getStatusBadge("custom-status");
		expect(badge.text).toBe("custom-status");
		expect(badge.classes).toContain("gray");
	});

	test("undefined → gray badge with 'Unknown'", () => {
		const badge = getStatusBadge(undefined);
		expect(badge.text).toBe("Unknown");
		expect(badge.classes).toContain("gray");
	});
});

// ── TaskListCard utils ──

describe("parseListOutput", () => {
	test("parses valid JSON array string", () => {
		const items = [{ id: "1", title: "A" }, { id: "2", title: "B" }];
		expect(parseListOutput(JSON.stringify(items))).toEqual(items);
	});

	test("returns array input directly", () => {
		const items = [{ id: "1" }];
		expect(parseListOutput(items)).toEqual(items);
	});

	test("returns empty array for empty JSON array", () => {
		expect(parseListOutput("[]")).toEqual([]);
	});

	test("returns empty array for null", () => {
		expect(parseListOutput(null)).toEqual([]);
	});

	test("returns empty array for undefined", () => {
		expect(parseListOutput(undefined)).toEqual([]);
	});

	test("returns empty array for invalid JSON", () => {
		expect(parseListOutput("not json")).toEqual([]);
	});

	test("returns empty array for JSON object (not array)", () => {
		expect(parseListOutput('{"id":"1"}')).toEqual([]);
	});
});

describe("isStackList", () => {
	test("returns false for tasks (have status)", () => {
		expect(isStackList([{ id: "1", status: "active", title: "Task" }])).toBe(false);
	});

	test("returns true for stacks (have name, no status)", () => {
		expect(isStackList([{ name: "Backlog" }, { name: "Sprint" }])).toBe(true);
	});

	test("returns false for empty array", () => {
		expect(isStackList([])).toBe(false);
	});

	test("returns false for items with both name and status", () => {
		expect(isStackList([{ name: "Task", status: "active" }])).toBe(false);
	});
});

describe("getStatusColor", () => {
	test("completed → green", () => {
		expect(getStatusColor("completed")).toContain("green");
	});

	test("active → blue", () => {
		expect(getStatusColor("active")).toContain("blue");
	});

	test("pending → muted (default)", () => {
		expect(getStatusColor("pending")).toContain("muted");
	});

	test("undefined → muted (default)", () => {
		expect(getStatusColor(undefined)).toContain("muted");
	});
});

describe("getStatusIcon", () => {
	test("completed → checkmark", () => {
		expect(getStatusIcon("completed")).toBe("✓");
	});

	test("active → play", () => {
		expect(getStatusIcon("active")).toBe("▶");
	});

	test("pending → circle (default)", () => {
		expect(getStatusIcon("pending")).toBe("○");
	});

	test("undefined → circle (default)", () => {
		expect(getStatusIcon(undefined)).toBe("○");
	});
});

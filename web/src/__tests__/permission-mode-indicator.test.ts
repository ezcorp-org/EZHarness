import { test, expect, describe } from "bun:test";
import {
	type PermissionMode,
	PERMISSION_MODES,
	modeToColor,
	modeToLabel,
	modeToDescription,
} from "../lib/permission-mode";

describe("modeToColor", () => {
	test("ask -> red", () => {
		expect(modeToColor("ask")).toBe("bg-red-500");
	});

	test("auto-edit -> yellow", () => {
		expect(modeToColor("auto-edit")).toBe("bg-yellow-500");
	});

	test("yolo -> green", () => {
		expect(modeToColor("yolo")).toBe("bg-green-500");
	});

	test("all valid modes return a defined value", () => {
		for (const mode of PERMISSION_MODES) {
			expect(modeToColor(mode)).toBeDefined();
			expect(modeToColor(mode)).not.toBe("");
		}
	});
});

describe("modeToLabel", () => {
	test("ask -> Ask", () => {
		expect(modeToLabel("ask")).toBe("Ask");
	});

	test("auto-edit -> Auto-edit", () => {
		expect(modeToLabel("auto-edit")).toBe("Auto-edit");
	});

	test("yolo -> YOLO", () => {
		expect(modeToLabel("yolo")).toBe("YOLO");
	});

	test("all valid modes return a defined value", () => {
		for (const mode of PERMISSION_MODES) {
			expect(modeToLabel(mode)).toBeDefined();
			expect(modeToLabel(mode)).not.toBe("");
		}
	});
});

describe("modeToDescription", () => {
	test("all valid modes return a non-empty description", () => {
		for (const mode of PERMISSION_MODES) {
			const desc = modeToDescription(mode);
			expect(desc).toBeDefined();
			expect(desc.length).toBeGreaterThan(0);
		}
	});
});

describe("PERMISSION_MODES", () => {
	test("contains exactly 3 modes", () => {
		expect(PERMISSION_MODES).toHaveLength(3);
	});

	test("contains ask, auto-edit, yolo", () => {
		expect(PERMISSION_MODES).toContain("ask");
		expect(PERMISSION_MODES).toContain("auto-edit");
		expect(PERMISSION_MODES).toContain("yolo");
	});
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	sanitizePath,
	debounce,
	splitPath,
	filterByExtensions,
	filterOptions,
	filterSuggestions,
	formatDateForInput,
	parseDateFromInput,
} from "../lib/components/ui/helpers";

describe("sanitizePath", () => {
	test("strips .. traversal sequences", () => {
		const result = sanitizePath("../../etc/passwd");
		expect(result).not.toContain("..");
	});

	test("strips null bytes", () => {
		const result = sanitizePath("file\0name.ts");
		expect(result).toBe("filename.ts");
	});

	test("leaves normal paths unchanged", () => {
		expect(sanitizePath("~/projects/foo.ts")).toBe("~/projects/foo.ts");
	});

	test("handles path with both traversal and null bytes", () => {
		const result = sanitizePath("../\0test/../file.ts");
		expect(result).not.toContain("..");
		expect(result).not.toContain("\0");
	});
});

describe("debounce", () => {
	let originalSetTimeout: typeof globalThis.setTimeout;
	let originalClearTimeout: typeof globalThis.clearTimeout;
	let timers: { fn: Function; delay: number; id: number }[];
	let nextId: number;

	beforeEach(() => {
		timers = [];
		nextId = 1;
		originalSetTimeout = globalThis.setTimeout;
		originalClearTimeout = globalThis.clearTimeout;

		// @ts-ignore - manual timer mock
		globalThis.setTimeout = (fn: Function, delay: number) => {
			const id = nextId++;
			timers.push({ fn, delay, id });
			return id;
		};
		// @ts-ignore
		globalThis.clearTimeout = (id: number) => {
			timers = timers.filter((t) => t.id !== id);
		};
	});

	afterEach(() => {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	});

	test("delays execution by specified ms", () => {
		let called = false;
		const debounced = debounce(() => { called = true; }, 200);
		debounced();
		expect(called).toBe(false);
		expect(timers).toHaveLength(1);
		expect(timers[0].delay).toBe(200);
		// Execute the timer
		timers[0].fn();
		expect(called).toBe(true);
	});

	test("cancels previous pending call on re-invocation", () => {
		let callCount = 0;
		const debounced = debounce(() => { callCount++; }, 100);
		debounced();
		debounced();
		debounced();
		// Only the last timer should remain
		expect(timers).toHaveLength(1);
		timers[0].fn();
		expect(callCount).toBe(1);
	});
});

describe("splitPath", () => {
	test("normal path returns dir and partial", () => {
		expect(splitPath("/home/user/foo.ts")).toEqual({ dir: "/home/user", partial: "foo.ts" });
	});

	test("no slash returns home dir and full path as partial", () => {
		expect(splitPath("foo.ts")).toEqual({ dir: "~", partial: "foo.ts" });
	});

	test("root path returns / as dir", () => {
		expect(splitPath("/foo.ts")).toEqual({ dir: "/", partial: "foo.ts" });
	});

	test("trailing slash returns dir and empty partial", () => {
		expect(splitPath("/home/user/")).toEqual({ dir: "/home/user", partial: "" });
	});
});

describe("filterByExtensions", () => {
	const entries = [
		{ name: "main.ts", isDir: false },
		{ name: "style.css", isDir: false },
		{ name: "src", isDir: true },
		{ name: "readme.md", isDir: false },
	];

	test("filters files by extension", () => {
		const result = filterByExtensions(entries, [".ts", ".md"]);
		expect(result.map((e) => e.name)).toEqual(["main.ts", "src", "readme.md"]);
	});

	test("keeps directories regardless of extension", () => {
		const result = filterByExtensions(entries, [".ts"]);
		expect(result.find((e) => e.name === "src")).toBeDefined();
	});

	test("empty extensions list excludes all files", () => {
		const result = filterByExtensions(entries, []);
		expect(result).toEqual([{ name: "src", isDir: true }]);
	});
});

describe("filterOptions", () => {
	const options = ["Apple", "Banana", "Avocado", "Cherry"];

	test("empty query returns all options", () => {
		expect(filterOptions(options, "")).toEqual(options);
	});

	test("filters case-insensitively", () => {
		expect(filterOptions(options, "av")).toEqual(["Avocado"]);
	});

	test("no matches returns empty array", () => {
		expect(filterOptions(options, "xyz")).toEqual([]);
	});
});

describe("filterSuggestions", () => {
	const suggestions = ["alpha", "beta", "gamma", "delta"];

	test("excludes already-selected items", () => {
		const result = filterSuggestions(suggestions, ["alpha", "gamma"], "");
		expect(result).toEqual(["beta", "delta"]);
	});

	test("filters by query case-insensitively", () => {
		const result = filterSuggestions(suggestions, [], "AL");
		expect(result).toEqual(["alpha"]);
	});

	test("empty suggestions returns empty array", () => {
		expect(filterSuggestions([], [], "foo")).toEqual([]);
	});
});

describe("formatDateForInput", () => {
	test("empty string returns empty string", () => {
		expect(formatDateForInput("", false)).toBe("");
		expect(formatDateForInput("", true)).toBe("");
	});

	test("date-only mode returns YYYY-MM-DD", () => {
		expect(formatDateForInput("2024-06-15", false)).toBe("2024-06-15");
	});

	test("datetime with Z suffix strips timezone and truncates", () => {
		expect(formatDateForInput("2024-06-15T14:30:00Z", true)).toBe("2024-06-15T14:30");
	});

	test("datetime with offset strips offset and truncates", () => {
		expect(formatDateForInput("2024-06-15T14:30:00+05:30", true)).toBe("2024-06-15T14:30");
	});
});

describe("parseDateFromInput", () => {
	test("date mode passes value through unchanged", () => {
		expect(parseDateFromInput("2024-06-15", false)).toBe("2024-06-15");
	});

	test("datetime mode converts to ISO string", () => {
		const result = parseDateFromInput("2024-06-15T14:30", true);
		expect(result).toMatch(/^2024-06-15T/);
		expect(result).toMatch(/Z$/);
	});

	test("empty string in datetime mode returns empty string", () => {
		expect(parseDateFromInput("", true)).toBe("");
	});
});

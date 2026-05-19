import { test, expect, describe } from "bun:test";
import {
	extractDiffDetails,
	extractDiffInput,
	generateDiffText,
	isNewFile,
} from "../lib/components/tool-cards/utils.js";

describe("extractDiffDetails", () => {
	test("extracts oldContent/newContent from top-level output", () => {
		const result = extractDiffDetails({ oldContent: "foo", newContent: "bar" });
		expect(result).toEqual({ oldContent: "foo", newContent: "bar" });
	});

	test("extracts from nested details object", () => {
		const result = extractDiffDetails({
			details: { oldContent: "old", newContent: "new" },
		});
		expect(result).toEqual({ oldContent: "old", newContent: "new" });
	});

	test("returns empty object for string output", () => {
		expect(extractDiffDetails("just a string")).toEqual({});
	});

	test("returns empty object for null", () => {
		expect(extractDiffDetails(null)).toEqual({});
	});

	test("returns empty object for undefined", () => {
		expect(extractDiffDetails(undefined)).toEqual({});
	});

	test("returns undefined fields for non-string content values", () => {
		const result = extractDiffDetails({ oldContent: 123, newContent: true });
		expect(result).toEqual({ oldContent: undefined, newContent: undefined });
	});

	test("handles partial content (only oldContent)", () => {
		const result = extractDiffDetails({ oldContent: "old" });
		expect(result).toEqual({ oldContent: "old", newContent: undefined });
	});

	test("handles partial content (only newContent)", () => {
		const result = extractDiffDetails({ newContent: "new" });
		expect(result).toEqual({ oldContent: undefined, newContent: "new" });
	});
});

describe("generateDiffText", () => {
	test("generates unified diff for normal changes", () => {
		const result = generateDiffText("line1\nline2", "line1\nline3", "test.ts");
		expect(result).toContain("--- a/test.ts");
		expect(result).toContain("+++ b/test.ts");
		expect(result).toContain("-line1");
		expect(result).toContain("-line2");
		expect(result).toContain("+line1");
		expect(result).toContain("+line3");
	});

	test("handles new file (empty old content)", () => {
		const result = generateDiffText("", "new content", "new.ts");
		expect(result).toContain("@@ -1,1 +1,1 @@");
		expect(result).toContain("+new content");
	});

	test("handles deleted file (empty new content)", () => {
		const result = generateDiffText("old content", "", "deleted.ts");
		expect(result).toContain("-old content");
	});

	test("returns empty string when both are empty", () => {
		expect(generateDiffText("", "", "file.ts")).toBe("");
	});

	test("includes correct line counts in hunk header", () => {
		const result = generateDiffText("a\nb\nc", "x\ny", "file.ts");
		expect(result).toContain("@@ -1,3 +1,2 @@");
	});

	test("new file produces no spurious deletion line", () => {
		// Regression: empty oldContent must NOT emit a `-` line. A blank
		// `-`/hunk-count mismatch produced an unparseable diff (diff2html
		// fell through to "No diff available" for newly-created files).
		const result = generateDiffText("", "alpha\nbeta", "new.ts");
		expect(result).not.toContain("\n-");
		expect(result).toContain("@@ -1,1 +1,2 @@");
		expect(result).toContain("+alpha\n+beta");
	});
});

describe("extractDiffInput", () => {
	test("extracts new_string as newContent (created file)", () => {
		expect(extractDiffInput({ path: "a.ts", new_string: "hello" })).toEqual({
			oldContent: undefined,
			newContent: "hello",
		});
	});

	test("extracts old_string + new_string (search/replace)", () => {
		expect(
			extractDiffInput({ file_path: "a.ts", old_string: "foo", new_string: "bar" }),
		).toEqual({ oldContent: "foo", newContent: "bar" });
	});

	test("falls back to content field when new_string absent", () => {
		expect(extractDiffInput({ path: "a.ts", content: "body" })).toEqual({
			oldContent: undefined,
			newContent: "body",
		});
	});

	test("prefers new_string over content", () => {
		expect(
			extractDiffInput({ path: "a.ts", new_string: "primary", content: "ignored" }),
		).toEqual({ oldContent: undefined, newContent: "primary" });
	});

	test("returns empty object for null / non-object / missing fields", () => {
		expect(extractDiffInput(null)).toEqual({});
		expect(extractDiffInput("str")).toEqual({});
		expect(extractDiffInput(undefined)).toEqual({});
		expect(extractDiffInput({ path: "a.ts" })).toEqual({
			oldContent: undefined,
			newContent: undefined,
		});
	});

	test("ignores non-string field values", () => {
		expect(
			extractDiffInput({ old_string: 1, new_string: { x: 1 } }),
		).toEqual({ oldContent: undefined, newContent: undefined });
	});

	test("keeps empty-string new_string (empty-file creation)", () => {
		// "" is a valid string — nullish-coalescing must NOT fall through
		// to `content`, and "" must survive as newContent.
		expect(extractDiffInput({ path: "a.ts", new_string: "" })).toEqual({
			oldContent: undefined,
			newContent: "",
		});
		expect(
			extractDiffInput({ path: "a.ts", new_string: "", content: "ignored" }),
		).toEqual({ oldContent: undefined, newContent: "" });
	});

	test("keeps empty-string old_string", () => {
		expect(
			extractDiffInput({ file_path: "a.ts", old_string: "", new_string: "x" }),
		).toEqual({ oldContent: "", newContent: "x" });
	});

	test("non-string content with no new_string yields undefined", () => {
		expect(extractDiffInput({ path: "a.ts", content: 42 })).toEqual({
			oldContent: undefined,
			newContent: undefined,
		});
	});
});

describe("isNewFile", () => {
	test("returns true when oldContent is empty and newContent has content", () => {
		expect(isNewFile("", "some content")).toBe(true);
	});

	test("returns true when oldContent is undefined and newContent has content", () => {
		expect(isNewFile(undefined, "content")).toBe(true);
	});

	test("returns false when oldContent has content", () => {
		expect(isNewFile("existing", "updated")).toBe(false);
	});

	test("returns false when both are empty", () => {
		expect(isNewFile("", "")).toBe(false);
	});

	test("returns false when newContent is undefined", () => {
		expect(isNewFile("", undefined)).toBe(false);
	});

	test("returns false when both are undefined", () => {
		expect(isNewFile(undefined, undefined)).toBe(false);
	});
});

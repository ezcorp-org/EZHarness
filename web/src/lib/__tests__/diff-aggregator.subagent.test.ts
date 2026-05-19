import { test, expect, describe } from "bun:test";
import { aggregateToolCallDiffs } from "../diff-aggregator";

/**
 * Verifies that edits produced by team members / invoked agents merge with
 * parent-conversation edits in the Diff Summary panel. The aggregator groups
 * by file path, so edits against the same path from different conversations
 * must appear under one group with all diffs listed in input order.
 */

describe("aggregateToolCallDiffs — multi-conversation origins", () => {
	test("parent + sub-agent edits on DIFFERENT files produce two groups preserving input order", () => {
		const calls = [
			// Parent conversation edited api.ts
			{
				toolName: "edit_file",
				input: { file_path: "src/api.ts", old_string: "const v = 1;", new_string: "const v = 2;" },
			},
			// Sub-agent (e.g. team member) edited auth.ts
			{
				toolName: "edit_file",
				input: { file_path: "src/auth.ts", old_string: "return false;", new_string: "return true;" },
			},
		];

		const groups = aggregateToolCallDiffs(calls);
		expect(groups).toHaveLength(2);
		expect(groups[0]!.filePath).toBe("src/api.ts");
		expect(groups[0]!.diffs).toHaveLength(1);
		expect(groups[1]!.filePath).toBe("src/auth.ts");
		expect(groups[1]!.diffs).toHaveLength(1);
	});

	test("parent + sub-agent edits on the SAME file merge into one group with diffs in input order", () => {
		const calls = [
			// Parent made an edit first
			{
				toolName: "edit_file",
				input: { file_path: "src/shared.ts", old_string: "a = 1", new_string: "a = 2" },
			},
			// Sub-agent later edited the same file
			{
				toolName: "edit_file",
				input: { file_path: "src/shared.ts", old_string: "b = 1", new_string: "b = 3" },
			},
		];

		const groups = aggregateToolCallDiffs(calls);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.filePath).toBe("src/shared.ts");
		expect(groups[0]!.diffs).toHaveLength(2);
		// Verify ordering by checking distinctive content from each edit
		expect(groups[0]!.diffs[0]).toContain("-a = 1");
		expect(groups[0]!.diffs[0]).toContain("+a = 2");
		expect(groups[0]!.diffs[1]).toContain("-b = 1");
		expect(groups[0]!.diffs[1]).toContain("+b = 3");
	});

	test("write-style tool (content-only, no old_string) from sub-agent is still aggregated", () => {
		const calls = [
			{
				toolName: "write",
				input: { file_path: "src/new.ts", content: "export const x = 1;" },
			},
		];

		const groups = aggregateToolCallDiffs(calls);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.filePath).toBe("src/new.ts");
		expect(groups[0]!.diffs[0]).toContain("+export const x = 1;");
	});

	test("non-edit tool calls (no file_path) are ignored regardless of origin", () => {
		const calls = [
			{ toolName: "shell", input: { command: "ls -la" } },
			{ toolName: "read_file", input: { file_path: "src/read.ts" } }, // no edit fields
			{ toolName: "edit_file", input: { file_path: "src/real.ts", old_string: "x", new_string: "y" } },
		];
		const groups = aggregateToolCallDiffs(calls);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.filePath).toBe("src/real.ts");
	});

	test("interleaved parent and sub edits across multiple files: every file is represented", () => {
		const calls = [
			{ toolName: "edit_file", input: { file_path: "a.ts", old_string: "1", new_string: "2" } },
			{ toolName: "edit_file", input: { file_path: "b.ts", old_string: "x", new_string: "y" } },
			{ toolName: "edit_file", input: { file_path: "a.ts", old_string: "2", new_string: "3" } },
			{ toolName: "edit_file", input: { file_path: "c.ts", old_string: "foo", new_string: "bar" } },
		];
		const groups = aggregateToolCallDiffs(calls);
		expect(groups.map((g) => g.filePath).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
		const aGroup = groups.find((g) => g.filePath === "a.ts")!;
		expect(aGroup.diffs).toHaveLength(2);
	});
});

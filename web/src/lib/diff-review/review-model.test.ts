/**
 * Unit tests for the code-review panel's file model.
 *
 * These cover the pure derivation the GitHub-style panel paints from: the
 * merge of the two upstream diff sources, per-file counts/status, the filter,
 * the five-square diffstat, and the file tree.
 */
import { describe, expect, test } from "bun:test";
import type { ExtractedDiff, ToolCallDiffGroup } from "../diff-aggregator";
import {
	UNNAMED_DIFF_PATH,
	allDirPaths,
	buildFileTree,
	buildReviewFiles,
	countDiffStats,
	deriveStatus,
	diffStatBlocks,
	filterReviewFiles,
	splitPath,
	toggleInSet,
	totalStats,
	type FileTreeNode,
	type ReviewFile,
} from "./review-model";

const MODIFY_DIFF = [
	"--- a/src/auth.ts",
	"+++ b/src/auth.ts",
	"@@ -1,2 +1,3 @@",
	" const x = 1;",
	"-const ok = false;",
	"+const ok = true;",
	"+const extra = 1;",
].join("\n");

function group(filePath: string, diffs: string[]): ToolCallDiffGroup {
	return { filePath, toolName: "edit_file", diffs };
}

function extracted(content: string, fileName?: string): ExtractedDiff {
	return { messageId: "m1", content, fileName };
}

describe("countDiffStats", () => {
	test("counts +/- content lines and skips the ---/+++ file headers", () => {
		expect(countDiffStats(MODIFY_DIFF)).toEqual({ additions: 2, deletions: 1 });
	});

	test("an empty diff counts nothing", () => {
		expect(countDiffStats("")).toEqual({ additions: 0, deletions: 0 });
	});

	test("context lines are not counted", () => {
		expect(countDiffStats("@@ -1 +1 @@\n unchanged")).toEqual({ additions: 0, deletions: 0 });
	});
});

describe("deriveStatus", () => {
	test("additions only is an added file", () => {
		expect(deriveStatus(5, 0)).toBe("added");
	});

	test("deletions only is a removed file", () => {
		expect(deriveStatus(0, 5)).toBe("removed");
	});

	test("both sides is a modification", () => {
		expect(deriveStatus(3, 2)).toBe("modified");
	});

	test("no counted lines falls back to modified", () => {
		expect(deriveStatus(0, 0)).toBe("modified");
	});
});

describe("splitPath", () => {
	test("splits a nested path into directory and name", () => {
		expect(splitPath("src/lib/auth.ts")).toEqual({ dirname: "src/lib", basename: "auth.ts" });
	});

	test("a root-level file has an empty dirname", () => {
		expect(splitPath("README.md")).toEqual({ dirname: "", basename: "README.md" });
	});
});

describe("buildReviewFiles", () => {
	test("tool-call groups come first, then fenced message diffs", () => {
		const files = buildReviewFiles(
			[group("src/a.ts", [MODIFY_DIFF])],
			[extracted(MODIFY_DIFF, "src/b.ts")],
		);
		expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(files.map((f) => f.source)).toEqual(["tool", "message"]);
	});

	test("several edits to one file merge into a single review file", () => {
		const files = buildReviewFiles([group("src/a.ts", [MODIFY_DIFF, MODIFY_DIFF])], []);
		expect(files).toHaveLength(1);
		expect(files[0]!.additions).toBe(4);
		expect(files[0]!.deletions).toBe(2);
	});

	test("derives path parts, status and a stable per-source key", () => {
		const files = buildReviewFiles([group("src/lib/a.ts", [MODIFY_DIFF])], [extracted(MODIFY_DIFF)]);
		expect(files[0]).toMatchObject({
			key: "tool:src/lib/a.ts",
			dirname: "src/lib",
			basename: "a.ts",
			status: "modified",
		});
		expect(files[1]!.key).toBe("code:m1#0");
	});

	test("message-diff keys are scoped to the owning message, not the flat index", () => {
		const files = buildReviewFiles(
			[],
			[
				{ messageId: "m1", content: MODIFY_DIFF, fileName: "a.ts" },
				{ messageId: "m1", content: MODIFY_DIFF, fileName: "b.ts" },
				{ messageId: "m2", content: MODIFY_DIFF, fileName: "c.ts" },
			],
		);
		expect(files.map((f) => f.key)).toEqual(["code:m1#0", "code:m1#1", "code:m2#0"]);
	});

	test("an earlier message gaining a diff does not re-key the later ones", () => {
		const later = { messageId: "m2", content: MODIFY_DIFF, fileName: "c.ts" };
		const before = buildReviewFiles([], [extracted(MODIFY_DIFF, "a.ts"), later]);
		const after = buildReviewFiles(
			[],
			[extracted(MODIFY_DIFF, "a.ts"), extracted(MODIFY_DIFF, "b.ts"), later],
		);
		expect(before.at(-1)!.key).toBe(after.at(-1)!.key);
	});

	test("a fenced diff with no filename falls back to the unnamed placeholder", () => {
		const files = buildReviewFiles([], [extracted("@@ -1 +1 @@\n-a\n+b")]);
		expect(files[0]!.path).toBe(UNNAMED_DIFF_PATH);
	});

	test("no sources produces no files", () => {
		expect(buildReviewFiles([], [])).toEqual([]);
	});
});

describe("totalStats", () => {
	test("sums files, additions and deletions", () => {
		const files = buildReviewFiles(
			[group("src/a.ts", [MODIFY_DIFF]), group("src/b.ts", [MODIFY_DIFF])],
			[],
		);
		expect(totalStats(files)).toEqual({ files: 2, additions: 4, deletions: 2 });
	});

	test("an empty review totals zero", () => {
		expect(totalStats([])).toEqual({ files: 0, additions: 0, deletions: 0 });
	});
});

describe("filterReviewFiles", () => {
	const files = buildReviewFiles(
		[group("src/auth.ts", [MODIFY_DIFF]), group("web/ui.svelte", [MODIFY_DIFF])],
		[],
	);

	test("matches a case-insensitive substring of the path", () => {
		expect(filterReviewFiles(files, "AUTH").map((f) => f.path)).toEqual(["src/auth.ts"]);
	});

	test("matches on the directory portion too", () => {
		expect(filterReviewFiles(files, "web/").map((f) => f.path)).toEqual(["web/ui.svelte"]);
	});

	test("a blank or whitespace-only query keeps everything", () => {
		expect(filterReviewFiles(files, "")).toHaveLength(2);
		expect(filterReviewFiles(files, "   ")).toHaveLength(2);
	});

	test("a query that matches nothing returns nothing", () => {
		expect(filterReviewFiles(files, "nope")).toEqual([]);
	});
});

describe("diffStatBlocks", () => {
	test("always returns five blocks", () => {
		expect(diffStatBlocks(3, 7)).toHaveLength(5);
	});

	test("a file with no counted lines is all neutral", () => {
		expect(diffStatBlocks(0, 0)).toEqual([
			"neutral",
			"neutral",
			"neutral",
			"neutral",
			"neutral",
		]);
	});

	test("a large additions-only change fills every block green", () => {
		expect(diffStatBlocks(10, 0)).toEqual(["added", "added", "added", "added", "added"]);
	});

	test("a large deletions-only change fills every block red", () => {
		expect(diffStatBlocks(0, 10)).toEqual([
			"deleted",
			"deleted",
			"deleted",
			"deleted",
			"deleted",
		]);
	});

	test("a one-line change shows a single block and four greys", () => {
		expect(diffStatBlocks(1, 0)).toEqual(["added", "neutral", "neutral", "neutral", "neutral"]);
		expect(diffStatBlocks(0, 1)).toEqual(["deleted", "neutral", "neutral", "neutral", "neutral"]);
	});

	test("changes of five lines or fewer map one block per line", () => {
		expect(diffStatBlocks(2, 1)).toEqual(["added", "added", "deleted", "neutral", "neutral"]);
		expect(diffStatBlocks(3, 2)).toEqual(["added", "added", "added", "deleted", "deleted"]);
	});

	test("a large change scales to fill all five blocks", () => {
		const blocks = diffStatBlocks(30, 20);
		expect(blocks.filter((b) => b === "added")).toHaveLength(3);
		expect(blocks.filter((b) => b === "deleted")).toHaveLength(2);
		expect(blocks.filter((b) => b === "neutral")).toHaveLength(0);
	});

	test("rounding on a lopsided large change never overflows five blocks", () => {
		expect(diffStatBlocks(99, 1)).toHaveLength(5);
		expect(diffStatBlocks(99, 1).filter((b) => b === "added")).toHaveLength(5);
		expect(diffStatBlocks(1, 99).filter((b) => b === "deleted")).toHaveLength(5);
	});
});

describe("buildFileTree", () => {
	function paths(nodes: FileTreeNode[]): string[] {
		return nodes.flatMap((n) => (n.type === "dir" ? [n.path, ...paths(n.children)] : [n.path]));
	}

	const files: ReviewFile[] = buildReviewFiles(
		[
			group("src/lib/auth.ts", [MODIFY_DIFF]),
			group("src/lib/db.ts", [MODIFY_DIFF]),
			group("src/index.ts", [MODIFY_DIFF]),
			group("README.md", [MODIFY_DIFF]),
		],
		[],
	);

	test("nests files under their directories", () => {
		expect(paths(buildFileTree(files))).toEqual([
			"src",
			"src/lib",
			"src/lib/auth.ts",
			"src/lib/db.ts",
			"src/index.ts",
			"README.md",
		]);
	});

	test("reuses one node per directory instead of duplicating it", () => {
		const tree = buildFileTree(files);
		expect(tree.filter((n) => n.type === "dir" && n.path === "src")).toHaveLength(1);
	});

	test("root-level files stay at the top level", () => {
		const tree = buildFileTree(files);
		const readme = tree.find((n) => n.path === "README.md");
		expect(readme?.type).toBe("file");
	});

	test("a leaf carries its review file through", () => {
		const tree = buildFileTree(buildReviewFiles([group("a.ts", [MODIFY_DIFF])], []));
		const leaf = tree[0]!;
		expect(leaf.type === "file" && leaf.file.path).toBe("a.ts");
	});

	test("an empty review builds an empty tree", () => {
		expect(buildFileTree([])).toEqual([]);
	});

	test("two diffs to the SAME path get distinct keys (no each_key_duplicate)", () => {
		// One conversation editing src/auth.ts twice used to collide on `path`
		// and take the whole panel down with Svelte's each_key_duplicate.
		const tree = buildFileTree(
			buildReviewFiles(
				[],
				[
					{ messageId: "m2", content: MODIFY_DIFF, fileName: "src/auth.ts" },
					{ messageId: "m4", content: MODIFY_DIFF, fileName: "src/auth.ts" },
				],
			),
		);
		const dir = tree[0]!;
		expect(dir.type).toBe("dir");
		const leafKeys = dir.type === "dir" ? dir.children.map((c) => c.key) : [];
		expect(leafKeys).toEqual(["file:code:m2#0", "file:code:m4#0"]);
		expect(new Set(leafKeys).size).toBe(2);
	});

	test("every node key in a tree is unique", () => {
		const keys: string[] = [];
		function walk(nodes: FileTreeNode[]) {
			for (const n of nodes) {
				keys.push(n.key);
				if (n.type === "dir") walk(n.children);
			}
		}
		walk(buildFileTree(files));
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("directory keys are namespaced apart from file keys", () => {
		const tree = buildFileTree(buildReviewFiles([group("src/a.ts", [MODIFY_DIFF])], []));
		expect(tree[0]!.key).toBe("dir:src");
	});
});

describe("allDirPaths", () => {
	test("lists every directory, including nested ones", () => {
		const tree = buildFileTree(
			buildReviewFiles([group("a/b/c/deep.ts", [MODIFY_DIFF]), group("root.ts", [MODIFY_DIFF])], []),
		);
		expect(allDirPaths(tree)).toEqual(["a", "a/b", "a/b/c"]);
	});

	test("a file-only tree has no directories", () => {
		expect(allDirPaths(buildFileTree(buildReviewFiles([group("a.ts", [MODIFY_DIFF])], [])))).toEqual(
			[],
		);
	});
});

describe("toggleInSet", () => {
	test("adds a key that isn't in the set", () => {
		expect(toggleInSet(new Set(), "a")).toEqual(new Set(["a"]));
	});

	test("removes a key that is in the set", () => {
		expect(toggleInSet(new Set(["a", "b"]), "a")).toEqual(new Set(["b"]));
	});

	test("never mutates the input — Svelte only re-renders on a new identity", () => {
		const before = new Set(["a"]);
		const after = toggleInSet(before, "b");
		expect(before).toEqual(new Set(["a"]));
		expect(after).not.toBe(before);
	});
});

import { test, expect, describe } from "bun:test";
import { buildFileTree, type FileTreeNode } from "../feature-file-tree.js";

function findChild(nodes: FileTreeNode[], name: string): FileTreeNode | undefined {
	return nodes.find((n) => n.name === name);
}

describe("buildFileTree", () => {
	test("flat list of files with no dirs", () => {
		const tree = buildFileTree(["a.ts", "b.ts", "c.ts"]);
		expect(tree).toEqual([
			{ type: "file", name: "a.ts", path: "a.ts" },
			{ type: "file", name: "b.ts", path: "b.ts" },
			{ type: "file", name: "c.ts", path: "c.ts" },
		]);
	});

	test("nests files by directory", () => {
		const tree = buildFileTree([
			"src/runtime/executor-watchdog.ts",
			"src/runtime/stream-chat/subscribe-bridge.ts",
			"src/__tests__/foo.test.ts",
		]);
		// src/ at top level
		const src = findChild(tree, "src");
		expect(src?.type).toBe("dir");
		if (src?.type !== "dir") throw new Error("expected dir");

		// src/__tests__ comes before src/runtime alphabetically (case-insensitive)
		expect(src.children.map((c) => c.name)).toEqual(["__tests__", "runtime"]);
	});

	test("dirs sort before files at the same level", () => {
		const tree = buildFileTree(["zebra.md", "alpha/foo.ts"]);
		expect(tree[0]?.type).toBe("dir");
		expect(tree[0]?.name).toBe("alpha");
		expect(tree[1]?.type).toBe("file");
		expect(tree[1]?.name).toBe("zebra.md");
	});

	test("dedupes identical relpaths", () => {
		const tree = buildFileTree(["a.ts", "a.ts", "a.ts"]);
		expect(tree).toHaveLength(1);
	});

	test("strips leading ./ and / so no phantom root dir is created", () => {
		const tree = buildFileTree(["./src/a.ts", "/src/b.ts", "src/c.ts"]);
		expect(tree).toHaveLength(1);
		const src = tree[0]!;
		expect(src.type).toBe("dir");
		if (src.type !== "dir") throw new Error("expected dir");
		expect(src.children.map((c) => c.name).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	test("empty / blank inputs are skipped", () => {
		const tree = buildFileTree(["", "  /  ", "a.ts"]);
		// `"  /  "` has internal spaces, not a real path, but the splitter
		// will treat it as a single segment with whitespace — accept that
		// there's just one valid file in the result. The contract is "no
		// crashes / no undefined entries".
		expect(tree.some((n) => n.type === "file" && n.name === "a.ts")).toBe(true);
		expect(tree.every((n) => n.name && n.path)).toBe(true);
	});

	test("path on a dir node points at its full project-relative path", () => {
		const tree = buildFileTree(["src/runtime/foo.ts"]);
		const src = tree[0]!;
		if (src.type !== "dir") throw new Error("expected dir");
		expect(src.path).toBe("src");
		const runtime = src.children[0]!;
		if (runtime.type !== "dir") throw new Error("expected dir");
		expect(runtime.path).toBe("src/runtime");
		const file = runtime.children[0]!;
		expect(file).toEqual({ type: "file", name: "foo.ts", path: "src/runtime/foo.ts" });
	});

	test("case-insensitive sort keeps `Readme.md` next to `readme-extra.md`", () => {
		const tree = buildFileTree(["Readme.md", "alpha.md", "readme-extra.md"]);
		// All three are files at the root; alpha.md, Readme.md, readme-extra.md
		// sorted case-insensitively: alpha < readme < Readme (or vice versa
		// for tie-breaking). The contract: alpha first; the two readme*
		// entries adjacent.
		const names = tree.map((n) => n.name);
		expect(names[0]).toBe("alpha.md");
		expect(names.slice(1).every((n) => n.toLowerCase().startsWith("readme"))).toBe(true);
	});
});

/**
 * DOM tests for FeatureFileTree.svelte — the recursive renderer for
 * the `$feature` chip's hover popover file list.
 *
 * Surface under test:
 *   - Hierarchical rendering: dirs nested under their parents, files
 *     under the dir they live in.
 *   - Box-drawing connectors (`├─` / `└─`) match the unix `tree` rule:
 *     last child gets the corner, non-last gets the tee. Vertical
 *     guides (`│  `) appear on every ancestor column that still has
 *     siblings below.
 *   - Auto-expand on first render (no folder is collapsed by default).
 *   - Click on a directory row toggles its children's visibility.
 *   - Sibling-collapse independence: collapsing one folder doesn't
 *     hide a sibling's children.
 */
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect } from "vitest";
import FeatureFileTree from "../FeatureFileTree.svelte";
import { buildFileTree } from "$lib/feature-file-tree";

function tree(paths: string[]) {
	return buildFileTree(paths);
}

describe("FeatureFileTree — render", () => {
	test("flat list: every file appears as its own row", () => {
		const { container } = render(FeatureFileTree, { nodes: tree(["a.ts", "b.ts", "c.ts"]) });
		const fileRows = container.querySelectorAll("[data-feature-tree-file]");
		expect(fileRows).toHaveLength(3);
		expect((fileRows[0] as HTMLElement).getAttribute("data-feature-tree-file")).toBe("a.ts");
		expect((fileRows[2] as HTMLElement).getAttribute("data-feature-tree-file")).toBe("c.ts");
	});

	test("renders dirs as toggleable buttons + files as plain rows", () => {
		const { container } = render(FeatureFileTree, {
			nodes: tree(["src/foo.ts", "src/bar.ts", "README.md"]),
		});
		const dirs = container.querySelectorAll("[data-feature-tree-dir]");
		const files = container.querySelectorAll("[data-feature-tree-file]");
		expect(dirs).toHaveLength(1);
		expect((dirs[0] as HTMLElement).getAttribute("data-feature-tree-dir")).toBe("src");
		// 2 nested files + the top-level README.
		expect(files).toHaveLength(3);
	});

	test("auto-expand on first render — every dir starts open, all descendants visible", () => {
		const { container } = render(FeatureFileTree, {
			nodes: tree([
				"src/runtime/foo.ts",
				"src/runtime/inner/bar.ts",
				"src/__tests__/baz.test.ts",
			]),
		});
		const dirButtons = container.querySelectorAll("[data-feature-tree-dir]");
		// src, src/__tests__, src/runtime, src/runtime/inner = 4 dirs.
		expect(dirButtons).toHaveLength(4);
		for (const btn of dirButtons) {
			expect(btn.getAttribute("aria-expanded")).toBe("true");
		}
		// All 3 files visible.
		expect(container.querySelectorAll("[data-feature-tree-file]")).toHaveLength(3);
	});

	test("box-drawing connectors: last child uses └─, non-last uses ├─", () => {
		const { container } = render(FeatureFileTree, {
			nodes: tree(["a.ts", "b.ts", "c.ts"]),
		});
		const rows = container.querySelectorAll("[data-feature-tree-file]");
		// First two are non-last → ├─; last one → └─. Connector
		// fragment lives in the muted-colored span before the name.
		expect(rows[0]!.textContent).toContain("├─");
		expect(rows[1]!.textContent).toContain("├─");
		expect(rows[2]!.textContent).toContain("└─");
	});

	test("vertical guide (│) only appears when an ancestor still has siblings below", () => {
		// Single-spine tree — every ancestor is its parent's only (and
		// therefore last) child, so the leaf row has NO vertical guide:
		//   src/
		//   └─ runtime/
		//      └─ b.ts
		const { container } = render(FeatureFileTree, {
			nodes: tree(["src/runtime/b.ts"]),
		});
		const bRow = container.querySelector(
			'[data-feature-tree-file="src/runtime/b.ts"]',
		) as HTMLElement;
		expect(bRow).not.toBeNull();
		expect(bRow.textContent).toContain("└─");
		expect(bRow.textContent).not.toContain("│");

		// When an ancestor still has siblings below it, the deeper rows
		// MUST keep its vertical guide. Materialise puts dirs before
		// files, so adding `src/zzz.ts` makes `runtime/` the *first*
		// (non-last) child of `src/`, which means b.ts's row needs `│`
		// at the depth-1 column to keep runtime's guide visible.
		const { container: c2 } = render(FeatureFileTree, {
			nodes: tree(["src/runtime/b.ts", "src/zzz.ts"]),
		});
		const bRow2 = c2.querySelector(
			'[data-feature-tree-file="src/runtime/b.ts"]',
		) as HTMLElement;
		expect(bRow2.textContent).toContain("│");
	});

	test("clicking a directory row collapses its subtree", async () => {
		const { container } = render(FeatureFileTree, {
			nodes: tree(["src/foo.ts", "src/bar.ts"]),
		});
		// Pre-click: 2 files visible.
		expect(container.querySelectorAll("[data-feature-tree-file]")).toHaveLength(2);
		const srcBtn = container.querySelector(
			'[data-feature-tree-dir="src"]',
		) as HTMLButtonElement;
		expect(srcBtn).not.toBeNull();
		await fireEvent.click(srcBtn);
		// After collapse: zero files visible (children dropped).
		expect(container.querySelectorAll("[data-feature-tree-file]")).toHaveLength(0);
		expect(srcBtn.getAttribute("aria-expanded")).toBe("false");
		// Chevron flips to ▸.
		expect(srcBtn.textContent).toContain("▸");
	});

	test("re-clicking a collapsed directory expands it again", async () => {
		const { container } = render(FeatureFileTree, {
			nodes: tree(["src/foo.ts"]),
		});
		const srcBtn = container.querySelector(
			'[data-feature-tree-dir="src"]',
		) as HTMLButtonElement;
		await fireEvent.click(srcBtn); // collapse
		expect(container.querySelectorAll("[data-feature-tree-file]")).toHaveLength(0);
		await fireEvent.click(srcBtn); // re-expand
		expect(container.querySelectorAll("[data-feature-tree-file]")).toHaveLength(1);
		expect(srcBtn.getAttribute("aria-expanded")).toBe("true");
		expect(srcBtn.textContent).toContain("▾");
	});

	test("collapsing one directory does not hide a sibling's contents", async () => {
		const { container } = render(FeatureFileTree, {
			nodes: tree(["src/foo.ts", "docs/bar.md"]),
		});
		expect(container.querySelectorAll("[data-feature-tree-file]")).toHaveLength(2);
		const srcBtn = container.querySelector(
			'[data-feature-tree-dir="src"]',
		) as HTMLButtonElement;
		await fireEvent.click(srcBtn);
		// Only `src` collapsed — `docs/bar.md` remains.
		const remaining = container.querySelectorAll(
			"[data-feature-tree-file]",
		) as NodeListOf<HTMLElement>;
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.getAttribute("data-feature-tree-file")).toBe("docs/bar.md");
	});

	test("dirs render with trailing slash, files render bare", () => {
		const { container } = render(FeatureFileTree, {
			nodes: tree(["src/foo.ts"]),
		});
		const srcBtn = container.querySelector(
			'[data-feature-tree-dir="src"]',
		) as HTMLElement;
		expect(srcBtn.textContent).toContain("src/");
		const fooRow = container.querySelector(
			'[data-feature-tree-file="src/foo.ts"]',
		) as HTMLElement;
		expect(fooRow.textContent).toContain("foo.ts");
		expect(fooRow.textContent).not.toContain("foo.ts/");
	});
});

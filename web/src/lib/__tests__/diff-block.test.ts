import { parseHTML } from "linkedom";
import { test, expect, describe, beforeEach } from "bun:test";
import { renderMarkdown } from "../markdown";

/**
 * Integration tests for diff block rendering and click handler behavior.
 * Tests the HTML output from renderMarkdown and simulates the click handlers
 * that MarkdownRenderer.svelte attaches.
 */

const { document: doc } = parseHTML("<!DOCTYPE html><html><body></body></html>");

// Simulate the click handlers from MarkdownRenderer.svelte
function attachDiffHandlers(container: any) {
	container.addEventListener("click", (e: any) => {
		const target = e.target;

		const toggleBtn = target.closest(".diff-toggle-btn");
		if (toggleBtn) {
			const diffContainer = toggleBtn.closest(".diff-container");
			if (!diffContainer) return;
			const current = diffContainer.getAttribute("data-view");
			const sideView = diffContainer.querySelector(".diff-view-side");
			const unifiedView = diffContainer.querySelector(".diff-view-unified");
			if (current === "side-by-side") {
				diffContainer.setAttribute("data-view", "unified");
				if (sideView) sideView.style.display = "none";
				if (unifiedView) unifiedView.style.display = "";
				toggleBtn.textContent = "Side-by-side";
			} else {
				diffContainer.setAttribute("data-view", "side-by-side");
				if (sideView) sideView.style.display = "";
				if (unifiedView) unifiedView.style.display = "none";
				toggleBtn.textContent = "Unified";
			}
			return;
		}

		const fileToggle = target.closest(".diff-file-toggle");
		if (fileToggle) {
			const fileSection = fileToggle.closest(".diff-file-section");
			if (!fileSection) return;
			const expanded = fileSection.getAttribute("data-expanded") === "true";
			fileSection.setAttribute("data-expanded", expanded ? "false" : "true");
			const body = fileSection.querySelector(".diff-file-body");
			if (body) body.style.display = expanded ? "none" : "";
		}
	});
}

function renderDiff(md: string): any {
	const html = renderMarkdown(md, false);
	const container = doc.createElement("div");
	container.innerHTML = html;
	attachDiffHandlers(container);
	return container;
}

const SINGLE_FILE_DIFF = `\`\`\`diff
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,3 @@
 export function greet(name: string) {
-  return "hello " + name;
+  return \`Hello, \${name}!\`;
 }
\`\`\``;

const MULTI_FILE_DIFF = `\`\`\`diff
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,3 +10,5 @@
 export function login(user: string) {
-  return false;
+  const token = generateToken(user);
+  setSession(token);
+  return true;
 }
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,2 +1,3 @@
 export const PORT = 3000;
+export const SECRET = "abc123";
\`\`\``;

const AUTO_DETECT_DIFF = `\`\`\`
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
-const old = true;
+const updated = true;
\`\`\``;

describe("Diff block integration", () => {
	beforeEach(() => {
		doc.body.innerHTML = "";
	});

	describe("toggle switches view (DIFF-05)", () => {
		test("initial state is side-by-side", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			const container = el.querySelector(".diff-container")!;
			expect(container.getAttribute("data-view")).toBe("side-by-side");
			expect((el.querySelector(".diff-view-unified") as HTMLElement).style.display).toBe("none");
		});

		test("clicking toggle switches to unified", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			const btn = el.querySelector(".diff-toggle-btn") as HTMLElement;
			btn.click();

			const container = el.querySelector(".diff-container")!;
			expect(container.getAttribute("data-view")).toBe("unified");
			expect((el.querySelector(".diff-view-side") as HTMLElement).style.display).toBe("none");
			expect((el.querySelector(".diff-view-unified") as HTMLElement).style.display).toBe("");
			expect(btn.textContent).toBe("Side-by-side");
		});

		test("clicking toggle twice returns to side-by-side", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			const btn = el.querySelector(".diff-toggle-btn") as HTMLElement;
			btn.click();
			btn.click();

			const container = el.querySelector(".diff-container")!;
			expect(container.getAttribute("data-view")).toBe("side-by-side");
			expect((el.querySelector(".diff-view-side") as HTMLElement).style.display).toBe("");
			expect((el.querySelector(".diff-view-unified") as HTMLElement).style.display).toBe("none");
			expect(btn.textContent).toBe("Unified");
		});
	});

	describe("file collapse/expand (DIFF-06)", () => {
		test("first file is expanded, second is collapsed in multi-file diff", () => {
			const el = renderDiff(MULTI_FILE_DIFF);
			const sections = el.querySelectorAll(".diff-file-section");
			expect(sections.length).toBe(2);
			expect(sections[0].getAttribute("data-expanded")).toBe("true");
			expect(sections[1].getAttribute("data-expanded")).toBe("false");
			expect((sections[1].querySelector(".diff-file-body") as HTMLElement).style.display).toBe("none");
		});

		test("clicking collapsed file expands it", () => {
			const el = renderDiff(MULTI_FILE_DIFF);
			const secondToggle = el.querySelectorAll(".diff-file-toggle")[1] as HTMLElement;
			secondToggle.click();

			const secondSection = el.querySelectorAll(".diff-file-section")[1];
			expect(secondSection.getAttribute("data-expanded")).toBe("true");
			expect((secondSection.querySelector(".diff-file-body") as HTMLElement).style.display).toBe("");
		});

		test("clicking expanded file collapses it", () => {
			const el = renderDiff(MULTI_FILE_DIFF);
			const firstToggle = el.querySelectorAll(".diff-file-toggle")[0] as HTMLElement;
			firstToggle.click();

			const firstSection = el.querySelectorAll(".diff-file-section")[0];
			expect(firstSection.getAttribute("data-expanded")).toBe("false");
			expect((firstSection.querySelector(".diff-file-body") as HTMLElement).style.display).toBe("none");
		});

		test("double-click restores original state", () => {
			const el = renderDiff(MULTI_FILE_DIFF);
			const secondToggle = el.querySelectorAll(".diff-file-toggle")[1] as HTMLElement;
			secondToggle.click();
			secondToggle.click();

			const secondSection = el.querySelectorAll(".diff-file-section")[1];
			expect(secondSection.getAttribute("data-expanded")).toBe("false");
			expect((secondSection.querySelector(".diff-file-body") as HTMLElement).style.display).toBe("none");
		});
	});

	describe("file stat rendering (DIFF-07)", () => {
		test("displays addition and deletion counts", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			const additions = el.querySelector(".diff-additions");
			const deletions = el.querySelector(".diff-deletions");
			expect(additions).not.toBeNull();
			expect(deletions).not.toBeNull();
			expect(additions!.textContent).toContain("+");
			expect(deletions!.textContent).toContain("-");
		});

		test("stats appear inside file toggle buttons", () => {
			const el = renderDiff(MULTI_FILE_DIFF);
			const toggles = el.querySelectorAll(".diff-file-toggle");
			for (const toggle of toggles) {
				expect(toggle.querySelector(".diff-additions")).not.toBeNull();
				expect(toggle.querySelector(".diff-deletions")).not.toBeNull();
			}
		});

		test("multi-file diff shows correct per-file stats", () => {
			const el = renderDiff(MULTI_FILE_DIFF);
			const toggles = el.querySelectorAll(".diff-file-toggle");
			// First file: auth.ts - 3 additions, 1 deletion
			expect(toggles[0].querySelector(".diff-additions")!.textContent).toBe("+3");
			expect(toggles[0].querySelector(".diff-deletions")!.textContent).toBe("-1");
			// Second file: config.ts - 1 addition, 0 deletions
			expect(toggles[1].querySelector(".diff-additions")!.textContent).toBe("+1");
			expect(toggles[1].querySelector(".diff-deletions")!.textContent).toBe("-0");
		});
	});

	describe("edge cases", () => {
		test("single-file diff renders without crashing", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			expect(el.querySelector(".diff-container")).not.toBeNull();
			expect(el.querySelectorAll(".diff-file-section").length).toBe(1);
		});

		test("auto-detected diff (no lang tag) renders as diff container", () => {
			const el = renderDiff(AUTO_DETECT_DIFF);
			expect(el.querySelector(".diff-container")).not.toBeNull();
			expect(el.querySelector(".diff-toggle-btn")).not.toBeNull();
		});

		test("empty diff does not crash", () => {
			const md = "```diff\n```";
			const el = renderDiff(md);
			// Should render something (possibly a container with unknown file)
			expect(el.querySelector(".diff-container")).not.toBeNull();
		});
	});

	describe("multiple diff blocks in one message", () => {
		const TWO_DIFFS = `Here is diff one:

\`\`\`diff
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
\`\`\`

And diff two:

\`\`\`diff
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -1,2 +1,2 @@
-const b = 1;
+const b = 2;
\`\`\``;

		test("renders two separate diff containers", () => {
			const el = renderDiff(TWO_DIFFS);
			const containers = el.querySelectorAll(".diff-container");
			expect(containers.length).toBe(2);
		});

		test("toggling one diff does not affect the other", () => {
			const el = renderDiff(TWO_DIFFS);
			const toggles = el.querySelectorAll(".diff-toggle-btn") as NodeListOf<HTMLElement>;
			expect(toggles.length).toBe(2);

			// Toggle first diff to unified
			toggles[0].click();
			const containers = el.querySelectorAll(".diff-container");
			expect(containers[0].getAttribute("data-view")).toBe("unified");
			expect(containers[1].getAttribute("data-view")).toBe("side-by-side");
		});
	});

	describe("diff mixed with regular markdown", () => {
		const MIXED_CONTENT = `# Heading

Some text before.

\`\`\`diff
--- a/src/mixed.ts
+++ b/src/mixed.ts
@@ -1,2 +1,2 @@
-old line
+new line
\`\`\`

\`\`\`js
const regular = true;
\`\`\``;

		test("diff container and code block both render", () => {
			const el = renderDiff(MIXED_CONTENT);
			expect(el.querySelector(".diff-container")).not.toBeNull();
			expect(el.querySelector(".code-block-wrapper")).not.toBeNull();
		});

		test("heading and text render alongside diff", () => {
			const el = renderDiff(MIXED_CONTENT);
			expect(el.innerHTML).toContain("Heading");
			expect(el.innerHTML).toContain("Some text before");
		});
	});

	describe("rapid toggle clicking", () => {
		test("rapid toggle clicks settle to correct final state", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			const btn = el.querySelector(".diff-toggle-btn") as HTMLElement;
			// Click 5 times rapidly (odd = unified)
			for (let i = 0; i < 5; i++) btn.click();
			const container = el.querySelector(".diff-container")!;
			expect(container.getAttribute("data-view")).toBe("unified");
			expect(btn.textContent).toBe("Side-by-side");
		});

		test("rapid file toggle clicks settle correctly", () => {
			const el = renderDiff(MULTI_FILE_DIFF);
			const toggle = el.querySelectorAll(".diff-file-toggle")[1] as HTMLElement;
			// Click 4 times (even = back to original collapsed)
			for (let i = 0; i < 4; i++) toggle.click();
			const section = el.querySelectorAll(".diff-file-section")[1];
			expect(section.getAttribute("data-expanded")).toBe("false");
		});
	});

	describe("single-file diff specifics", () => {
		test("single-file diff has exactly one file section that is expanded", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			const sections = el.querySelectorAll(".diff-file-section");
			expect(sections.length).toBe(1);
			expect(sections[0].getAttribute("data-expanded")).toBe("true");
		});

		test("file name appears in toggle button", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			const toggle = el.querySelector(".diff-file-toggle")!;
			expect(toggle.textContent).toContain("src/utils.ts");
		});
	});

	describe("combined interactions", () => {
		test("toggle view then collapse file — both states independent", () => {
			const el = renderDiff(MULTI_FILE_DIFF);
			// Switch to unified
			const toggleBtn = el.querySelector(".diff-toggle-btn") as HTMLElement;
			toggleBtn.click();
			expect(el.querySelector(".diff-container")!.getAttribute("data-view")).toBe("unified");

			// Collapse first file
			const fileToggle = el.querySelectorAll(".diff-file-toggle")[0] as HTMLElement;
			fileToggle.click();
			expect(el.querySelectorAll(".diff-file-section")[0].getAttribute("data-expanded")).toBe("false");

			// View should still be unified
			expect(el.querySelector(".diff-container")!.getAttribute("data-view")).toBe("unified");
		});

		test("collapse all files then expand second", () => {
			const el = renderDiff(MULTI_FILE_DIFF);
			const toggles = el.querySelectorAll(".diff-file-toggle") as NodeListOf<HTMLElement>;
			// Collapse first (already expanded)
			toggles[0].click();
			expect(el.querySelectorAll(".diff-file-section")[0].getAttribute("data-expanded")).toBe("false");
			expect(el.querySelectorAll(".diff-file-section")[1].getAttribute("data-expanded")).toBe("false");

			// Expand second
			toggles[1].click();
			expect(el.querySelectorAll(".diff-file-section")[0].getAttribute("data-expanded")).toBe("false");
			expect(el.querySelectorAll(".diff-file-section")[1].getAttribute("data-expanded")).toBe("true");
		});
	});

	describe("file name display for edge cases", () => {
		test("deleted file shows old name in toggle", () => {
			const md = `\`\`\`diff
--- a/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const x = 1;
-const y = 2;
\`\`\``;
			const el = renderDiff(md);
			const toggle = el.querySelector(".diff-file-toggle")!;
			expect(toggle.textContent).toContain("removed.ts");
		});

		test("new file shows new name in toggle", () => {
			const md = `\`\`\`diff
--- /dev/null
+++ b/brand-new.ts
@@ -0,0 +1,2 @@
+const a = 1;
+const b = 2;
\`\`\``;
			const el = renderDiff(md);
			const toggle = el.querySelector(".diff-file-toggle")!;
			expect(toggle.textContent).toContain("brand-new.ts");
		});

		test("new file stats show additions only", () => {
			const md = `\`\`\`diff
--- /dev/null
+++ b/brand-new.ts
@@ -0,0 +1,2 @@
+const a = 1;
+const b = 2;
\`\`\``;
			const el = renderDiff(md);
			expect(el.querySelector(".diff-additions")!.textContent).toBe("+2");
			expect(el.querySelector(".diff-deletions")!.textContent).toBe("-0");
		});
	});

	describe("auto-detected diff interactions", () => {
		test("auto-detected diff supports view toggle", () => {
			const el = renderDiff(AUTO_DETECT_DIFF);
			const btn = el.querySelector(".diff-toggle-btn") as HTMLElement;
			btn.click();
			expect(el.querySelector(".diff-container")!.getAttribute("data-view")).toBe("unified");
		});

		test("auto-detected diff supports file collapse", () => {
			const el = renderDiff(AUTO_DETECT_DIFF);
			const fileToggle = el.querySelector(".diff-file-toggle") as HTMLElement;
			fileToggle.click();
			expect(el.querySelector(".diff-file-section")!.getAttribute("data-expanded")).toBe("false");
		});
	});

	describe("structural integrity", () => {
		test("diff-header contains toggle button", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			const header = el.querySelector(".diff-header");
			expect(header).not.toBeNull();
			expect(header!.querySelector(".diff-toggle-btn")).not.toBeNull();
		});

		test("diff-file-body is inside diff-file-section", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			const section = el.querySelector(".diff-file-section")!;
			expect(section.querySelector(".diff-file-body")).not.toBeNull();
		});

		test("both view containers exist in every diff", () => {
			const el = renderDiff(SINGLE_FILE_DIFF);
			expect(el.querySelector(".diff-view-side")).not.toBeNull();
			expect(el.querySelector(".diff-view-unified")).not.toBeNull();
		});
	});
});

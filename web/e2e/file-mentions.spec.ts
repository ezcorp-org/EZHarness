import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeAgent } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-file", name: "File Mention Project" });
const conv = makeConversation({ id: "conv-file", projectId: "proj-file" });

const agents = [makeAgent({ name: "Code Assistant", description: "Helps write code" })];
const extensions = [{ name: "analyzer", description: "Code analysis", enabled: true }];

const files = [
	{ name: "README.md", description: "/tmp/proj/README.md", kind: "file" as const },
	{ name: "foo.ts", description: "/tmp/proj/foo.ts", kind: "file" as const },
	{ name: "wrapper.ts", description: "/tmp/proj/wrapper.ts", kind: "file" as const },
	{ name: "src/app.ts", description: "/tmp/proj/src/app.ts", kind: "file" as const },
	{ name: "src/utils.ts", description: "/tmp/proj/src/utils.ts", kind: "file" as const },
	// Deeply nested file used to exercise the `folder/.../filename` middle
	// truncation in the popover display.
	{
		name: "src/nested/inner/leaf.ts",
		description: "/tmp/proj/src/nested/inner/leaf.ts",
		kind: "file" as const,
	},
	// Folder entries — both the root-level folder AND a nested folder are
	// selectable as path targets.
	{ name: "src", description: "/tmp/proj/src", kind: "dir" as const },
	{ name: "src/nested", description: "/tmp/proj/src/nested", kind: "dir" as const },
	{ name: "output", description: "/tmp/proj/output", kind: "dir" as const },
];

async function setupAndFocus(page: any, mockApi: any) {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [],
		agents,
		extensions,
		files,
	});

	// The active-project store persists to localStorage. Seed it so the
	// PanelChatInput passes `projectId` to the mention-search endpoint.
	await page.addInitScript((id: string) => {
		try {
			localStorage.setItem("activeProjectId", id);
		} catch {
			/* no-op */
		}
	}, proj.id);

	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

	const textarea = page.locator("textarea");
	await page.waitForFunction(() => {
		const listeners = (window as any).__fakeWsListeners;
		if (listeners?.open) {
			for (const fn of listeners.open) {
				try { fn(new Event("open")); } catch {}
			}
		}
		const ta = document.querySelector("textarea");
		return ta && !(ta as HTMLTextAreaElement).disabled;
	}, { timeout: 5000 });
	await expect(textarea).toBeEnabled({ timeout: 5000 });
	await page.waitForTimeout(100);
	await textarea.click();
	return textarea;
}

async function typeIntoTextarea(page: any, textarea: any, text: string) {
	await textarea.focus();
	await textarea.pressSequentially(text, { delay: 50 });
	await page.waitForTimeout(350);
}

async function waitForPopover(page: any) {
	await expect(page.locator("#mention-listbox")).toBeVisible({ timeout: 5000 });
}

test.describe("File Mentions (@ sigil)", () => {
	test("typing @ opens the file popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@");
		await waitForPopover(page);
		// The Files group header should render because the popover is file-only.
		await expect(page.locator("#mention-listbox").getByText("Files")).toBeVisible({ timeout: 3000 });
	});

	test("file popover lists project root files and one-level-deep files", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox.getByText("README.md", { exact: true })).toBeVisible({ timeout: 3000 });
		await expect(listbox.getByText("foo.ts", { exact: true })).toBeVisible();
		await expect(listbox.getByText("src/app.ts", { exact: true })).toBeVisible();
	});

	test("@ popover does NOT show agent/ext/team results", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		// None of these group headings should appear when @ is active.
		await expect(listbox.getByText("Agents")).not.toBeVisible();
		await expect(listbox.getByText("Extensions")).not.toBeVisible();
		await expect(listbox.getByText("Teams")).not.toBeVisible();
		// And the agent/ext fixtures must not be visible as items.
		await expect(listbox.getByText("Code Assistant")).not.toBeVisible();
		await expect(listbox.getByText("analyzer")).not.toBeVisible();
	});

	test("typing @src filters the file list", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@src");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox.getByText("src/app.ts", { exact: true })).toBeVisible({ timeout: 3000 });
		await expect(listbox.getByText("src/utils.ts", { exact: true })).toBeVisible();
		await expect(listbox.getByText("README.md", { exact: true })).not.toBeVisible();
		await expect(listbox.getByText("foo.ts", { exact: true })).not.toBeVisible();
	});

	test("Enter inserts @[file:…] token into textarea", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@app");
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("src/app.ts", { exact: true })).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");
		await expect(page.locator("#mention-listbox")).not.toBeVisible();
		await expect(textarea).toHaveValue(/^@app\.ts\s+$/);
	});

	test("file chip has green styling and displays basename", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@app");
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("src/app.ts", { exact: true })).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");
		// Overlay chip shows @{basename} and carries the green color classes.
		const chip = page.locator(".chat-textarea-overlay [data-mention-kind=\"file\"]");
		await expect(chip).toBeVisible({ timeout: 3000 });
		await expect(chip).toHaveClass(/green/);
	});

	test("Escape dismisses the file popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@");
		await waitForPopover(page);
		await page.keyboard.press("Escape");
		await expect(page.locator("#mention-listbox")).not.toBeVisible();
	});

	test("! trigger opens the non-file popover even after a file chip", async ({ page, mockApi }) => {
		// Insert a file chip, then verify `!` still opens agent/ext/team flow.
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@READ");
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("README.md", { exact: true })).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");
		await expect(textarea).toHaveValue(/^@README\.md\s+$/);

		// Now type an ! trigger
		await typeIntoTextarea(page, textarea, "!co");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox.getByText("Code Assistant")).toBeVisible({ timeout: 3000 });
		// No Files heading on this popover
		await expect(listbox.getByText("Files")).not.toBeVisible();
	});

	test("no matches shows empty state for file search", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@zzzznonexistent");
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("No matches found")).toBeVisible({ timeout: 3000 });
	});

	test("deleting the @ trigger closes the file popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@sr");
		await waitForPopover(page);
		// Backspace through the query and sigil — popover must go away.
		await page.keyboard.press("Backspace");
		await page.keyboard.press("Backspace");
		await page.keyboard.press("Backspace");
		await expect(page.locator("#mention-listbox")).not.toBeVisible();
	});

	test("fuzzy ranking surfaces boundary-match above interior match", async ({ page, mockApi }) => {
		// Both `src/app.ts` and `wrapper.ts` match "app" — src/app.ts matches
		// at a word boundary (`/`), wrapper.ts only in the interior. The
		// fixture mock uses substring matching for simplicity but the REAL
		// API (covered in the route-level test) fuzzy-ranks the first above
		// the second. This e2e guards the DOM rendering of both entries.
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@app");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox.getByText("src/app.ts", { exact: true })).toBeVisible({ timeout: 3000 });
		await expect(listbox.getByText("wrapper.ts", { exact: true })).toBeVisible();
	});

	test("fuzzy subsequence: non-contiguous query 'sapp' surfaces src/app.ts", async ({ page, mockApi }) => {
		// `sapp` is NOT a substring of `src/app.ts` but IS a subsequence.
		// The mock now mirrors the real route's fuzzy scorer, so this must
		// still surface the file.
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@sapp");
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("src/app.ts", { exact: true })).toBeVisible({ timeout: 3000 });
	});

	// ── Folder (dir) mentions ────────────────────────────────────────

	test("popover includes a Folders group when dirs are in the results", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@");
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Folders")).toBeVisible({ timeout: 3000 });
	});

	test("folder entries render with trailing slash in popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		// Root-level folder `src` should render as `src/` with the UI trailing slash.
		await expect(listbox.getByText("src/", { exact: true })).toBeVisible({ timeout: 3000 });
	});

	test("selecting a folder inserts @[dir:…] token", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		// Use a query that uniquely identifies the folder (no file named "output")
		await typeIntoTextarea(page, textarea, "@output");
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("output/", { exact: true })).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("Enter");
		await expect(page.locator("#mention-listbox")).not.toBeVisible();
		await expect(textarea).toHaveValue(/@\[dir:output\] /);
	});

	test("dir chip has amber styling (distinct from file green)", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@output");
		await waitForPopover(page);
		await page.keyboard.press("Enter");
		const chip = page.locator("[aria-hidden='true'] span").filter({ hasText: "@output/" });
		await expect(chip).toBeVisible({ timeout: 3000 });
		await expect(chip).toHaveClass(/amber/);
	});

	test("mixed result set: typing @src surfaces both src/ folder and src/app.ts file", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@src");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		// Folder in the Folders section
		await expect(listbox.getByText("src/", { exact: true })).toBeVisible({ timeout: 3000 });
		// Files under src/ in the Files section
		await expect(listbox.getByText("src/app.ts", { exact: true })).toBeVisible();
		await expect(listbox.getByText("src/utils.ts", { exact: true })).toBeVisible();
	});

	test("nested folder src/nested is surfaced when fuzzy-queried by its full path", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@nested");
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("src/nested/", { exact: true })).toBeVisible({ timeout: 3000 });
	});

	// ── Folder-tree walking (descent) ─────────────────────────────────

	test("selecting a folder descends: textarea becomes @path/ and popover refreshes with its contents", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@src");
		await waitForPopover(page);
		// Highlight the src/ folder entry and press Enter — should descend.
		await page.locator("#mention-listbox").getByText("src/", { exact: true }).click();
		// Textarea now has @src/
		await expect(textarea).toHaveValue(/@src\//);
		// Popover stays open (descended view) and shows contents of src/
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox.getByText("src/app.ts", { exact: true })).toBeVisible({ timeout: 3000 });
		await expect(listbox.getByText("src/utils.ts", { exact: true })).toBeVisible();
		await expect(listbox.getByText("src/nested/", { exact: true })).toBeVisible();
	});

	test("descended view surfaces synthetic 'Use this folder as path' entry at the top", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@src/");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		// Synthetic entry label
		await expect(listbox.getByText("Use this folder as path", { exact: false })).toBeVisible({ timeout: 3000 });
	});

	test("selecting the synthetic 'Use this folder' entry commits @[dir:…]", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@src/");
		await waitForPopover(page);
		// The synthetic entry is index 0; Enter should commit.
		await page.keyboard.press("Enter");
		await expect(page.locator("#mention-listbox")).not.toBeVisible();
		await expect(textarea).toHaveValue(/^@src\/\s+$/);
	});

	test("selecting a file inside descended view commits @[file:…] with full path", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@src/");
		await waitForPopover(page);
		await page.locator("#mention-listbox").getByText("src/app.ts", { exact: true }).click();
		await expect(page.locator("#mention-listbox")).not.toBeVisible();
		await expect(textarea).toHaveValue(/^@app\.ts\s+$/);
	});

	test("selecting a subfolder inside descended view descends further", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@src/");
		await waitForPopover(page);
		await page.locator("#mention-listbox").getByText("src/nested/", { exact: true }).click();
		// Textarea now has @src/nested/
		await expect(textarea).toHaveValue(/@src\/nested\//);
		// Popover shows synthetic entry and contents of src/nested/
		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Use this folder as path", { exact: false })).toBeVisible({ timeout: 3000 });
	});

	test("descent does NOT appear for non-folder-ended queries", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@src");
		await waitForPopover(page);
		// No trailing slash → no synthetic "Use this folder" entry
		await expect(page.locator("#mention-listbox").getByText("Use this folder as path", { exact: false })).not.toBeVisible();
	});

	test("typed `@src/` without pre-descending still shows synthetic entry + contents", async ({ page, mockApi }) => {
		// User manually types `@src/` (faster than click-descending)
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@src/");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox.getByText("Use this folder as path", { exact: false })).toBeVisible({ timeout: 3000 });
		await expect(listbox.getByText("src/app.ts", { exact: true })).toBeVisible();
	});

	// ── Popover path display (folder/.../filename + hover reveal) ───────

	test("deep file path renders as folder/.../filename (middle-truncated)", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@leaf");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		// `src/nested/inner/leaf.ts` has 4 segments → middle-truncates.
		await expect(listbox.getByText("src/.../leaf.ts", { exact: true })).toBeVisible({ timeout: 3000 });
		// The untruncated form must NOT appear in the primary label.
		await expect(
			listbox.locator("span.text-sm", { hasText: "src/nested/inner/leaf.ts" }),
		).toHaveCount(0);
	});

	test("short paths pass through unchanged (no ellipsis)", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@app");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		// 2-segment path → displayed in full.
		await expect(listbox.getByText("src/app.ts", { exact: true })).toBeVisible({ timeout: 3000 });
	});

	test("file entry exposes absolute path via title attribute (hover tooltip)", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@leaf");
		await waitForPopover(page);
		// The button for the leaf file should carry the absolute path in title.
		const button = page.locator("#mention-listbox button", { hasText: "src/.../leaf.ts" });
		await expect(button).toHaveAttribute("title", "/tmp/proj/src/nested/inner/leaf.ts");
	});

	test("folder entry also has hover tooltip with absolute path", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@src");
		await waitForPopover(page);
		const button = page.locator("#mention-listbox button", { hasText: "src/" });
		// First src-prefixed folder button carries its absolute path.
		await expect(button.first()).toHaveAttribute("title", /\/tmp\/proj\/src/);
	});

	test("selecting a display-truncated file still inserts the full relative path", async ({ page, mockApi }) => {
		// Visual truncation must NOT affect what gets stored — the wire token
		// must be the complete relative path so the agent can read/resolve it.
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "@leaf");
		await waitForPopover(page);
		await page.locator("#mention-listbox").getByText("src/.../leaf.ts", { exact: true }).click();
		// The textarea lays out only the compact basename…
		await expect(textarea).toHaveValue(/^@leaf\.ts\s+$/);
		// …but the committed chip carries the FULL relative path (the wire
		// token `@[file:src/nested/inner/leaf.ts]`), exposed via the chip's
		// data attribute. This is the invariant the agent depends on.
		const chip = page.locator('.chat-textarea-overlay [data-mention-kind="file"]');
		await expect(chip).toHaveAttribute("data-mention-name", "src/nested/inner/leaf.ts");
	});
});

test.describe("Regression: projectId wiring from URL", () => {
	test("typing @ on a fresh load (no localStorage) still lists files", async ({ page, mockApi }) => {
		// This scenario is what the earlier tests missed. Do NOT seed
		// localStorage.activeProjectId — rely on the `(app)/+layout.svelte`
		// $effect to sync `store.activeProjectId` from `page.params.id` on
		// navigation. If the sync is missing, `store.activeProjectId` stays
		// as "global" and `searchMentions` is called without projectId, so
		// the API short-circuits to [] and the popover says "No matches found".
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			agents,
			extensions,
			files,
		});

		// Explicitly clear the store's localStorage key to simulate a first
		// visit / cache-cleared browser.
		await page.addInitScript(() => {
			try {
				localStorage.removeItem("activeProjectId");
			} catch {
				/* no-op */
			}
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const textarea = page.locator("textarea");
		await page.waitForFunction(() => {
			const listeners = (window as any).__fakeWsListeners;
			if (listeners?.open) {
				for (const fn of listeners.open) {
					try { fn(new Event("open")); } catch {}
				}
			}
			const ta = document.querySelector("textarea");
			return ta && !(ta as HTMLTextAreaElement).disabled;
		}, { timeout: 5000 });
		await expect(textarea).toBeEnabled({ timeout: 5000 });
		await page.waitForTimeout(100);
		await textarea.click();
		await textarea.pressSequentially("@", { delay: 50 });
		await page.waitForTimeout(350);

		await expect(page.locator("#mention-listbox")).toBeVisible({ timeout: 5000 });
		await expect(page.locator("#mention-listbox").getByText("foo.ts", { exact: true })).toBeVisible({ timeout: 3000 });
	});

	test("search request URL carries projectId from route (not from store)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			agents,
			extensions,
			files,
		});

		// Intentionally seed a stale/different localStorage project to verify
		// the URL takes precedence (URL-sync wins over localStorage).
		await page.addInitScript(() => {
			try {
				localStorage.setItem("activeProjectId", "some-other-project-id");
			} catch {
				/* no-op */
			}
		});

		const requests: string[] = [];
		page.on("request", (req) => {
			if (req.url().includes("/api/mentions/search")) requests.push(req.url());
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const textarea = page.locator("textarea");
		await page.waitForFunction(() => {
			const listeners = (window as any).__fakeWsListeners;
			if (listeners?.open) {
				for (const fn of listeners.open) {
					try { fn(new Event("open")); } catch {}
				}
			}
			const ta = document.querySelector("textarea");
			return ta && !(ta as HTMLTextAreaElement).disabled;
		}, { timeout: 5000 });
		await expect(textarea).toBeEnabled({ timeout: 5000 });
		await textarea.click();
		await textarea.pressSequentially("@", { delay: 50 });
		await page.waitForTimeout(400);

		// At least one mention-search request must have included the route's
		// projectId — NOT the stale localStorage one.
		const fileReq = requests.find((u) => u.includes("type=file"));
		expect(fileReq).toBeDefined();
		expect(fileReq!).toContain(`projectId=${proj.id}`);
		expect(fileReq!).not.toContain("some-other-project-id");
	});
});

test.describe("Legacy mention compatibility", () => {
	test("historical @[agent:…] content renders as plain text (no chip)", async ({ page, mockApi }) => {
		// Seed a conversation message that contains a legacy @-sigil token.
		// Under the new grammar this must render literally, not as a styled chip.
		const { makeMessage } = await import("./fixtures/data.js");
		const legacyMsg = makeMessage({
			id: "msg-legacy",
			conversationId: conv.id,
			role: "assistant",
			content: "Hello @[agent:LegacyBot] welcome back",
			createdAt: new Date("2025-01-01T00:00:00Z").toISOString(),
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [legacyMsg],
			agents,
			extensions,
			files,
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		// The raw token text should appear literally somewhere in the rendered
		// conversation body.
		await expect(page.getByText("@[agent:LegacyBot]", { exact: false })).toBeVisible({ timeout: 5000 });
	});
});

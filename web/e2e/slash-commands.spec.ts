import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeAgent } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Slash Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

const REVIEW_BODY =
	"Review the staged diff. Flag regressions, missing tests, and risky patterns.";

const commands = [
	{
		name: "review",
		description: "Review staged changes",
		source: "project:claude-commands",
		body: REVIEW_BODY,
	},
	{ name: "deploy", description: "Deploy the current branch", source: "project:agents" },
	{ name: "commit", description: "Commit staged changes", source: "user:codex-prompts" },
];

async function setupAndFocus(page: any, mockApi: any) {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [],
		agents: [makeAgent({ name: "review", description: "DB agent named review" })],
		extensions: [],
		commands,
	});
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

	const textarea = page.locator("textarea");

	// Wait for WS + textarea enabled.
	await page.waitForFunction(() => {
		const listeners = (window as any).__fakeWsListeners;
		if (listeners?.open) {
			for (const fn of listeners.open) {
				try { fn(new Event("open")); } catch {}
			}
		}
		const ta = document.querySelector("textarea");
		return ta && !ta.disabled;
	}, { timeout: 5000 });

	await expect(textarea).toBeEnabled({ timeout: 5000 });
	await page.waitForTimeout(100);
	await textarea.click();
	return textarea;
}

async function typeInto(page: any, textarea: any, text: string) {
	await textarea.focus();
	await textarea.pressSequentially(text, { delay: 50 });
	await page.waitForTimeout(350); // match debounce (200) + reactivity
}

async function waitForPopover(page: any) {
	await expect(page.locator("#mention-listbox")).toBeVisible({ timeout: 5000 });
}

test.describe("Slash commands", () => {
	test("typing / opens the popover with the Slash commands section", async ({
		page,
		mockApi,
	}) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeInto(page, textarea, "/");

		await waitForPopover(page);
		await expect(page.locator("#mention-listbox")).toContainText("Slash commands");
		await expect(page.locator("#mention-listbox")).toContainText("/review");
		await expect(page.locator("#mention-listbox")).toContainText("/deploy");
	});

	test("type-ahead filters results fuzzily", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeInto(page, textarea, "/rev");

		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toContainText("/review");
		await expect(listbox).not.toContainText("/deploy");
	});

	test("selecting a command inserts a /[cmd:name] chip — no body injection", async ({
		page,
		mockApi,
	}) => {
		// `/` should behave like `@` / `!`: picking inserts a structured
		// token that renders as a chip via the overlay. The prompt body is
		// never injected into the textarea; server-side expansion handles
		// substitution for the LLM.
		const textarea = await setupAndFocus(page, mockApi);
		await typeInto(page, textarea, "/rev");

		await waitForPopover(page);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(150);

		await expect(page.locator("#mention-listbox")).toBeHidden();
		await expect(textarea).toHaveValue("/[cmd:review] ");
	});

	test("popover shows scope + folder badge for each command", async ({
		page,
		mockApi,
	}) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeInto(page, textarea, "/");
		await waitForPopover(page);

		const listbox = page.locator("#mention-listbox");
		// Project-scoped command — shows "Project · .claude/commands"
		const reviewRow = listbox.locator("[data-source='project:claude-commands']").first();
		await expect(reviewRow).toContainText("Project");
		await expect(reviewRow).toContainText(".claude/commands");

		// Global-scoped command — shows "Global · ~/.codex/prompts"
		const commitRow = listbox.locator("[data-source='user:codex-prompts']").first();
		await expect(commitRow).toContainText("Global");
		await expect(commitRow).toContainText("~/.codex/prompts");

		// Plain agents/ folder within project
		const deployRow = listbox.locator("[data-source='project:agents']").first();
		await expect(deployRow).toContainText("Project");
		await expect(deployRow).toContainText("agents");
	});

	test("command popover coexists with DB agent namespace — both show distinctly", async ({
		page,
		mockApi,
	}) => {
		// `/` shows slash commands including "review"; `!` shows the DB
		// agent "review" as an agent.
		const textarea = await setupAndFocus(page, mockApi);

		await typeInto(page, textarea, "/");
		await waitForPopover(page);
		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toContainText("Slash commands");
		await expect(listbox).toContainText("/review");

		await page.keyboard.press("Escape");
		await textarea.fill("");
		await page.waitForTimeout(100);

		await typeInto(page, textarea, "!rev");
		await waitForPopover(page);
		await expect(listbox).toContainText("Agents");
		await expect(listbox).not.toContainText("Slash commands");
	});

	test("submitting a /cmd + args sends the raw token to the server", async ({
		page,
		mockApi,
	}) => {
		// Client posts the RAW `/[cmd:name] args` text — server-side
		// `applyCommandExpansion` substitutes the body before calling the
		// LLM. Guards against accidental client-side expansion.
		const textarea = await setupAndFocus(page, mockApi);

		const requestPromise = page.waitForRequest(
			(req) =>
				req.url().includes(`/api/conversations/${conv.id}/messages`) &&
				req.method() === "POST",
		);

		await typeInto(page, textarea, "/rev");
		await waitForPopover(page);
		await page.keyboard.press("Enter"); // select first match (review)
		await page.waitForTimeout(100);
		await textarea.pressSequentially("fix the auth bug", { delay: 30 });
		await page.waitForTimeout(150);
		await page.keyboard.press("Enter"); // submit

		const req = await requestPromise;
		const body = req.postDataJSON();
		expect(body.content).toContain("/[cmd:review]");
		expect(body.content).toContain("fix the auth bug");
	});

	test("hovering a /cmd chip in the chat history reveals the prompt body", async ({
		page,
		mockApi,
	}) => {
		// The chat-history chip is the same MentionChip used by the
		// composer overlay — for `kind === 'command'` it lazily fetches
		// the prompt body on first hover and shows it in a popover, so
		// readers can peek what the LLM actually received.
		const textarea = await setupAndFocus(page, mockApi);

		await typeInto(page, textarea, "/rev");
		await waitForPopover(page);
		await page.keyboard.press("Enter"); // insert /[cmd:review] token
		await page.waitForTimeout(100);
		await page.keyboard.press("Enter"); // submit
		await page.waitForTimeout(400);

		// After submit the composer resets, so the only remaining command
		// chip for `/review` is the one rendered in the chat-history bubble.
		const chip = page.locator(
			"[data-mention-kind='command'][data-mention-name='review']",
		).first();
		await expect(chip).toBeVisible({ timeout: 5000 });

		// Hover → popover loads the body lazily and displays it.
		await chip.hover();
		const popover = page.locator("[data-command-popover='review']");
		await expect(popover).toBeVisible({ timeout: 3000 });
		await expect(popover).toContainText(REVIEW_BODY, { timeout: 3000 });
		await expect(popover).toContainText("Prompt sent for /review");

		// Mouseleave hides it again.
		await page.mouse.move(0, 0);
		await expect(popover).toBeHidden({ timeout: 2000 });
	});

	test("popover renders above the chip when there's room above it", async ({
		page,
		mockApi,
	}) => {
		// Push the chip well down the viewport by injecting top padding
		// on <body> so `rect.top` is comfortably larger than the flip
		// threshold. The popover must render above.
		const textarea = await setupAndFocus(page, mockApi);

		await typeInto(page, textarea, "/rev");
		await waitForPopover(page);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(100);
		await page.keyboard.press("Enter"); // submit
		await page.waitForTimeout(400);

		const chip = page.locator(
			"[data-mention-kind='command'][data-mention-name='review']",
		).first();
		await expect(chip).toBeVisible();

		// Inject ~600px of space above everything so the chip's rect.top
		// is well past the 360px flip threshold.
		await page.evaluate(() => {
			document.body.style.paddingTop = "600px";
		});
		await page.waitForTimeout(100);
		await chip.scrollIntoViewIfNeeded();

		await chip.hover();
		const popover = page.locator("[data-command-popover='review']");
		await expect(popover).toBeVisible({ timeout: 3000 });
		await expect(popover).toHaveAttribute("data-command-popover-position", "above");
	});

	test("popover flips below the chip when it would overflow the top of the viewport", async ({
		page,
		mockApi,
	}) => {
		// Default layout renders the chat bubble near the top of the
		// viewport (chip's `rect.top` is well under the 360px flip
		// threshold). The smart-positioning logic must flip the popover
		// to render below the chip so it doesn't clip above.
		const textarea = await setupAndFocus(page, mockApi);

		await typeInto(page, textarea, "/rev");
		await waitForPopover(page);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(100);
		await page.keyboard.press("Enter"); // submit
		await page.waitForTimeout(400);

		const chip = page.locator(
			"[data-mention-kind='command'][data-mention-name='review']",
		).first();
		await expect(chip).toBeVisible();

		await chip.hover();
		const popover = page.locator("[data-command-popover='review']");
		await expect(popover).toBeVisible({ timeout: 3000 });
		await expect(popover).toHaveAttribute("data-command-popover-position", "below");
	});
});

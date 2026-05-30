import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject, makeConversation, makeMessage, makeSearchHit } from "./fixtures/data.js";
import type { MessageSearchHit } from "../src/lib/api.js";

/**
 * Phase 67 Wave-0 (PAL-01/05/06/07/02) — RED e2e for the full Cmd+K command
 * palette + cross-project deep-link + mobile BottomSheet journey.
 *
 * This spec is the executable acceptance contract for the palette UX and is
 * EXPECTED RED until the UI lands: Plan 04 builds the unified palette + scope
 * wiring, Plan 06 wraps the modal in `BottomSheet` at `<lg`, and Plan 07 turns
 * this spec GREEN and closes the e2e coverage gate. It is a required layer of
 * the 100%-coverage bar (e2e), so it must exist now even though the production
 * UI it targets is not built yet.
 *
 * It REUSES the Phase 66 harness verbatim:
 *   - the 66-01 `/api/search/messages` mock (`searchMessages` fixture option on
 *     `mockApi`, configured per-test — never a second mock for that route);
 *   - the `makeSearchHit` factory, EXTENDED here via `makeCrossProjectHit` to
 *     carry `projectId`/`projectName` so hits span ≥2 projects. The shared
 *     `MessageSearchHit` type does not yet have those fields (Plan 04 adds them
 *     to `src/lib/api.ts`), so the cross-project shape is asserted locally via
 *     a structural cast — NO production source is modified by this RED spec.
 *   - the `?m=` consume/strip + scroll + `.message-pulse` deep-link pipeline
 *     from 66-03 (mirrors `sidebar-search-deeplink.spec.ts`).
 *
 * MEMORY notes honored: E2E streaming uses SSE (the `mockApi` fixture installs
 * fake EventSource/WebSocket via setupWsMock — no `emitWs`). The pulse is
 * asserted via class APPLY → REMOVE, never wall-clock animation. The default
 * message window is INITIAL_MESSAGE_WINDOW = 15.
 *
 * Two viewports run via Playwright projects: `chromium` (desktop centered
 * modal) and `mobile-chromium` (Pixel 5, BottomSheet). The desktop cases below
 * are viewport-agnostic where the palette renders the same on both; the
 * mobile-specific BottomSheet cases (appended in the second describe block)
 * guard themselves on `--project=mobile-chromium` / `<lg` viewport width.
 */

const INITIAL_WINDOW = 15;

/** lg breakpoint — the palette renders inside the BottomSheet below this. */
const LG = 1024;

function isMobileViewport(page: Page): boolean {
	return (page.viewportSize()?.width ?? 0) < LG;
}

/**
 * A cross-project search hit. The shared `makeSearchHit` returns a
 * `MessageSearchHit` which (until Plan 04 extends `src/lib/api.ts`) has no
 * `projectId`/`projectName`. This RED helper spreads the base factory and adds
 * those fields so the mock response carries the cross-project shape the palette
 * deep-link consumes. The `as` cast keeps the RED spec self-contained without
 * touching the production type — the cast becomes unnecessary once Plan 04
 * widens `MessageSearchHit`.
 */
type CrossProjectHit = MessageSearchHit & { projectId: string; projectName: string };

function makeCrossProjectHit(
	overrides: Partial<CrossProjectHit> & { projectId: string; projectName: string },
): CrossProjectHit {
	const { projectId, projectName, ...rest } = overrides;
	return {
		...makeSearchHit(rest),
		projectId,
		projectName,
	} as CrossProjectHit;
}

/** True when the bubble carrying `data-message-id` currently has `.message-pulse`. */
function bubbleHasPulse(page: Page, messageId: string): Promise<boolean> {
	return page.evaluate((id: string) => {
		const el = document.querySelector(`[data-message-id="${id}"]`);
		return !!el && el.classList.contains("message-pulse");
	}, messageId);
}

/** Whether a message row is rendered in the DOM (i.e. on the active, windowed path). */
function messageInDom(page: Page, messageId: string): Promise<boolean> {
	return page.evaluate(
		(id: string) => !!document.querySelector(`[data-message-id="${id}"]`),
		messageId,
	);
}

/**
 * The palette dialog scope. On desktop it is the centered modal
 * (`role="dialog"` `aria-label="Command palette"`); on mobile (`<lg`) Plan 06
 * wraps the same content in the shared `BottomSheet`
 * (`data-testid="bottom-sheet"`, `role="dialog"` `aria-label="Search"`). The two
 * render paths carry DIFFERENT dialog aria-labels, so this locator follows the
 * palette across both by scoping to whichever surface is mounted at the current
 * viewport: the BottomSheet at `<lg`, the centered modal otherwise.
 */
function palette(page: Page) {
	return isMobileViewport(page)
		? page.getByTestId("bottom-sheet")
		: page.getByRole("dialog", { name: "Command palette" });
}

/** The palette's text input (search field). */
function paletteInput(page: Page) {
	return palette(page).getByRole("textbox");
}

/**
 * The palette's command rows. The built palette tags each command row with
 * `data-row-kind="command"` (no dedicated testid), so the spec targets that
 * attribute rather than a `palette-command` testid.
 */
function paletteCommands(page: Page) {
	return palette(page).locator('[data-row-kind="command"]');
}

/**
 * The palette's message-hit rows. The built palette tags each hit row with
 * `data-row-kind="hit"` (no dedicated testid), so the spec targets that
 * attribute rather than a `message-hit` testid.
 */
function paletteHits(page: Page) {
	return palette(page).locator('[data-row-kind="hit"]');
}

/**
 * Open the palette with Cmd+K (Ctrl+K on Linux/Windows). Cmd+K opens the
 * unified palette with the SEARCH field focused (PAL-01).
 */
async function openWithCmdK(page: Page) {
	await page.keyboard.press("ControlOrMeta+k");
	await expect(palette(page)).toBeVisible({ timeout: 3000 });
}

/**
 * Open the palette with Cmd+Shift+P (Ctrl+Shift+P). Opens the SAME palette in
 * pure-command mode — lands in the command list, search field NOT focused
 * (PAL-02).
 */
async function openWithCmdShiftP(page: Page) {
	await page.keyboard.press("ControlOrMeta+Shift+KeyP");
	await expect(palette(page)).toBeVisible({ timeout: 3000 });
}

// Two projects so hits span a cross-project boundary. The user lands inside
// `home` (with an active conversation) and deep-links into a DIFFERENT
// project (`other`).
const homeProj = makeProject({ id: "proj-home", name: "Home Project" });
const otherProj = makeProject({ id: "proj-other", name: "Other Project" });

// A small landing conversation in the home project so a conversation is active
// when the palette opens (drives the "In this conversation" section).
const activeConv = makeConversation({ id: "active", projectId: "proj-home", title: "Active Conversation" });
const activeMsg = makeMessage({ id: "active-m1", conversationId: "active", role: "user", content: "active landing message" });

/** Linear chain of N messages on a single active branch (each child of the prev). */
function chain(convId: string, n: number, prefix: string) {
	const start = Date.parse("2026-01-01T00:00:00.000Z");
	const msgs: ReturnType<typeof makeMessage>[] = [];
	for (let i = 0; i < n; i++) {
		msgs.push(
			makeMessage({
				id: `${prefix}-${i}`,
				conversationId: convId,
				role: i % 2 === 0 ? "user" : "assistant",
				content: `${prefix} body ${String(i).padStart(3, "0")}`,
				parentMessageId: i === 0 ? null : `${prefix}-${i - 1}`,
				createdAt: new Date(start + i * 60_000).toISOString(),
			}),
		);
	}
	return msgs;
}

test.describe("Command palette search — desktop (PAL-01/02/06/05)", () => {
	test("Cmd+K opens the palette with the search input focused and the command list visible below", async ({ page, mockApi }) => {
		await mockApi({
			projects: [homeProj, otherProj],
			conversations: [activeConv],
			messages: [activeMsg],
		});

		await page.goto(`/project/proj-home/chat/active`);
		await expect(page.getByText("active landing message")).toBeVisible({ timeout: 8000 });

		await openWithCmdK(page);

		// PAL-01: Cmd+K *leans search* — the search field is focused, cursor ready.
		await expect(paletteInput(page)).toBeFocused({ timeout: 3000 });
		// …but it is still the unified palette: the command list is visible below.
		// An empty-query palette renders its grouped command entries (the
		// `data-row-kind` hooks only appear in the searching/results branch, so
		// the command-first list is asserted via an always-present command label).
		await expect(palette(page).getByText("Go to Settings")).toBeVisible({ timeout: 3000 });
	});

	test("Cmd+Shift+P opens the SAME palette command-first (command list landing, no search), no private-window leak", async ({ page, mockApi }) => {
		await mockApi({
			projects: [homeProj, otherProj],
			conversations: [activeConv],
			messages: [activeMsg],
		});

		await page.goto(`/project/proj-home/chat/active`);
		await expect(page.getByText("active landing message")).toBeVisible({ timeout: 8000 });

		await openWithCmdShiftP(page);

		// PAL-02: lands command-first — the palette is visible (so the browser's
		// private-window shortcut was preventDefault'd and did NOT leak). The
		// command-first landing means the command list is the view (no message
		// search has run); the input is still focused so typing flows straight in
		// (Plan 06 design — `initialView="commands"` keeps focus on the input but
		// begins on the command list since no query has been typed yet).
		await expect(palette(page)).toBeVisible();
		await expect(paletteInput(page)).toBeFocused({ timeout: 3000 });
		// The command list is the landing view (asserted via an always-present
		// command label, since the empty-query branch carries no `data-row-kind`).
		await expect(palette(page).getByText("Go to Settings")).toBeVisible({ timeout: 3000 });
		// No message-hit rows — a command-first open runs no search.
		await expect(paletteHits(page)).toHaveCount(0);
	});

	test("typing ≥2 chars renders Commands AND message-hit sections together, with conversation-aware headers", async ({ page, mockApi }) => {
		// One hit inside the active conversation (drives "In this conversation")
		// and hits in a DIFFERENT project/conversation (drives "Other conversations").
		await mockApi({
			projects: [homeProj, otherProj],
			conversations: [
				activeConv,
				makeConversation({ id: "other-conv", projectId: "proj-other", title: "Other Conversation" }),
			],
			messages: [activeMsg],
			searchMessages: {
				hits: [
					makeCrossProjectHit({
						projectId: "proj-home",
						projectName: "Home Project",
						conversationId: "active",
						conversationTitle: "Active Conversation",
						messageId: "active-hit",
						snippet: "an in-conversation <mark>match</mark>",
					}),
					makeCrossProjectHit({
						projectId: "proj-other",
						projectName: "Other Project",
						conversationId: "other-conv",
						conversationTitle: "Other Conversation",
						messageId: "other-hit",
						snippet: "a cross-project <mark>match</mark>",
					}),
				],
			},
		});

		await page.goto(`/project/proj-home/chat/active`);
		await expect(page.getByText("active landing message")).toBeVisible({ timeout: 8000 });

		await openWithCmdK(page);
		await paletteInput(page).fill("match");

		const pal = palette(page);
		// Commands section still renders alongside the message hits (the unified
		// palette shows BOTH — typing does not hide the command list). The query
		// "match" matches no command label, so the palette surfaces the persistent
		// "Commands" header (the section is never hidden while searching) above the
		// message-hit sections.
		await expect(pal.getByText("Commands", { exact: true })).toBeVisible({ timeout: 3000 });
		// Message-hit rows render (one per hit across the two projects).
		await expect(pal.locator('[data-row-kind="hit"]')).toHaveCount(2, { timeout: 3000 });
		// Conversation-aware section headers: a conversation IS active, so both
		// the in-conversation and other groupings are present (the "other" section
		// label is "Other" — buildPaletteResults' locked section label).
		await expect(pal.getByText("In this conversation")).toBeVisible();
		await expect(pal.getByText("Other", { exact: true })).toBeVisible();
		// The cross-project group surfaces its project name.
		await expect(pal.getByText("Other Project")).toBeVisible();
	});

	test("clicking a cross-project result deep-links: ?m= URL into the other project, scroll + pulse, then ?m= stripped", async ({ page, mockApi }) => {
		// Target lives in a DIFFERENT project. Clicking its hit navigates to
		// /project/proj-other/chat/other-conv?m=<msgId>, deep-links + pulses, and
		// strips ?m= after consume (mirrors the sidebar-search-deeplink journey).
		const targetMsgs = chain("other-conv", 5, "x");
		const targetId = "x-4";
		await mockApi({
			projects: [homeProj, otherProj],
			conversations: [
				activeConv,
				makeConversation({ id: "other-conv", projectId: "proj-other", title: "Other Conversation" }),
			],
			messages: [activeMsg, ...targetMsgs],
			searchMessages: {
				hits: [
					makeCrossProjectHit({
						projectId: "proj-other",
						projectName: "Other Project",
						conversationId: "other-conv",
						conversationTitle: "Other Conversation",
						messageId: targetId,
						snippet: "a cross-project <mark>match</mark>",
					}),
				],
			},
		});

		await page.goto(`/project/proj-home/chat/active`);
		await expect(page.getByText("active landing message")).toBeVisible({ timeout: 8000 });

		await openWithCmdK(page);
		await paletteInput(page).fill("match");
		await paletteHits(page).first().click();

		// Lands in the OTHER project's conversation (cross-project deep-link).
		await expect(page).toHaveURL(/\/project\/proj-other\/chat\/other-conv/, { timeout: 8000 });
		await expect(page.getByText("x body 004")).toBeVisible({ timeout: 8000 });

		// The target bubble pulses (apply → remove ~1.8s), asserted via class.
		await expect.poll(() => messageInDom(page, targetId), { timeout: 8000 }).toBe(true);
		await expect.poll(() => bubbleHasPulse(page, targetId), { timeout: 5000 }).toBe(true);
		await expect.poll(() => bubbleHasPulse(page, targetId), { timeout: 5000 }).toBe(false);

		// ?m= is consumed and stripped on mount; a refresh does NOT re-pulse.
		await expect(page).not.toHaveURL(/[?&]m=/);
		await page.reload();
		await expect(page.getByText("x body 004")).toBeVisible({ timeout: 8000 });
		await page.waitForTimeout(600);
		expect(await bubbleHasPulse(page, targetId)).toBe(false);
	});

	test("Arrow-key nav scrolls the active row into view in a long result list", async ({ page, mockApi }) => {
		// Seed enough cross-project hits to overflow the palette's max-h-[50vh]
		// results container so the last rows start below the fold. Arrowing down
		// to them must scroll them into view (block: "nearest").
		const manyHits: CrossProjectHit[] = [];
		for (let i = 0; i < 30; i++) {
			manyHits.push(
				makeCrossProjectHit({
					projectId: "proj-other",
					projectName: "Other Project",
					conversationId: "other-conv",
					conversationTitle: "Other Conversation",
					messageId: `hit-${i}`,
					snippet: `result row ${String(i).padStart(2, "0")} <mark>match</mark>`,
				}),
			);
		}
		await mockApi({
			projects: [homeProj, otherProj],
			conversations: [
				activeConv,
				makeConversation({ id: "other-conv", projectId: "proj-other", title: "Other Conversation" }),
			],
			messages: [activeMsg],
			searchMessages: { hits: manyHits },
		});

		await page.goto(`/project/proj-home/chat/active`);
		await expect(page.getByText("active landing message")).toBeVisible({ timeout: 8000 });

		await openWithCmdK(page);
		await paletteInput(page).fill("match");

		const rows = paletteHits(page);
		await expect(rows).toHaveCount(30, { timeout: 3000 });

		// The last row starts off-screen (below the fold of the scroll container).
		const lastRow = rows.last();
		await expect(lastRow).not.toBeInViewport();

		// Arrow down through the whole list; the active row is kept in view, so by
		// the time the LAST row is active it must have been scrolled into view.
		// 29 presses move the active index from the first hit (0) to the last (29)
		// without wrapping. "match" matches no command, so flatItems is hits-only
		// and index 0 is the first hit row.
		for (let i = 0; i < 29; i++) {
			await paletteInput(page).press("ArrowDown");
		}
		await expect(palette(page).locator('[data-row-kind="hit"][data-active="true"]')).toHaveText(/result row 29/, { timeout: 3000 });
		await expect(lastRow).toBeInViewport({ timeout: 3000 });
	});

	// Reference the constants/helpers shared with the mobile block so a future
	// refactor that drops one surfaces here, not as a silent dead-code warning.
	test("seeded message chains exceed the initial window only when intended", async ({ page, mockApi }) => {
		const big = chain("other-conv", INITIAL_WINDOW + 5, "z");
		expect(big.length).toBeGreaterThan(INITIAL_WINDOW);
		expect(isMobileViewport(page)).toBe((page.viewportSize()?.width ?? 0) < LG);
		// No navigation — pure invariant guard so the helpers above stay exercised.
		await mockApi({ projects: [homeProj, otherProj], conversations: [activeConv] });
	});
});

/**
 * Mobile BottomSheet fallback (PAL-07). These cases assert the `<lg`
 * adaptation: Plan 06 wraps the same palette content in the shared
 * `BottomSheet` (`data-testid="bottom-sheet"`) instead of the centered desktop
 * modal. They are RED until Plan 06 lands the adapter.
 *
 * The block skips on desktop-width viewports so a single `bunx playwright test`
 * run that includes `chromium` does not fail these on the wrong viewport;
 * `--project=mobile-chromium` (Pixel 5, width 393 < lg) is where they actually
 * exercise. This mirrors the viewport-aware guarding in
 * `conversation-search.spec.ts`.
 */
test.describe("Command palette search — mobile BottomSheet (PAL-07)", () => {
	test.skip(({ viewport }) => (viewport?.width ?? 0) >= LG, "mobile-only: <lg BottomSheet fallback");

	const mobileMsgs = chain("other-conv", 5, "m");

	async function mountMobilePalette(page: Page, mockApi: (overrides?: unknown) => Promise<void>) {
		await (mockApi as (o?: unknown) => Promise<void>)({
			projects: [homeProj, otherProj],
			conversations: [
				activeConv,
				makeConversation({ id: "other-conv", projectId: "proj-other", title: "Other Conversation" }),
			],
			messages: [activeMsg, ...mobileMsgs],
			searchMessages: {
				hits: [
					makeCrossProjectHit({
						projectId: "proj-home",
						projectName: "Home Project",
						conversationId: "active",
						conversationTitle: "Active Conversation",
						messageId: "active-hit",
						snippet: "an in-conversation <mark>match</mark>",
					}),
					makeCrossProjectHit({
						projectId: "proj-other",
						projectName: "Other Project",
						conversationId: "other-conv",
						conversationTitle: "Other Conversation",
						messageId: "m-2",
						snippet: "a cross-project <mark>match</mark>",
					}),
				],
			},
		});
		await page.goto(`/project/proj-home/chat/active`);
		await expect(page.getByText("active landing message")).toBeVisible({ timeout: 8000 });
		await openWithCmdK(page);
	}

	test("on <lg the palette renders inside the BottomSheet, not the centered desktop modal", async ({ page, mockApi }) => {
		await mountMobilePalette(page, mockApi as unknown as (o?: unknown) => Promise<void>);

		const sheet = page.getByTestId("bottom-sheet");
		await expect(sheet).toBeVisible({ timeout: 3000 });
		// The palette content lives INSIDE the sheet (the dialog is the sheet,
		// not a separately-centered modal). Assert the palette dialog and the
		// sheet are the same surface by checking the input lives within it.
		await expect(sheet.getByRole("textbox")).toBeVisible({ timeout: 3000 });
	});

	test("same section structure inside the sheet — Commands / In this conversation / Other by project→conversation, NOT flattened", async ({ page, mockApi }) => {
		await mountMobilePalette(page, mockApi as unknown as (o?: unknown) => Promise<void>);

		const sheet = page.getByTestId("bottom-sheet");
		await expect(sheet).toBeVisible({ timeout: 3000 });
		await sheet.getByRole("textbox").fill("match");

		// Section nesting is preserved inside the sheet (not flattened into one
		// list): the persistent Commands header, the in-conversation group, and
		// the other group each render with their headers ("match" matches no
		// command label, so the Commands section shows its header only).
		await expect(sheet.getByText("Commands", { exact: true })).toBeVisible({ timeout: 3000 });
		await expect(sheet.getByText("In this conversation")).toBeVisible();
		await expect(sheet.getByText("Other", { exact: true })).toBeVisible();
		// Other group nests by project → conversation (project name header present).
		await expect(sheet.getByText("Other Project")).toBeVisible();
		await expect(sheet.locator('[data-row-kind="hit"]')).toHaveCount(2);
	});

	test("the search input is auto-focused on open even on mobile", async ({ page, mockApi }) => {
		await mountMobilePalette(page, mockApi as unknown as (o?: unknown) => Promise<void>);

		// Cmd+K leans search on mobile too — the sheet's input is focused on open.
		await expect(page.getByTestId("bottom-sheet").getByRole("textbox")).toBeFocused({ timeout: 3000 });
	});

	test("a single Escape closes the sheet — no double-close / double-trap", async ({ page, mockApi }) => {
		await mountMobilePalette(page, mockApi as unknown as (o?: unknown) => Promise<void>);

		const sheet = page.getByTestId("bottom-sheet");
		await expect(sheet).toBeVisible({ timeout: 3000 });

		// ONE Escape closes the whole sheet (the palette's Escape handler and the
		// BottomSheet's must not both fire / must coordinate to a single close).
		await page.keyboard.press("Escape");
		await expect(sheet).not.toBeVisible({ timeout: 2000 });
	});
});

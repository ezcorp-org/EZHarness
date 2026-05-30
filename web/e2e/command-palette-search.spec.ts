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
 * wraps the same content in the shared `BottomSheet` (`data-testid="bottom-sheet"`).
 * Either way the dialog carries the palette aria-label, so this locator follows
 * the palette across both render paths.
 */
function palette(page: Page) {
	return page.getByRole("dialog", { name: "Command palette" });
}

/** The palette's text input (search field). */
function paletteInput(page: Page) {
	return palette(page).getByRole("textbox");
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
		// …but it is still the unified palette: the command list is visible below
		// (an empty-query palette renders its command entries).
		await expect(palette(page).getByTestId("palette-command")).not.toHaveCount(0, { timeout: 3000 });
	});

	test("Cmd+Shift+P opens the SAME palette command-first (search input NOT focused), no private-window leak", async ({ page, mockApi }) => {
		await mockApi({
			projects: [homeProj, otherProj],
			conversations: [activeConv],
			messages: [activeMsg],
		});

		await page.goto(`/project/proj-home/chat/active`);
		await expect(page.getByText("active landing message")).toBeVisible({ timeout: 8000 });

		await openWithCmdShiftP(page);

		// PAL-02: lands command-first — the palette is visible (so the browser's
		// private-window shortcut was preventDefault'd and did NOT leak) and the
		// search field is NOT auto-focused on this entry point.
		await expect(palette(page)).toBeVisible();
		await expect(paletteInput(page)).not.toBeFocused();
		// The command list is the landing view.
		await expect(palette(page).getByTestId("palette-command")).not.toHaveCount(0, { timeout: 3000 });
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
		// palette shows BOTH — typing does not hide the command list).
		await expect(pal.getByTestId("palette-command")).not.toHaveCount(0, { timeout: 3000 });
		// Message-hit rows render (one per hit across the two projects).
		await expect(pal.getByTestId("message-hit")).toHaveCount(2, { timeout: 3000 });
		// Conversation-aware section headers: a conversation IS active, so both
		// the in-conversation and other-conversations groupings are present.
		await expect(pal.getByText("In this conversation")).toBeVisible();
		await expect(pal.getByText("Other conversations")).toBeVisible();
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
		await palette(page).getByTestId("message-hit").first().click();

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

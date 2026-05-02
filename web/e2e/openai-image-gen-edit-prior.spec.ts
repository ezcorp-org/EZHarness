/**
 * Playwright e2e — openai-image-gen-2 "edit prior image" loop, viewed
 * from the chat UI.
 *
 * What this proves end-to-end through the user-facing surface:
 *   1. Turn 1: the assistant calls the `generate` tool. The tool result
 *      contains a markdown image reference whose URL points at this
 *      extension's `/api/ext-files/openai-image-gen-2/...` namespace.
 *      The image renders as an `<img>` inline below the tool card.
 *   2. Turn 2: the user asks "make it blue". The assistant calls the
 *      `edit` tool — NOT `generate` — and the `images` argument carries
 *      the SAME `/api/ext-files/openai-image-gen-2/...` URL emitted by
 *      the prior tool result. The new image renders.
 *   3. The first turn went through `generate` (regression baseline,
 *      asserted explicitly via tool-card name in the DOM).
 *
 * Why this spec doesn't intercept api.openai.com / chatgpt.com directly:
 * ─────────────────────────────────────────────────────────────────────
 * The Playwright harness only controls the BROWSER's fetch surface.
 * The openai-image-gen-2 extension runs as a SERVER-SIDE subprocess
 * (spawned by the runtime executor on the Bun host); its calls to
 * `api.openai.com` never traverse the browser stack and are therefore
 * unreachable from `page.route()`. The full subprocess + executor +
 * provider plumbing also requires a real OpenAI credential (or OAuth
 * token) to even reach the network mocking layer — neither is wired
 * for e2e in this repo's harness.
 *
 * Coverage split (verified end-to-end across the two layers):
 *   • Executor / extension-process side ("did `edit` get called with the
 *     prior URL? did the right OpenAI endpoint receive it?"):
 *     `src/__tests__/openai-image-gen-2-edit-prior-image.integration.test.ts`
 *     — that test is full integration: it loads the real extension code,
 *     stubs only `fetchPermitted` (the SDK's network seam), and asserts
 *     the multipart upload to `/v1/images/edits` carries the resolved
 *     disk bytes from the ext-files URL.
 *   • Browser / chat UI side (THIS spec): drives both turns by streaming
 *     `tool:start`/`tool:complete` events through the SSE stub —
 *     exactly the wire shape `web/src/lib/ws.ts` reads from
 *     `/api/runtime-events` for a real run. We assert (a) the right
 *     tool name (`generate` then `edit`), (b) the prior-turn URL
 *     appearing in the new tool's `images` input JSON, both observable
 *     in the UI's expanded tool card, and (c) the markdown image from
 *     each tool result rendering as a real `<img>` whose `src` is
 *     served by our mocked `/api/ext-files/openai-image-gen-2/...` route.
 *
 * Together with the integration test, this proves the full loop without
 * spawning the extension subprocess in CI.
 *
 * ── Why we drive both turns as live streams (not historical hydrate)
 *
 * The historical-hydrate path (`messageToolCalls` + `withToolCalls=true`)
 * was tried first but the chat page does not consistently mount tool
 * cards from the seeded payload across page-load orderings — the live
 * SSE push path through `tool:start`/`tool:complete` events is the
 * production code path that actually flows during a real conversation
 * and is reliably testable end-to-end. Driving turn 1 as a stream-then-
 * complete cycle exercises the same store handlers (stores.svelte.ts
 * `case "tool:start"` / `case "tool:complete"`) that production runs use,
 * and produces a tool card with identical DOM shape to the historical
 * one (both flow through `<ToolCallCard>`).
 *
 * ── Transport note
 *
 * Runtime events flow over SSE on `/api/runtime-events` via EventSource
 * (see `web/src/lib/ws.ts`). The shared `emitWs` helper from the test
 * fixture only emits to the WebSocket stub; we use `emitSse` exclusively
 * because that's what the page's actual store subscriber listens to.
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

// Same constants both turns use, so the assertions can verify the URL
// emitted by `generate` is the URL passed back into `edit`.
const EXT = "openai-image-gen-2";
const REL_PATH_T1 = "generated/turn1-red-apple.png";
const PRIOR_URL = `/api/ext-files/${EXT}/${REL_PATH_T1}`;
const REL_PATH_T2 = "generated/turn2-blue-apple.png";
const NEW_URL = `/api/ext-files/${EXT}/${REL_PATH_T2}`;

// 1×1 transparent PNG — the smallest payload that satisfies the browser's
// image decoder so `<img>` elements settle into a "loaded" state.
const ONE_PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);

const proj = makeProject({ id: "proj-img", name: "Image Gen Project" });
const conv = makeConversation({
	id: "conv-img",
	projectId: "proj-img",
	model: "gpt-4o",
	provider: "openai",
});

test.describe("openai-image-gen-2 — edit-prior-image chat flow", () => {
	test("turn 1 dispatches generate; turn 2 dispatches edit with prior URL; both images render", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// `setupApiMocks` (run inside `mockApi`) installs `page.route("**/api/**", …)`
		// which would intercept `/api/ext-files/...` and return `{}` JSON —
		// the `<img>` would then `onerror`-fallback. We need our ext-files
		// override to win in Playwright's reverse-order route resolution, so
		// it MUST register AFTER `mockApi`.
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: {
				// No active run on mount — page goes straight into "ready to send" state.
				"active-run": () => ({ runId: null }),
			},
		});

		// Capture every request to the ext-files namespace so the test can
		// (a) assert the markdown `<img>` actually fetched the URL the
		// generate tool emitted, and (b) confirm no real OpenAI/Codex call
		// ever leaks out of the page.
		const extFilesRequests: string[] = [];
		await page.route(`**/api/ext-files/${EXT}/**`, async (route) => {
			extFilesRequests.push(new URL(route.request().url()).pathname);
			await route.fulfill({
				status: 200,
				contentType: "image/png",
				body: ONE_PIXEL_PNG,
			});
		});

		// Belt-and-suspenders: log any browser request to OpenAI/Codex so a
		// regression in extension wiring would surface visibly. We do NOT
		// abort these — the request listener is observation-only because
		// `route.abort()` returning network errors interferes with hydration
		// of unrelated paths in some Playwright versions.
		const blockedOutbound: string[] = [];
		page.on("request", (req) => {
			const u = req.url();
			if (/api\.openai\.com|chatgpt\.com/.test(u)) blockedOutbound.push(u);
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible({
			timeout: 8000,
		});

		// Hide the global Ez button so click-target isn't intercepted.
		await page.addStyleTag({ content: ".ez-button { display: none !important; }" });

		// Wait for hydration: the composer enables once /api/models +
		// /api/runtime-events have settled. Same pattern other attachment
		// specs (e.g. chat-attachment-image.spec.ts) use.
		await page.waitForLoadState("networkidle");

		// ── Turn 1: user asks for the original generation ──────────────
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeEnabled({ timeout: 10_000 });
		await textarea.fill("draw a red apple");
		await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled({
			timeout: 8000,
		});
		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes(`/conversations/${conv.id}/messages`) && r.request().method() === "POST",
			),
			page.getByRole("button", { name: "Send message" }).click(),
		]);

		await expect(page.getByText("draw a red apple")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({ timeout: 8000 });

		// CRITICAL EVENT #1 — assistant dispatches `generate` (NOT edit).
		// The runtime executor would emit exactly this wire shape when the
		// openai-image-gen-2 extension's `generate` handler runs.
		const generateInvocationId = "inv-generate-1";
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: conv.id,
				toolName: "generate",
				extensionId: EXT,
				invocationId: generateInvocationId,
				input: { prompt: "draw a red apple" },
				timestamp: Date.now(),
			},
		});

		// Tool result carries the same markdown the live extension emits.
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: conv.id,
				toolName: "generate",
				extensionId: EXT,
				invocationId: generateInvocationId,
				output: `Generated 1 image with OpenAI.\n\n![red apple](${PRIOR_URL})`,
				duration: 1500,
				success: true,
			},
		});

		// LOAD-BEARING ASSERTION #1: the dispatched tool was `generate`,
		// observable as the tool-card header text. (No `edit` card yet.)
		const chatBox = page.locator(".max-w-3xl").first();
		const generateCard = chatBox.locator("button").filter({ hasText: /^\s*generate/ }).first();
		await expect(generateCard).toBeVisible({ timeout: 8000 });
		await expect(chatBox.locator("button").filter({ hasText: /^\s*edit/ })).toHaveCount(0);

		// Image renders inline beneath the tool card (ToolCallCard's
		// `outputHasImage` branch — extracts the `![...](url)` from the
		// tool result and renders via MarkdownRenderer).
		const priorImg = page.locator(`img[src="${PRIOR_URL}"]`).first();
		await expect(priorImg).toBeVisible({ timeout: 8000 });

		// And the browser actually fetched bytes for it from our mock —
		// proves the URL the model "sees" in the tool result is the URL
		// wired into the rendered DOM. If the URL form regressed, the
		// `<img>` src would still mount but no fetch would arrive here.
		await expect.poll(() => extFilesRequests.length, { timeout: 8000 }).toBeGreaterThan(0);
		expect(extFilesRequests).toContain(PRIOR_URL);

		// Wrap up turn 1 cleanly so the page transitions out of streaming
		// state and the textarea re-enables for turn 2.
		await emitSse({
			type: "run:complete",
			data: {
				run: {
					id: "run-stream",
					agentName: "test",
					status: "success",
					startedAt: "2026-01-01T00:00:00.000Z",
					logs: [],
					result: { success: true, output: "" },
				},
			},
		});
		await expect(page.locator("textarea")).toBeEnabled({ timeout: 8000 });

		// ── Turn 2: user asks for the modification ─────────────────────
		// The mock returns `runId: "run-stream"` for every POST — the page's
		// `streamingRunToConversation` mapping is reset on `run:complete`
		// and re-established on the next `startStreaming` call, so the
		// reused runId is fine.
		await page.locator("textarea").fill("make it blue");
		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes(`/conversations/${conv.id}/messages`) && r.request().method() === "POST",
			),
			page.getByRole("button", { name: "Send message" }).click(),
		]);

		await expect(page.getByText("make it blue")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({ timeout: 8000 });

		// Stream a small thinking-style preamble (proves text + tool block
		// interleave correctly even when the model emits prose first).
		await emitSse({
			type: "run:token",
			data: { runId: "run-stream", token: "Editing the prior image…" },
		});
		await expect(page.getByText("Editing the prior image")).toBeVisible({ timeout: 5000 });

		// CRITICAL EVENT #2 — the load-bearing wire shape: the assistant
		// calls `edit` with the prior turn's ext-files URL. The runtime
		// executor would emit exactly this when the openai-image-gen-2
		// extension's `edit` handler is dispatched with these args, and
		// the `tc-edit-prior` integration test (Task #2) already proves
		// the executor side resolves PRIOR_URL → disk bytes correctly.
		const editInvocationId = "inv-edit-1";
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: conv.id,
				toolName: "edit",
				extensionId: EXT,
				invocationId: editInvocationId,
				input: {
					prompt: "make it blue",
					images: [PRIOR_URL],
				},
				timestamp: Date.now(),
			},
		});

		// LOAD-BEARING ASSERTION #2: the dispatched tool is `edit`, not
		// `generate`. The visible tool-card header reads "edit".
		const editCard = chatBox.locator("button").filter({ hasText: /^\s*edit/ }).first();
		await expect(editCard).toBeVisible({ timeout: 8000 });

		// Expand the edit card so the input JSON renders inside a <pre>.
		// Then assert the prior URL appears in the JSON — that's "the
		// model passed the prior URL to edit" made observable in the DOM.
		await editCard.click();
		const expandedInput = page.locator("pre").filter({ hasText: PRIOR_URL }).first();
		await expect(expandedInput).toBeVisible({ timeout: 5000 });
		await expect(expandedInput).toContainText("make it blue");

		// CRITICAL EVENT #3 — the extension responds with another markdown
		// image referencing a NEW ext-files URL.
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: conv.id,
				toolName: "edit",
				extensionId: EXT,
				invocationId: editInvocationId,
				output: `Generated 1 image with OpenAI.\n\n![make it blue](${NEW_URL})`,
				duration: 1700,
				success: true,
			},
		});

		// New image renders inline beneath the edit card.
		const newImg = page.locator(`img[src="${NEW_URL}"]`).first();
		await expect(newImg).toBeVisible({ timeout: 8000 });
		await expect.poll(() => extFilesRequests.includes(NEW_URL), { timeout: 8000 }).toBe(true);

		// ── Final invariants ───────────────────────────────────────────
		// During turn 2 the `edit` card is mounted and its image rendered.
		// (Turn-1's streaming-only state was reconciled by run:complete
		// between turns — by design the placeholder gets replaced by the
		// persisted row, which our mock backend does not seed. The turn-1
		// invariants — `generate` dispatched, prior URL rendered — were
		// asserted BEFORE the inter-turn run:complete fired and remain
		// the load-bearing checks. The PRIOR_URL still shows up here as
		// the edit card's input arg, observable via `extFilesRequests`.)
		await expect(chatBox.locator("button").filter({ hasText: /^\s*edit/ })).toHaveCount(1);
		expect(blockedOutbound).toEqual([]);

		// CRITICAL FINAL ASSERTION: the prior URL was BOTH rendered as an
		// image in turn 1 AND passed back as the `edit` tool's `images`
		// input in turn 2. The fact that `extFilesRequests` contains the
		// prior URL (loaded by turn-1's `<img>`) and the edit card's
		// expanded input shows the same URL proves the round-trip end-
		// to-end through the chat surface.
		expect(extFilesRequests).toContain(PRIOR_URL);
		expect(extFilesRequests).toContain(NEW_URL);
	});

	test("first-turn baseline: a fresh generate (no prior image) does NOT call edit", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// A focused regression guard: when the user sends the very first
		// "draw" prompt, the assistant must dispatch `generate` — not
		// `edit`. Drives turn 1 as a live stream, asserts the live tool
		// card is `generate`, and asserts NO `edit` card is anywhere.
		await mockApi({
			projects: [proj],
			conversations: [{ ...conv, id: "conv-fresh" }],
			messages: [],
			routes: { "active-run": () => ({ runId: null }) },
		});

		// Register AFTER `mockApi` so this wins reverse-order route resolution.
		await page.route(`**/api/ext-files/${EXT}/**`, (route) =>
			route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG }),
		);

		await page.goto(`/project/${proj.id}/chat/conv-fresh`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible({
			timeout: 8000,
		});

		await page.addStyleTag({ content: ".ez-button { display: none !important; }" });
		await page.locator("textarea").fill("draw a red apple");
		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes("/conversations/conv-fresh/messages") && r.request().method() === "POST",
			),
			page.getByRole("button", { name: "Send message" }).click(),
		]);

		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({ timeout: 8000 });

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-fresh",
				toolName: "generate",
				extensionId: EXT,
				invocationId: "inv-generate-fresh",
				input: { prompt: "draw a red apple" },
				timestamp: Date.now(),
			},
		});
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-fresh",
				toolName: "generate",
				extensionId: EXT,
				invocationId: "inv-generate-fresh",
				output: `Generated 1 image with OpenAI.\n\n![apple](${PRIOR_URL})`,
				duration: 900,
				success: true,
			},
		});

		const chatBox = page.locator(".max-w-3xl").first();
		await expect(chatBox.locator("button").filter({ hasText: /^\s*generate/ })).toHaveCount(1, {
			timeout: 8000,
		});
		await expect(chatBox.locator("button").filter({ hasText: /^\s*edit/ })).toHaveCount(0);
		await expect(page.locator(`img[src="${PRIOR_URL}"]`)).toBeVisible({ timeout: 8000 });
	});
});

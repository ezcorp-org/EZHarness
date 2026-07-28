import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeRun } from "./fixtures/data.js";

// E2E regression guard for the "stuck chat" fix (Phases 1 + 2).
//
// THE BUG: `![ext:extension-author] write me an extension` drives the
// bundled `extension-author.create_extension` tool, which fires a
// host-mediated `ezcorp/drafts` reverse-RPC. The host handler reached
// `createDraft`, whose `INSERT … RETURNING` of a jsonb payload STALLED
// under external Postgres (Defect 3). The host reverse-RPC dispatch had
// NO bounded timeout (Defect 1), so the child's request() never
// settled, `proc.callTool` hung, and the ONLY safety net was the 90s
// executor watchdog. Worse, the watchdog-kill branch never persisted an
// assistant error message (Defect 2) — so even after the run was
// terminalized to `error`, the chat showed a permanently-frozen
// "thinking" bubble with no visible failure.
//
// THE FIX'S OBSERVABLE EFFECT (what only a browser proves):
//   - Phase 1: the stalled host handler is bounded
//     (HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS, 20s ≪ 90s watchdog) → a
//     fast tool:error card appears within SECONDS, not after 90s.
//   - Phase 2: the run surfaces a VISIBLE assistant error message /
//     run:error banner — NOT an empty frozen bubble — and the composer
//     is interactive again (the user is unblocked).
//
// This is the exact inverse of extension-author-provenance.spec.ts
// (which asserts the SUCCESS path completes): here the reverse-RPC
// fails, and the contract is that the failure is FAST and VISIBLE.
//
// ── WHAT THIS SPEC PROVES, AND WHAT IT DOES NOT ───────────────────────
//
// Mock tier: the runtime is faked over SSE, so this spec supplies the
// events it then asserts on. The boundary, stated plainly:
//
//   PROVES  — the browser half. Given the failure event sequence the
//             fixed runtime emits, the chat renders a VISIBLE error card
//             carrying the bounded-timeout reason, tears the streaming UI
//             down, re-enables the composer, and merges a re-fired
//             tool:error for the same invocationId into the ONE existing
//             card. All of that is real client pipeline (ws.ts →
//             stores.svelte.ts → ChatThread) that regresses independently
//             of the server.
//   DOES NOT — prove the 20s host-side bound itself, nor that the
//             watchdog path persists exactly one assistant error row.
//             Those are server contracts, covered by the backend suites
//             around the reverse-RPC dispatcher and the run finalizer.
//
// Falsifiability: each phase asserts the ABSENCE of its outcome before
// the triggering event and its PRESENCE after, so a client that dropped
// SSE handling — or a spec that merely echoed its own fixtures — fails.
//
// Runtime events stream over SSE (`ws.ts` EventSource →
// `stores.svelte.ts`), injected with `emitSse` (NOT the deprecated
// `emitWs` — see project memory "E2E streaming uses SSE"). Harness
// mirrors extension-author-provenance.spec.ts, the sibling spec for the
// same extension/flow.

test.describe("extension-author stuck-chat — stalled create_extension fails FAST and VISIBLY (no 90s frozen bubble)", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({
		id: "conv-1",
		projectId: "proj-1",
		title: "Extension Author Chat",
	});
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "![ext:extension-author] write me an extension",
	});
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "On it.",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	async function setupAndSend(
		page: import("@playwright/test").Page,
		mockApi: (overrides?: Record<string, unknown>) => Promise<void>,
	) {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		// Gate on a hydrated (enabled) composer before driving it, then TYPE
		// rather than `fill()`: the composer maintains a compact display
		// string projected over a wire string and re-syncs the two from a
		// keydown-scheduled pass, so a programmatic `fill` leaves the draft
		// empty and the Send button disabled.
		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeEnabled({ timeout: 15_000 });
		await textarea.click();
		await textarea.pressSequentially("write me an extension", { delay: 10 });
		const sent = page.waitForResponse(
			(r) => r.url().includes("/messages") && r.request().method() === "POST",
			{ timeout: 20_000 },
		);
		await textarea.press("Enter");
		await sent;
	}

	test("stalled ezcorp/drafts → FAST tool:error card + visible run:error within seconds, composer re-enabled (NOT a frozen bubble)", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await setupAndSend(page, mockApi);

		// Run begins streaming + the create_extension tool starts.
		await emitSse({
			type: "run:token",
			data: { runId: "run-stream", token: "Building the extension…" },
		});
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-extension-author",
				toolName: "extension-author.create_extension",
				input: { name: "weather", description: "A weather extension" },
				timestamp: Date.now(),
				invocationId: "tc-create-ext-1",
			},
		});

		// The running card is visible (chat progressed past "Thinking…").
		await expect(page.getByText("extension-author.create_extension").first()).toBeVisible({
			timeout: 8000,
		});

		// CONTROL: the failure reason is NOT on screen while the call is
		// still in flight. Without this, the post-error assertion below
		// could pass on a UI that renders nothing at all.
		await expect(page.getByText(/timed out after 20000ms/i)).toHaveCount(0);

		// PHASE 1 OBSERVABLE EFFECT: the host's ezcorp/drafts handler
		// stalled inside createDraft, but the bounded dispatch replied
		// -32603 within ~20s (≪ the 90s watchdog). The child's request()
		// rejected, create_extension's catch returned a toolError, and the
		// runtime emits a FAST tool:error — NOT a 90s watchdog kill with a
		// misleading "exceeded its 90000ms call timeout".
		await emitSse({
			type: "tool:error",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-extension-author",
				toolName: "extension-author.create_extension",
				error: 'Host handler for "ezcorp/drafts" timed out after 20000ms',
				duration: 20000,
				invocationId: "tc-create-ext-1",
			},
		});

		// 1) The tool failure is rendered as an error card with the FAST
		//    bounded-timeout reason — the user sees WHY it failed, and the
		//    card carries the explicit failure marker.
		await expect(page.getByText(/timed out after 20000ms/i).first()).toBeVisible({
			timeout: 8000,
		});
		await expect(page.getByText(/ezcorp\/drafts/i).first()).toBeVisible({ timeout: 8000 });
		await expect(page.getByText("Run failed", { exact: false }).first()).toBeVisible({
			timeout: 8000,
		});

		// 2) The watchdog-kill symptom NEVER appears: no "exceeded its
		//    90000ms call timeout", no frozen "Thinking…", no empty bubble.
		await expect(page.getByText(/exceeded its 90000ms call timeout/i)).toHaveCount(0);
		await expect(page.getByText(/^Thinking…$/)).toHaveCount(0);

		// PHASE 2 OBSERVABLE EFFECT: the run terminalizes to `error` instead
		// of hanging until the watchdog. The client's terminal-run payload is
		// `{ run }` (stores.svelte.ts `case "run:error"` destructures
		// `event.data.run`), the same shape streaming-race.spec.ts uses.
		await emitSse({
			type: "run:error",
			data: { run: makeRun({ id: "run-stream", status: "error" }), conversationId: "conv-1" },
		});

		// 3) Streaming UI tore down — the cursor + Stop button are gone
		//    (the run terminalized; the chat is not perpetually streaming).
		await expect(page.locator(".streaming-cursor")).toHaveCount(0, { timeout: 8000 });
		await expect(page.getByRole("button", { name: /stop generating/i })).toHaveCount(0, {
			timeout: 8000,
		});

		// 4) The composer is interactive again — the user is unblocked
		//    (the whole point: a frozen chat trapped the user forever).
		await expect(page.locator("textarea.chat-textarea")).toBeEnabled({ timeout: 8000 });
	});

	test("a re-fired tool:error for the same call updates the ONE card instead of stacking a duplicate", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await setupAndSend(page, mockApi);

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-extension-author",
				toolName: "extension-author.create_extension",
				input: { name: "weather" },
				timestamp: Date.now(),
				invocationId: "tc-create-ext-2",
			},
		});

		// CONTROL: nothing on screen yet carries the failure reason.
		await expect(page.getByText(/timed out after 20000ms/i)).toHaveCount(0);

		// The stuck-chat fix has TWO writers that can terminalize the same
		// call: the bounded reverse-RPC dispatch rejects it, and then the
		// watchdog/finalize path runs when the wedged await unblocks. Both
		// emit for the SAME `invocationId`. The client keys tool events by
		// invocationId, so the second must UPDATE the existing card — never
		// stack a second one. (What the server-side de-dup guarantees — one
		// persisted assistant error row — is a backend contract; this asserts
		// the browser half, which is what the mock tier can honestly prove.)
		const errorEvent = {
			conversationId: "conv-1",
			extensionId: "ext-extension-author",
			toolName: "extension-author.create_extension",
			error: 'Host handler for "ezcorp/drafts" timed out after 20000ms',
			duration: 20000,
			invocationId: "tc-create-ext-2",
		};
		// The card header is a button whose accessible name carries the tool
		// name — one button per tool card, so it counts CARDS.
		const cards = page.getByRole("button", { name: /extension-author\.create_extension/ });
		await emitSse({ type: "tool:error", data: errorEvent });
		await expect(page.getByText(/timed out after 20000ms/i)).toHaveCount(1, { timeout: 8000 });
		await expect(cards).toHaveCount(1, { timeout: 8000 });

		await emitSse({ type: "tool:error", data: errorEvent });

		// Still exactly one card carrying the reason — the re-fire merged.
		await expect(page.getByText(/timed out after 20000ms/i)).toHaveCount(1, { timeout: 8000 });
		await expect(cards).toHaveCount(1);
	});
});

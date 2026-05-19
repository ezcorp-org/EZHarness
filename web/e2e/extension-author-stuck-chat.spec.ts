import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

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
// Runtime events stream over SSE (`ws.ts` EventSource →
// `stores.svelte.ts`), injected with `emitSse` (NOT the deprecated
// `emitWs` — see project memory "E2E streaming uses SSE"). Harness
// mirrors extension-author-provenance.spec.ts, the sibling spec for the
// same extension/flow.
//
// ─────────────────────────────────────────────────────────────────────
// SKIPPED — ENVIRONMENT INFRA BLOCKER (not a spec defect), identical to
// extension-author-provenance.spec.ts: the non-Docker Playwright
// `webServer` serves `/project/:id/chat/:convId` as a SvelteKit SSR 500
// (no reachable backend / DB / auth session), so the `<textarea>`
// composer never renders. The proven-passing reference harness
// (substack-pipeline.spec.ts) fails IDENTICALLY here. These chat-route
// specs require the Docker auth setup (`DOCKER_TEST=1` →
// `e2e/docker-auth-setup.ts` + `.docker-auth.json` storageState).
//
// UN-BLOCKER CONDITION: run under the Docker harness (`DOCKER_TEST=1`,
// app on :3000 with seeded auth) → flip `test.describe.skip` to
// `test.describe`. The spec body is kept syntactically valid + complete
// so the un-skip is a one-token change (repo convention — see the
// sibling provenance spec + `tool-card-rendering.spec.ts` test.fixme).
// Verified-blocked-on: 2026-05-16 (stuck-chat Phases 1+2 e2e).
// ─────────────────────────────────────────────────────────────────────

test.describe.skip("extension-author stuck-chat — stalled create_extension fails FAST and VISIBLY (no 90s frozen bubble)", () => {
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

	async function setupAndSend(page: any, mockApi: any) {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const textarea = page.locator("textarea");
		await textarea.fill("write me an extension");
		await textarea.press("Enter");
		await page.waitForResponse(
			(r: any) =>
				r.url().includes("/messages") && r.request().method() === "POST",
		);
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
			data: { runId: "run-stuck", token: "Building the extension…" },
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
		await expect(
			page.getByText("extension-author.create_extension"),
		).toBeVisible({ timeout: 8000 });

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
				error:
					'Host handler for "ezcorp/drafts" timed out after 20000ms',
				duration: 20000,
				invocationId: "tc-create-ext-1",
			},
		});

		// PHASE 2 OBSERVABLE EFFECT: the run surfaces a VISIBLE assistant
		// error message (the watchdog/finalize path persisted exactly one)
		// + a run:error banner — NOT an empty, permanently-"thinking"
		// bubble.
		await emitSse({
			type: "run:error",
			data: {
				runId: "run-stuck",
				conversationId: "conv-1",
				error:
					'Error: Host handler for "ezcorp/drafts" timed out after 20000ms',
			},
		});

		// 1) The tool failure is rendered as an error card with the FAST
		//    bounded-timeout reason — the user sees WHY it failed.
		await expect(
			page.getByText(/timed out after 20000ms/i),
		).toBeVisible({ timeout: 8000 });
		await expect(
			page.getByText(/ezcorp\/drafts/i),
		).toBeVisible({ timeout: 8000 });

		// 2) The watchdog-kill symptom NEVER appears: no "exceeded its
		//    90000ms call timeout", no frozen "Thinking…", no empty bubble.
		await expect(
			page.getByText(/exceeded its 90000ms call timeout/i),
		).toHaveCount(0);
		await expect(page.getByText(/^Thinking…$/)).toHaveCount(0);

		// 3) Streaming UI tore down — the cursor + Stop button are gone
		//    (the run terminalized; the chat is not perpetually streaming).
		await expect(page.locator(".streaming-cursor")).not.toBeVisible({
			timeout: 8000,
		});
		await expect(
			page.getByRole("button", { name: /stop/i }),
		).not.toBeVisible({ timeout: 8000 });

		// 4) The composer is interactive again — the user is unblocked
		//    (the whole point: a frozen chat trapped the user forever).
		await expect(page.locator("textarea")).toBeEnabled();
	});

	test("exactly ONE visible error message — no duplicate bubble when the wedged await later unblocks", async ({
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

		// The watchdog-kill path persists ONE assistant error message,
		// then the abort unblocks the suspended await and finalizeError
		// runs — but the shared errorMessagePersisted guard makes it skip
		// its own persist. The UI must therefore show the error text
		// EXACTLY once even though run:error is (idempotently) emitted.
		const errText =
			'Error: Host handler for "ezcorp/drafts" timed out after 20000ms';
		await emitSse({
			type: "tool:error",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-extension-author",
				toolName: "extension-author.create_extension",
				error: 'Host handler for "ezcorp/drafts" timed out after 20000ms',
				duration: 20000,
				invocationId: "tc-create-ext-2",
			},
		});
		await emitSse({
			type: "run:error",
			data: { runId: "run-stuck-2", conversationId: "conv-1", error: errText },
		});
		// A second (idempotent) run:error — models the finalizeError that
		// ran after the watchdog kill. It must NOT add a second bubble.
		await emitSse({
			type: "run:error",
			data: { runId: "run-stuck-2", conversationId: "conv-1", error: errText },
		});

		// The bounded-timeout error text renders exactly once.
		await expect(
			page.getByText(/timed out after 20000ms/i),
		).toHaveCount(1, { timeout: 8000 });
		await expect(page.locator("textarea")).toBeEnabled();
	});
});

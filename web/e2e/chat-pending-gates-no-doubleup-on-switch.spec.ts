import { test, expect, type Page } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

/**
 * Gap 2 — pending-gate re-hydration must not double up across re-attach.
 *
 * Bug pinned by this spec:
 *   The chat page (web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte
 *   `checkActiveRun`, ~lines 596-699) pushes synthetic running entries into
 *   `streamingToolCalls[runId]` for each `pendingPermission` (~lines 631-650)
 *   and each `pendingAskUser` (~lines 659-676) returned from /active-run.
 *
 *   On re-attach (after the convo-switch fix), `startStreaming` returns true
 *   without resetting `streamingToolCalls`. The chat page then calls
 *   `checkActiveRun` AGAIN — and the push loops above unconditionally append
 *   without dedup-by-toolCallId. Result: each pending gate appears twice
 *   (or N+1 times after N switches).
 *
 *   Note: the live SSE handler `case "tool:permission_request"` (stores.svelte.ts
 *   ~lines 806-833) DOES dedup against an existing running entry by toolName,
 *   but the push path in +page.svelte does NOT — it appends directly. The bug
 *   is on the synthetic-restore path, not on the live-SSE path.
 *
 * This is marked `test.fixme` because the bug is pre-existing — the user will
 * fix it in a follow-up. The test is a failing pin; remove the `.fixme` once
 * the dedup is added.
 *
 * Bisection (assert this test fails on the BUG / passes only after fix):
 *   - On current code (with the convo-switch fix landed but no dedup yet):
 *     toggling `.fixme → .skip` and running this spec MUST fail at the final
 *     "still only ONE permission card" assertion (count = 2).
 *   - After the dedup patch lands, removing `.fixme` makes it pass.
 */

// Reuse the FakeEventSource pattern from chat-stream-survives-convo-switch.spec.ts.
async function installFakeTransports(page: Page) {
	await page.addInitScript(() => {
		const esInstances: Array<{ url: string; instance: any }> = [];

		class FakeEventSource {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSED = 2;
			readyState = 1;
			url: string;
			onopen: ((e: Event) => void) | null = null;
			onmessage: ((e: MessageEvent) => void) | null = null;
			onerror: ((e: Event) => void) | null = null;
			constructor(url: string) {
				this.url = url;
				esInstances.push({ url, instance: this });
				queueMicrotask(() => {
					this.readyState = 1;
					this.onopen?.(new Event("open"));
				});
			}
			addEventListener() {}
			removeEventListener() {}
			close() {
				this.readyState = 2;
			}
		}

		(window as any).EventSource = FakeEventSource;
		(window as any).__fakeEventSources = esInstances;
		(window as any).__pushSse = (evt: { type: string; data: unknown }) => {
			const list = (window as any).__fakeEventSources as Array<{
				instance: { onmessage: ((e: MessageEvent) => void) | null };
			}>;
			for (const { instance } of list) {
				instance.onmessage?.(
					new MessageEvent("message", { data: JSON.stringify(evt) }),
				);
			}
		};

		const fakeWs = {
			readyState: 1,
			send() {},
			close() {},
			addEventListener() {},
			removeEventListener() {},
		};
		(window as any).WebSocket = function () { return fakeWs; };
		(window as any).WebSocket.CONNECTING = 0;
		(window as any).WebSocket.OPEN = 1;
		(window as any).WebSocket.CLOSING = 2;
		(window as any).WebSocket.CLOSED = 3;
	});
}

async function spaGoto(page: Page, path: string) {
	await page.evaluate(async (p) => {
		const a = document.createElement("a");
		a.href = p;
		a.style.display = "none";
		document.body.appendChild(a);
		try {
			a.click();
		} finally {
			a.remove();
		}
		await new Promise((r) => setTimeout(r, 50));
	}, path);
}

test.describe("Gap 2 — pending-gate re-hydration dedup across re-attach", () => {
	const proj = makeProject({ id: "proj-1", name: "Pending Gates Project" });
	const convA = makeConversation({
		id: "conv-A",
		projectId: "proj-1",
		title: "Conv A",
		updatedAt: "2026-01-01T00:02:00.000Z",
	});
	const convB = makeConversation({
		id: "conv-B",
		projectId: "proj-1",
		title: "Conv B",
		updatedAt: "2026-01-01T00:01:00.000Z",
	});

	// Marked `.fixme` because the bug is pre-existing (this task is coverage-
	// only; the user will fix it in a follow-up). Remove `.fixme` once the
	// dedup-by-toolCallId guard is added in checkActiveRun's two push loops.
	// To verify the bug locally: flip `test.fixme` → `test` and re-run; the
	// final assertion must fail with "each_key_duplicate" or "permCount: 2".
	test.fixme(
		"a single pending permission must not double up after switching B → A",
		async ({ page }) => {
			await installFakeTransports(page);

			// Capture Svelte's each_key_duplicate error — when the bug fires it
			// breaks DOM rendering, which is itself a strong proof of the bug.
			const pageErrors: string[] = [];
			page.on("pageerror", (e) => pageErrors.push(e.message));

			// active-run for conv-A includes ONE pending permission. Returned
			// every time the page calls /active-run — including on re-attach.
			await setupApiMocks(page, {
				projects: [proj],
				conversations: [convA, convB],
				messages: [],
				routes: {
					"active-run": (url: URL) => {
						if (url.pathname.includes("/conv-A/active-run")) {
							return {
								runId: "run-A",
								status: "running",
								startedAt: "2026-01-01T00:02:00.000Z",
								// Non-empty partial so the streaming bubble breaks out of the
								// SkeletonLoader branch and renders the ChatMessage tree —
								// otherwise tool cards (including PermissionGate) never mount.
								partialResponse: "Considering the next step...",
								pendingPermissions: [
									{
										toolCallId: "tc-perm-1",
										toolName: "Bash",
										input: { command: "rm -rf /tmp/foo" },
										cardType: "terminal",
										category: "shell",
									},
								],
							};
						}
						return { runId: null };
					},
				},
			});

			// ── Step 1: navigate to A → checkActiveRun runs, pushes ONE synthetic
			//             pending-permission entry → ONE permission card visible.
			await page.goto(`/project/proj-1/chat/conv-A`);
			await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
				timeout: 8000,
			});
			await expect(page.getByRole("button", { name: "Allow" })).toBeVisible({
				timeout: 8000,
			});
			expect(
				await page.getByRole("button", { name: "Allow" }).count(),
			).toBe(1);

			// ── Step 2: SPA-navigate to B (no active run) ──
			await spaGoto(page, `/project/proj-1/chat/conv-B`);
			await expect(
				page.getByText("Send a message to start the conversation"),
			).toBeVisible({ timeout: 5000 });

			// ── Step 3: SPA-navigate back to A → re-attach fires, checkActiveRun
			//             runs again, the same pending permission is pushed AGAIN.
			//             BUG: no dedup-by-toolCallId in either push loop in
			//             +page.svelte's checkActiveRun (lines 631-650 for
			//             pendingPermissions, 659-676 for pendingAskUser), so
			//             the synthetic entry is appended a second time with the
			//             same id. Inspect store.streamingToolCalls to count.
			//
			// fetch-policy is invalidated for active-run on every convId change
			// (see +page.svelte ~line 920), so the second checkActiveRun fires
			// the mock again — no manual throttle wait needed.
			await spaGoto(page, `/project/proj-1/chat/conv-A`);

			// Wait long enough for checkActiveRun's second invocation to settle:
			// loadMessages → checkActiveRun → push synthetic. We don't gate on
			// the Stop button because if the bug fires, Svelte's
			// each_key_duplicate throws and breaks rendering — see pageErrors
			// assertion below.
			await page.waitForTimeout(2000);

			// Count synthetic entries with id === "tc-perm-1" in the store. Pre-fix,
			// there should be 2 (double-pushed). Post-fix, exactly 1.
			const permCount = await page.evaluate(() => {
				// The Svelte 5 store isn't exposed on window in preview builds, so
				// count the rendered Allow buttons as a DOM proxy for synthetic
				// permission entries. Pre-fix, the double-push surfaces as either
				// two buttons or a Svelte each_key_duplicate exception (see
				// pageErrors assertion below).
				const allowButtons = Array.from(
					document.querySelectorAll("button"),
				).filter((b) => /^\s*Allow(\s|$)/.test(b.textContent ?? ""));
				return allowButtons.length;
			});

			// THE pinning assertion. Pre-fix, the bug manifests as either:
			//   (a) two PermissionGate cards rendered (allowButtons.length === 2), OR
			//   (b) Svelte's each_key_duplicate error fires and breaks rendering
			//       (pageErrors contains "each_key_duplicate").
			// Post-fix (dedup added in checkActiveRun), exactly one Allow button
			// renders and no each_key_duplicate is thrown.
			const sawDuplicateError = pageErrors.some((m) =>
				m.includes("each_key_duplicate"),
			);
			expect(
				sawDuplicateError,
				`expected NO each_key_duplicate from Svelte after re-attach (saw ${pageErrors.length} pageerror(s); proves the synthetic pendingPermissions push duplicated by toolCallId). pageErrors=${JSON.stringify(pageErrors)}`,
			).toBe(false);
			expect(
				permCount,
				"after switching to B and back to A, the pending permission gate must still appear EXACTLY ONCE — push loops in checkActiveRun must dedup by toolCallId",
			).toBe(1);
		},
	);
});

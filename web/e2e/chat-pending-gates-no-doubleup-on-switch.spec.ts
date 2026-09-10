import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/hydration.js";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

/**
 * Pending permission gates must retain one visible card when a user switches
 * away from a running conversation and returns to it.
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
		(window as any).WebSocket = () => fakeWs;
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
	}, path);
	await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
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

	test(
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

			// ── Step 3: return to A. The resume path runs again and must reuse
			// the one synthetic gate by tool-call id.
			await spaGoto(page, `/project/proj-1/chat/conv-A`);
			const returnedAllow = page.getByRole("button", { name: "Allow" });
			await expect(returnedAllow).toBeVisible();
			await expect(returnedAllow).toHaveCount(1);
			expect(pageErrors, `unexpected browser errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
		},
	);
});

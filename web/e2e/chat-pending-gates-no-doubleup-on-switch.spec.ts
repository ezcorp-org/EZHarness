import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

/**
 * Pending permission gates must retain one visible card when a user switches
 * away from a running conversation and returns to it.
 */

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
		async ({ page, mockApi }) => {
			// Capture Svelte's each_key_duplicate error — when the bug fires it
			// breaks DOM rendering, which is itself a strong proof of the bug.
			const pageErrors: string[] = [];
			page.on("pageerror", (e) => pageErrors.push(e.message));

			// active-run for conv-A includes ONE pending permission. Returned
			// every time the page calls /active-run — including on re-attach.
			await mockApi({
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
								pendingAskUser: [
									{
										toolCallId: "tc-ask-1",
										question: "Keep the local change?",
										options: ["Keep", "Discard"],
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
			await page.getByText("Conv B", { exact: true }).click();
			await expect(page).toHaveURL(/\/project\/proj-1\/chat\/conv-B$/);
			await expect(
				page.getByText("Send a message to start the conversation"),
			).toBeVisible({ timeout: 5000 });

			// ── Step 3: return through the visible conversation control. Capture
			// the second active-run response before checking rendered gates so this
			// cannot pass against A's first mount.
			const returnedActiveRun = page.waitForResponse((response) =>
				response.request().method() === "GET" &&
				response.url().includes("/api/conversations/conv-A/active-run"),
			);
			await page.getByText("Conv A", { exact: true }).click();
			await expect(page).toHaveURL(/\/project\/proj-1\/chat\/conv-A$/);
			await returnedActiveRun;

			const returnedAllow = page.getByRole("button", { name: "Allow" });
			await expect(returnedAllow).toHaveCount(1);
			await expect(page.getByTestId("ask-user-question-card")).toHaveCount(1);
			expect(pageErrors, `unexpected browser errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
		},
	);
});

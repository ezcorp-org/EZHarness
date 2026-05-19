import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

type Page = import("@playwright/test").Page;

/** Wait for the chat page to fully initialize (textarea visible = WS handlers registered). */
async function waitForChatReady(page: Page) {
	await page.locator("textarea").waitFor({ state: "visible" });
	// Small buffer for WS client initialization
	await page.waitForTimeout(300);
}

/** Simulate WS disconnect: fire close listeners, set readyState=CLOSED. */
async function simulateDisconnect(page: Page) {
	await page.evaluate(() => {
		const listeners = (window as any).__fakeWsListeners;
		const ws = (window as any).__fakeWs;
		ws.readyState = 3;
		for (const fn of listeners.close ?? []) {
			fn(new CloseEvent("close", { reason: "" }));
		}
	});
}

/** Simulate WS reconnect: fire open listeners, set readyState=OPEN. */
async function simulateReconnect(page: Page) {
	await page.evaluate(() => {
		const listeners = (window as any).__fakeWsListeners;
		const ws = (window as any).__fakeWs;
		ws.readyState = 1;
		for (const fn of listeners.open ?? []) {
			fn(new Event("open"));
		}
	});
}

/**
 * Simulate enough close events to exhaust MAX_ATTEMPTS (10), reaching "failed" state.
 * Intercepts setTimeout to immediately fire reconnect callbacks.
 */
async function simulateFailed(page: Page) {
	await page.evaluate(() => {
		const listeners = (window as any).__fakeWsListeners;
		const ws = (window as any).__fakeWs;
		const origSetTimeout = window.setTimeout.bind(window);
		const pendingCallbacks: Array<() => void> = [];

		(window as any).setTimeout = (fn: TimerHandler, ...args: any[]) => {
			if (typeof fn === "function" && args[0] && args[0] >= 1000) {
				pendingCallbacks.push(fn as () => void);
				return 999999 as any;
			}
			return origSetTimeout(fn, ...args);
		};

		ws.readyState = 3;
		for (const fn of listeners.close ?? []) {
			fn(new CloseEvent("close", { reason: "" }));
		}

		for (let i = 0; i < 12; i++) {
			while (pendingCallbacks.length > 0) {
				pendingCallbacks.shift()!();
			}
			ws.readyState = 3;
			for (const fn of [...(listeners.close ?? [])]) {
				fn(new CloseEvent("close", { reason: "" }));
			}
		}

		(window as any).setTimeout = origSetTimeout;
	});
}

function chatSetup() {
	const proj = makeProject({ id: "proj-1" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
	return { projects: [proj], conversations: [conv] };
}

// ---- Connection Banner ----

test("connection banner shows on disconnect", async ({ page, mockApi }) => {
	await mockApi(chatSetup());
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	await simulateDisconnect(page);

	await expect(page.getByText(/Connection lost\. Reconnecting/)).toBeVisible();
});

test("connection banner shows Connected flash on reconnect", async ({ page, mockApi }) => {
	await mockApi(chatSetup());
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	await simulateDisconnect(page);
	await expect(page.getByText(/Connection lost/)).toBeVisible();

	await simulateReconnect(page);
	await expect(page.getByText("Connected")).toBeVisible();
});

test("connection banner shows Connection failed with Retry button", async ({ page, mockApi }) => {
	await mockApi(chatSetup());
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	await simulateFailed(page);

	await expect(page.getByText("Connection failed.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

// ---- ChatInput disabled/enabled ----

test("chat input disabled during disconnect", async ({ page, mockApi }) => {
	await mockApi(chatSetup());
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	await simulateDisconnect(page);

	const textarea = page.locator("textarea");
	await expect(textarea).toBeDisabled();
	await expect(textarea).toHaveAttribute("placeholder", "Reconnecting...");
});

test("chat input re-enabled on reconnect", async ({ page, mockApi }) => {
	await mockApi(chatSetup());
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	await simulateDisconnect(page);
	await expect(page.locator("textarea")).toBeDisabled();

	await simulateReconnect(page);

	const textarea = page.locator("textarea");
	await expect(textarea).toBeEnabled();
	await expect(textarea).toHaveAttribute("placeholder", "Send a message...");
});

// ---- Memory Unavailable ----

test("memory unavailable warning appears in chat", async ({ page, mockApi, emitWs }) => {
	await mockApi(chatSetup());
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	await emitWs({ type: "run:status", data: { runId: "run-1", status: "memory_unavailable" } });

	await expect(page.getByText(/Memory is currently unavailable/)).toBeVisible();
});

test("memory warning does not repeat for same run", async ({ page, mockApi, emitWs }) => {
	await mockApi(chatSetup());
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	await emitWs({ type: "run:status", data: { runId: "run-1", status: "memory_unavailable" } });
	await expect(page.getByText(/Memory is currently unavailable/)).toBeVisible();

	await emitWs({ type: "run:status", data: { runId: "run-1", status: "memory_unavailable" } });

	await expect(page.getByText(/Memory is currently unavailable/)).toHaveCount(1);
});

// ---- SystemHealth ----

const settingsRoutes: Record<string, (url: URL) => unknown> = {
	"/api/auth/me": () => ({
		user: { id: "u-1", email: "admin@test.com", name: "Admin", role: "admin" },
	}),
	"/api/users": () => ({ users: [] }),
	"/api/teams": () => ({ teams: [] }),
	"/api/auth/invite": () => ({ invites: [] }),
	"/api/audit-log": () => ({ entries: [], total: 0 }),
	"/api/settings/developer/api-keys": () => ({ keys: [] }),
};

test("system health section visible on settings page", async ({ page, mockApi }) => {
	await mockApi({
		routes: {
			...settingsRoutes,
			"/api/health": (url: URL) => {
				if (url.searchParams.get("detail") === "true") {
					return {
						status: "healthy",
						db: { status: "up" },
						embeddings: { status: "ready" },
						providers: {
							anthropic: { status: "configured" },
							openai: { status: "not_configured" },
							google: { status: "not_configured" },
						},
					};
				}
				return { status: "healthy" };
			},
		},
	});
	await page.goto("/settings");

	await expect(page.getByText("System Health")).toBeVisible();
	await expect(page.getByText("healthy").first()).toBeVisible();
	await expect(page.getByText("Database")).toBeVisible();
	await expect(page.getByText("Embeddings")).toBeVisible();
});

test("system health shows degraded state with db down", async ({ page, mockApi }) => {
	await mockApi({
		routes: {
			...settingsRoutes,
			"/api/health": () => ({
				status: "degraded",
				db: { status: "down" },
				embeddings: { status: "ready" },
				providers: {},
			}),
		},
	});
	await page.goto("/settings");

	await expect(page.getByText("System Health")).toBeVisible();
	await expect(page.getByText("degraded")).toBeVisible();
	await expect(page.getByText("down")).toBeVisible();
});

test("system health handles error gracefully", async ({ page, mockApi }) => {
	await mockApi({ routes: settingsRoutes });

	await page.route("**/api/health**", (route) => {
		route.fulfill({ status: 401, json: { error: "Unauthorized" } });
	});

	await page.goto("/settings");

	await expect(page.getByText("System Health")).toBeVisible();
	await expect(page.getByText("Unable to load health status.")).toBeVisible();
});

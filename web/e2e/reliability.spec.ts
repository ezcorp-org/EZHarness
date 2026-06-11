import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

type Page = import("@playwright/test").Page;

/** Wait for the chat page to fully initialize (textarea visible = WS handlers registered). */
async function waitForChatReady(page: Page) {
	await page.locator("textarea").waitFor({ state: "visible" });
	// Small buffer for WS client initialization
	await page.waitForTimeout(300);
}

/**
 * Self-contained SSE outage harness.
 *
 * `ws.ts` talks to the runtime-events stream over EventSource. The shared
 * `setupWsMock` fake auto-opens every EventSource, so it cannot model a
 * *sustained* outage (each reconnect instantly succeeds). This installs a
 * controllable FakeEventSource driven by `__setSseDown`, plus a setTimeout
 * queue split into two lanes — the 5s connection grace
 * (CONNECTION_GRACE_MS in src/lib/connection-grace.ts) and the >=1s
 * reconnect backoff — so each can be advanced independently and
 * deterministically with no real waits.
 *
 * Registered AFTER `mockApi` so its `window.EventSource` / `setTimeout`
 * overrides win over `setupWsMock`'s.
 */
const GRACE_MS = 5000; // keep in sync with CONNECTION_GRACE_MS

async function installSseOutageHarness(page: Page) {
	await page.addInitScript((graceMs) => {
		const instances: any[] = [];
		let down = false;
		(window as any).__setSseDown = (v: boolean) => {
			down = v;
		};

		class FakeEventSource {
			onopen: ((e: Event) => void) | null = null;
			onmessage: ((e: MessageEvent) => void) | null = null;
			onerror: ((e: Event) => void) | null = null;
			readyState = 0;
			url: string;
			constructor(url: string) {
				this.url = url;
				instances.push(this);
				queueMicrotask(() => {
					if (down) {
						this.readyState = 2;
						this.onerror?.(new Event("error"));
					} else {
						this.readyState = 1;
						this.onopen?.(new Event("open"));
					}
				});
			}
			close() {
				this.readyState = 2;
			}
			addEventListener() {}
			removeEventListener() {}
		}
		(window as any).EventSource = FakeEventSource;
		(window as any).__fakeES = instances;

		// Two timer lanes. Each drains one FIFO snapshot per call, so
		// callbacks enqueued *while* flushing wait for the next pump.
		const realSetTimeout = window.setTimeout;
		const graceQ: Array<() => void> = [];
		const otherQ: Array<() => void> = [];
		const drain = (q: Array<() => void>) => {
			const n = q.length;
			for (let i = 0; i < n; i++) q.shift()!();
		};
		(window as any).__fireGrace = () => drain(graceQ);
		(window as any).__fireReconnect = () => drain(otherQ);
		(window as any).setTimeout = ((fn: TimerHandler, delay?: number, ...a: any[]) => {
			if (typeof fn === "function" && (delay ?? 0) >= 1000) {
				((delay ?? 0) === graceMs ? graceQ : otherQ).push(() => (fn as any)(...a));
				return 0 as any;
			}
			return realSetTimeout(fn as any, delay, ...a);
		}) as typeof window.setTimeout;
	}, GRACE_MS);
}

/** Drop the SSE stream and keep it down (reconnects also error). */
async function dropSse(page: Page) {
	await page.evaluate(() => {
		(window as any).__setSseDown(true);
		const list = (window as any).__fakeES as any[];
		const latest = list[list.length - 1];
		if (latest) {
			latest.readyState = 2;
			latest.onerror?.(new Event("error"));
		}
	});
}

/** Fire pending reconnect-backoff timers (each cycle re-errors while down). */
async function pumpReconnect(page: Page) {
	await page.evaluate(() => (window as any).__fireReconnect());
	await page.waitForTimeout(50);
}

/** Fire the 5s grace timer (surfaces the banner / disabled input). */
async function elapseGrace(page: Page) {
	await page.evaluate(() => (window as any).__fireGrace());
	await page.waitForTimeout(50);
}

/** Bring the SSE stream back; the next reconnect attempt succeeds. */
async function restoreSse(page: Page) {
	await page.evaluate(() => {
		(window as any).__setSseDown(false);
		(window as any).__fireReconnect();
	});
	await page.waitForTimeout(50);
}

function chatSetup() {
	const proj = makeProject({ id: "proj-1" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
	return { projects: [proj], conversations: [conv] };
}

// ---- Connection Banner + ChatInput grace window ----

test("connection UI stays hidden during the grace window, then surfaces", async ({
	page,
	mockApi,
}) => {
	await mockApi(chatSetup());
	await installSseOutageHarness(page);
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	await dropSse(page);
	// Still within the grace window — a reconnect cycle has already failed
	// but the user must see nothing: no banner, input fully usable.
	await pumpReconnect(page);
	await expect(page.getByText(/Connection lost/)).toHaveCount(0);
	const textarea = page.locator("textarea");
	await expect(textarea).toBeEnabled();
	await expect(textarea).toHaveAttribute("placeholder", "Send a message...");

	// Grace elapses with the connection still down → now it surfaces.
	await elapseGrace(page);
	await expect(page.getByText(/Connection lost\. Reconnecting/)).toBeVisible();
	await expect(textarea).toBeDisabled();
	await expect(textarea).toHaveAttribute("placeholder", "Reconnecting...");
});

test("a brief (sub-grace) connection blip never shows any UI", async ({ page, mockApi }) => {
	await mockApi(chatSetup());
	await installSseOutageHarness(page);
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	await dropSse(page);
	// Recover before the grace timer fires.
	await restoreSse(page);
	// A late grace timer must be a no-op (already recovered).
	await elapseGrace(page);

	await expect(page.getByText(/Connection lost/)).toHaveCount(0);
	// No green "Connected" flash either — nothing was ever disrupted.
	await expect(page.getByText("Connected")).toHaveCount(0);
	const textarea = page.locator("textarea");
	await expect(textarea).toBeEnabled();
	await expect(textarea).toHaveAttribute("placeholder", "Send a message...");
});

test("Connected flash + re-enabled input after a real (post-grace) outage", async ({
	page,
	mockApi,
}) => {
	await mockApi(chatSetup());
	await installSseOutageHarness(page);
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	await dropSse(page);
	await elapseGrace(page);
	await expect(page.getByText(/Connection lost/)).toBeVisible();

	await restoreSse(page);
	await expect(page.getByText("Connected")).toBeVisible();
	const textarea = page.locator("textarea");
	await expect(textarea).toBeEnabled();
	await expect(textarea).toHaveAttribute("placeholder", "Send a message...");
});

test("connection banner shows Connection failed with Retry button", async ({ page, mockApi }) => {
	await mockApi(chatSetup());
	await installSseOutageHarness(page);
	await page.goto("/project/proj-1/chat/conv-1");
	await waitForChatReady(page);

	// Exhaust MAX_ATTEMPTS (10) reconnect cycles → terminal "failed"
	// (bypasses the grace window since it is unreachable before it).
	await dropSse(page);
	for (let i = 0; i < 14; i++) await pumpReconnect(page);

	await expect(page.getByText("Connection failed.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
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
	await page.goto("/settings/admin");

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
	await page.goto("/settings/admin");

	await expect(page.getByText("System Health")).toBeVisible();
	await expect(page.getByText("degraded")).toBeVisible();
	await expect(page.getByText("down")).toBeVisible();
});

test("system health handles error gracefully", async ({ page, mockApi }) => {
	await mockApi({ routes: settingsRoutes });

	await page.route("**/api/health**", (route) => {
		route.fulfill({ status: 401, json: { error: "Unauthorized" } });
	});

	await page.goto("/settings/admin");

	await expect(page.getByText("System Health")).toBeVisible();
	await expect(page.getByText("Unable to load health status.")).toBeVisible();
});

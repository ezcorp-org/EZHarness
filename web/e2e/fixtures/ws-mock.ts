import type { Page } from "@playwright/test";

/**
 * Inject a fake WebSocket AND a fake EventSource that both capture
 * construction attempts and expose handles on `window.__fakeWs` /
 * `window.__fakeEventSources` for emitting events from test code.
 *
 * Both transports are stubbed because the app originally used WebSockets
 * for runtime events and later migrated the runtime-events stream to
 * Server-Sent Events (`/api/runtime-events` via EventSource). Without
 * the EventSource stub, the real constructor hits the mocked API layer
 * (which has no SSE handler), errors out, and flips the connection
 * store into `"reconnecting"` — which disables the chat textarea and
 * breaks every spec that tries to type into it.
 */
export async function setupWsMock(page: Page) {
	await page.addInitScript(() => {
		// ── WebSocket stub ─────────────────────────────────────────
		const wsListeners: Record<string, Array<(e: MessageEvent) => void>> = {
			open: [],
			message: [],
			close: [],
			error: [],
		};

		const fakeWs = {
			readyState: 1, // OPEN
			send() {},
			close() {},
			addEventListener(type: string, fn: (e: MessageEvent) => void) {
				(wsListeners[type] ??= []).push(fn);
			},
			removeEventListener(type: string, fn: (e: MessageEvent) => void) {
				const arr = wsListeners[type];
				if (arr) wsListeners[type] = arr.filter((f) => f !== fn);
			},
			set onopen(fn: ((e: Event) => void) | null) {
				if (fn) (wsListeners["open"] ??= []).push(fn as any);
			},
			set onmessage(fn: ((e: MessageEvent) => void) | null) {
				if (fn) (wsListeners["message"] ??= []).push(fn);
			},
			set onclose(fn: ((e: CloseEvent) => void) | null) {
				if (fn) (wsListeners["close"] ??= []).push(fn as any);
			},
			set onerror(fn: ((e: Event) => void) | null) {
				if (fn) (wsListeners["error"] ??= []).push(fn as any);
			},
		};

		queueMicrotask(() => {
			for (const fn of wsListeners["open"] ?? []) {
				fn(new Event("open") as any);
			}
		});

		(window as any).__fakeWs = fakeWs;
		(window as any).__fakeWsListeners = wsListeners;

		(window as any).WebSocket = () => fakeWs;
		(window as any).WebSocket.CONNECTING = 0;
		(window as any).WebSocket.OPEN = 1;
		(window as any).WebSocket.CLOSING = 2;
		(window as any).WebSocket.CLOSED = 3;

		// ── EventSource stub (SSE runtime-events) ──────────────────
		// We expose two handles per instance:
		//   - `listeners`: explicit `addEventListener` registrations
		//   - `instance`:  the FakeEventSource itself, so tests can
		//     emit a frame even when the consumer used `es.onmessage = …`
		//     (the Ez panel does this rather than addEventListener).
		const esInstances: Array<{
			url: string;
			listeners: Record<string, Array<(e: MessageEvent) => void>>;
			instance: any;
		}> = [];

		class FakeEventSource {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSED = 2;
			readyState = 1;
			url: string;
			onopen: ((e: Event) => void) | null = null;
			onmessage: ((e: MessageEvent) => void) | null = null;
			onerror: ((e: Event) => void) | null = null;
			private listeners: Record<string, Array<(e: MessageEvent) => void>> = {
				open: [],
				message: [],
				error: [],
			};
			constructor(url: string) {
				this.url = url;
				esInstances.push({ url, listeners: this.listeners, instance: this });
				// Fire open on next tick so the client's `onopen` handler can
				// register before the event lands. This drives the connection
				// store to `"connected"` and enables the textarea.
				queueMicrotask(() => {
					this.readyState = 1;
					const evt = new Event("open");
					this.onopen?.(evt);
					for (const fn of this.listeners.open ?? []) fn(evt as any);
				});
			}
			addEventListener(type: string, fn: (e: MessageEvent) => void) {
				(this.listeners[type] ??= []).push(fn);
			}
			removeEventListener(type: string, fn: (e: MessageEvent) => void) {
				const arr = this.listeners[type];
				if (arr) this.listeners[type] = arr.filter((f) => f !== fn);
			}
			close() {
				this.readyState = 2;
			}
		}

		(window as any).EventSource = FakeEventSource;
		(window as any).__fakeEventSources = esInstances;
	});
}

/**
 * Emit a Server-Sent Event into the page's fake EventSource(s).
 *
 * `urlMatch` lets specs target a specific stream (e.g. only the Ez
 * panel's `/api/runtime-events?conversationId=ez-conv-1`). When omitted
 * the most-recently-constructed EventSource is used — convenient for
 * specs that only have one stream open.
 */
export async function emitSseEvent(
	page: Page,
	event: { type: string; data: unknown },
	urlMatch?: string,
) {
	await page.evaluate(({ event, urlMatch }) => {
		const all = (window as any).__fakeEventSources as Array<{
			url: string;
			listeners: Record<string, Array<(e: MessageEvent) => void>>;
			instance: any;
		}>;
		if (!Array.isArray(all) || all.length === 0) return;
		const target = urlMatch ? all.find((es) => es.url.includes(urlMatch)) : all[all.length - 1];
		if (!target) return;
		const messageEvent = new MessageEvent("message", { data: JSON.stringify(event) });
		// Fire both wiring shapes — `addEventListener('message')` and
		// `es.onmessage = fn`. The Ez panel uses the latter.
		for (const fn of target.listeners.message ?? []) fn(messageEvent);
		target.instance?.onmessage?.(messageEvent);
	}, { event, urlMatch });
}

/**
 * Emit a WebSocket event into the page's fake WS.
 */
export async function emitWsEvent(page: Page, event: { type: string; data: unknown }) {
	await page.evaluate((evt) => {
		const listeners = (window as any).__fakeWsListeners;
		if (!listeners?.message) return;
		const messageEvent = new MessageEvent("message", {
			data: JSON.stringify(evt),
		});
		for (const fn of listeners.message) {
			fn(messageEvent);
		}
	}, event);
}

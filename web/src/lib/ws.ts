import { connectionState } from "./stores/connection";

export type WSConnectionEvent =
	| { type: "ws:connected"; data: Record<string, never> }
	| { type: "ws:disconnected"; data: { reason?: string } };

export type WSRunEvent = {
	type: "run:start" | "run:status" | "run:log" | "run:complete" | "run:error" | "run:cancel"
		| "run:token" | "run:usage" | "run:turn_saved" | "run:turn_text_reset"
		| "pipeline:start" | "pipeline:step" | "pipeline:complete" | "pipeline:error"
		| "tool:start" | "tool:complete" | "tool:error" | "tool:permission_request"
		| "agent:spawn" | "agent:status" | "agent:complete"
		| "orchestrator:human_input" | "orchestrator:human_response"
		| "task:snapshot" | "task:assignment_update"
		| "ext:state";
	data: Record<string, unknown>;
};

export type WSEvent = WSConnectionEvent | WSRunEvent;

type Subscriber = (event: WSEvent) => void;

export const MAX_ATTEMPTS = 10;
export const BASE_DELAY = 1000;
export const MAX_DELAY = 30000;

export function getBackoffDelay(attempt: number): number {
	return Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_DELAY);
}

/**
 * Create a client that connects to the runtime event bus via Server-Sent
 * Events (SSE) on `/api/runtime-events`.
 *
 * SSE replaces the previous WebSocket transport because:
 *   - The event stream is server→client only (the client never sends data).
 *   - SSE is plain HTTP — no socket upgrade — so it works identically
 *     through vite dev, svelte-adapter-bun, and any HTTP proxy (tailscale
 *     HTTPS, LAN, containers).
 *   - Bun's node:http compat layer has a broken upgrade handoff that makes
 *     vite-level WS proxying impossible (socket writes are silently lost).
 *   - Auth inherits the session cookie from hooks.server.ts Handle — no
 *     separate devToken plumbing needed.
 *
 * The public interface (subscribe, close, manualRetry) is identical to the
 * previous WebSocket client so no downstream consumer changes are needed.
 */
export function createWSClient() {
	let es: EventSource | null = null;
	let subscribers: Subscriber[] = [];
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;
	let attempt = 0;

	function updateState(state: "connected" | "disconnected" | "reconnecting" | "failed") {
		connectionState.set({ state, attempt, maxAttempts: MAX_ATTEMPTS });
	}

	function connect() {
		if (closed) return;

		es = new EventSource("/api/runtime-events");

		es.onopen = () => {
			attempt = 0;
			updateState("connected");
			subscribers.forEach((fn) => fn({ type: "ws:connected", data: {} }));
		};

		es.onmessage = (event) => {
			try {
				const parsed: WSEvent = JSON.parse(event.data);
				subscribers.forEach((fn) => fn(parsed));
			} catch {
				// ignore malformed messages or heartbeat comments
			}
		};

		es.onerror = () => {
			// EventSource fires error on both connection failure and stream
			// end. Close the current source and schedule a reconnect.
			es?.close();
			es = null;
			subscribers.forEach((fn) => fn({ type: "ws:disconnected", data: {} }));
			scheduleReconnect();
		};
	}

	function scheduleReconnect() {
		if (closed) return;
		if (reconnectTimer) clearTimeout(reconnectTimer);

		if (attempt >= MAX_ATTEMPTS) {
			updateState("failed");
			return;
		}

		updateState("reconnecting");
		const delay = getBackoffDelay(attempt);
		attempt++;
		reconnectTimer = setTimeout(connect, delay);
	}

	function manualRetry() {
		attempt = 0;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		updateState("reconnecting");
		connect();
	}

	// Tab visibility: reconnect immediately when user returns
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden) {
				connectionState.subscribe((s) => {
					if (s.state !== "connected") {
						if (reconnectTimer) clearTimeout(reconnectTimer);
						attempt = 0;
						connect();
					}
				})(); // subscribe and immediately unsubscribe
			}
		});
	}

	connect();

	return {
		subscribe(fn: Subscriber) {
			subscribers.push(fn);
			return () => {
				subscribers = subscribers.filter((s) => s !== fn);
			};
		},
		close() {
			closed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			es?.close();
		},
		manualRetry,
	};
}

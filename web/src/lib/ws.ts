import { connectionState } from "./stores/connection";
import { gatedConnectionState, CONNECTION_GRACE_MS } from "./connection-grace";

export type WSConnectionEvent =
	| { type: "ws:connected"; data: Record<string, never> }
	| { type: "ws:disconnected"; data: { reason?: string } };

export type WSRunEvent = {
	type: "run:start" | "run:status" | "run:log" | "run:complete" | "run:error" | "run:cancel"
		| "run:token" | "run:usage" | "run:turn_saved" | "run:turn_text_reset"
		| "pipeline:start" | "pipeline:step" | "pipeline:complete" | "pipeline:error"
		| "tool:start" | "tool:complete" | "tool:error" | "tool:permission_request"
		| "agent:spawn" | "agent:status" | "agent:complete"
		| "task:snapshot" | "task:assignment_update"
		// Ez concierge client-side tool delivery (Phase 48 Wave 3+). The
		// runtime emits this when the LLM calls fill_form / navigate_to;
		// the global subscriber re-dispatches it as a `ez:client-tool`
		// window CustomEvent so EzPanel can route it through the
		// client-tool dispatcher. Routed (rather than letting EzPanel keep
		// its own EventSource) so Ez follows the same SSE consumption
		// pattern the chat page uses.
		| "ez:client-tool"
		| "ext:state"
		// agent-install-ux-polish Phase 2: user-scoped live Library
		// refresh. The global subscriber re-dispatches it as an
		// `extensions:installed` window CustomEvent so the Extensions
		// Library page can trigger its cache-bypassing reload without
		// owning a second EventSource (same pattern as ez:client-tool).
		// Server-side `shouldDeliverEvent` already guarantees this only
		// reaches the installing user's session.
		| "extensions:installed"
		// Daily Briefing Phase 2: server-initiated conversation delivery.
		// USER-scoped by the SSE filter (fail-closed), so an event arriving
		// here already means "this user owns it". The global subscriber
		// marks the conversation unread and re-dispatches it as a window
		// CustomEvent so the sidebar ConversationList can live-refresh
		// without a second EventSource. (`briefing:delivered` stays
		// server-side only — backend bookkeeping/tests consume it, no
		// client does, so it is intentionally NOT in this union.)
		| "conversation:created";
	data: Record<string, unknown>;
};

export type WSEvent = WSConnectionEvent | WSRunEvent;

type Subscriber = (event: WSEvent) => void;

// fallow-ignore-next-line unused-export
export const MAX_ATTEMPTS = 10;
// fallow-ignore-next-line unused-export
export const BASE_DELAY = 1000;
// fallow-ignore-next-line unused-export
export const MAX_DELAY = 30000;

// fallow-ignore-next-line unused-export
export function getBackoffDelay(attempt: number): number {
	return Math.min(BASE_DELAY * 2 ** attempt, MAX_DELAY);
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

	// Connection-issue UI (banner + disabled chat input) is gated behind a
	// grace window: a transient blip shorter than CONNECTION_GRACE_MS never
	// surfaces, so flaky networks don't flicker the UI. The reconnect/backoff
	// loop below is unaffected — only what we publish to `connectionState` is
	// delayed. `problemActive` tracks the current uninterrupted problem;
	// `graceElapsed` flips once the timer fires (the timer firing IS the
	// signal that the grace window passed). `lastRaw` is the latest raw
	// transport state, used when the timer flushes the now-visible state.
	let problemActive = false;
	let graceElapsed = false;
	let graceTimer: ReturnType<typeof setTimeout> | null = null;
	let lastRaw: "connected" | "disconnected" | "reconnecting" | "failed" = "connected";

	function publish(state: "connected" | "disconnected" | "reconnecting" | "failed") {
		connectionState.set({ state, attempt, maxAttempts: MAX_ATTEMPTS });
	}

	function clearGraceTimer() {
		if (graceTimer) {
			clearTimeout(graceTimer);
			graceTimer = null;
		}
	}

	function updateState(raw: "connected" | "disconnected" | "reconnecting" | "failed") {
		lastRaw = raw;

		if (raw === "connected") {
			problemActive = false;
			graceElapsed = false;
			clearGraceTimer();
			publish("connected");
			return;
		}

		// "failed" is only reached after the full reconnect backoff (far
		// longer than the grace window) and is terminal — surface it now.
		if (raw === "failed") {
			clearGraceTimer();
			publish("failed");
			return;
		}

		// "disconnected" | "reconnecting" — gate behind the grace window.
		if (!problemActive) {
			problemActive = true;
			graceElapsed = false;
			graceTimer = setTimeout(() => {
				graceTimer = null;
				graceElapsed = true;
				if (problemActive) {
					publish(gatedConnectionState(lastRaw, CONNECTION_GRACE_MS));
				}
			}, CONNECTION_GRACE_MS);
		}

		publish(gatedConnectionState(raw, graceElapsed ? CONNECTION_GRACE_MS : 0));
	}

	function connect() {
		if (closed) return;

		es = new EventSource("/api/runtime-events");

		es.onopen = () => {
			attempt = 0;
			updateState("connected");
			subscribers.forEach((fn) => {
				fn({ type: "ws:connected", data: {} });
			});
		};

		es.onmessage = (event) => {
			try {
				const parsed: WSEvent = JSON.parse(event.data);
				subscribers.forEach((fn) => {
					fn(parsed);
				});
			} catch {
				// ignore malformed messages or heartbeat comments
			}
		};

		es.onerror = () => {
			// EventSource fires error on both connection failure and stream
			// end. Close the current source and schedule a reconnect.
			es?.close();
			es = null;
			subscribers.forEach((fn) => {
				fn({ type: "ws:disconnected", data: {} });
			});
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
			clearGraceTimer();
			es?.close();
		},
		manualRetry,
	};
}

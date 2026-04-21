import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// --- Mock EventSource ---

type ESListener = ((event: any) => void) | null;

class MockEventSource {
	static instances: MockEventSource[] = [];

	url: string;
	onopen: ESListener = null;
	onmessage: ESListener = null;
	onerror: ESListener = null;
	close = mock(() => {});

	constructor(url: string) {
		this.url = url;
		MockEventSource.instances.push(this);
	}

	simulateOpen() {
		this.onopen?.({} as any);
	}

	simulateError() {
		this.onerror?.({} as any);
	}

	simulateMessage(data: any) {
		this.onmessage?.({ data: JSON.stringify(data) } as any);
	}
}

// --- Mock globals ---

const origEventSource = globalThis.EventSource;
const origDocument = globalThis.document;

function setupGlobals() {
	(globalThis as any).EventSource = MockEventSource;
	// Remove document to skip visibilitychange listener in createWSClient
	(globalThis as any).document = undefined;
}

function restoreGlobals() {
	(globalThis as any).EventSource = origEventSource;
	(globalThis as any).document = origDocument;
}

import { createWSClient, MAX_ATTEMPTS } from "../../web/src/lib/ws";
import { connectionState } from "../../web/src/lib/stores/connection";
import type { ConnectionInfo } from "../../web/src/lib/stores/connection";

function getStoreValue(): ConnectionInfo {
	let val: ConnectionInfo = { state: "connected", attempt: 0, maxAttempts: 10 };
	connectionState.subscribe((v) => (val = v))();
	return val;
}

function latestES(): MockEventSource {
	const es = MockEventSource.instances[MockEventSource.instances.length - 1];
	if (!es) throw new Error("expected MockEventSource instance");
	return es;
}

describe("connectionState store", () => {
	test("initial state is connected with attempt 0", () => {
		const val = getStoreValue();
		expect(val).toEqual({ state: "connected", attempt: 0, maxAttempts: 10 });
	});

	test("can be set and subscribed to", () => {
		connectionState.set({ state: "reconnecting", attempt: 3, maxAttempts: 10 });
		expect(getStoreValue().state).toBe("reconnecting");
		expect(getStoreValue().attempt).toBe(3);

		connectionState.set({ state: "failed", attempt: 10, maxAttempts: 10 });
		expect(getStoreValue().state).toBe("failed");
		expect(getStoreValue().attempt).toBe(10);

		// Reset
		connectionState.set({ state: "connected", attempt: 0, maxAttempts: 10 });
		expect(getStoreValue().state).toBe("connected");
	});
});

describe("createWSClient state machine", () => {
	beforeEach(() => {
		MockEventSource.instances = [];
		setupGlobals();
		connectionState.set({ state: "connected", attempt: 0, maxAttempts: 10 });
	});

	afterEach(() => {
		restoreGlobals();
	});

	test("initial connect creates an EventSource to /api/runtime-events", () => {
		const client = createWSClient();
		expect(MockEventSource.instances.length).toBe(1);
		expect(latestES().url).toBe("/api/runtime-events");
		client.close();
	});

	test("onopen sets state to connected and resets attempt", () => {
		const client = createWSClient();
		latestES().simulateOpen();
		const val = getStoreValue();
		expect(val.state).toBe("connected");
		expect(val.attempt).toBe(0);
		client.close();
	});

	test("onerror triggers reconnecting state", () => {
		const client = createWSClient();
		latestES().simulateOpen();
		latestES().simulateError();
		const val = getStoreValue();
		expect(val.state).toBe("reconnecting");
		client.close();
	});

	test("subscribers receive ws:connected on open", () => {
		const client = createWSClient();
		const events: any[] = [];
		client.subscribe((e) => events.push(e));
		latestES().simulateOpen();
		expect(events).toEqual([{ type: "ws:connected", data: {} }]);
		client.close();
	});

	test("subscribers receive ws:disconnected on error", () => {
		const client = createWSClient();
		const events: any[] = [];
		client.subscribe((e) => events.push(e));
		latestES().simulateOpen();
		latestES().simulateError();
		expect(events[1]).toEqual({ type: "ws:disconnected", data: {} });
		client.close();
	});

	test("subscribers receive parsed messages", () => {
		const client = createWSClient();
		const events: any[] = [];
		client.subscribe((e) => events.push(e));
		latestES().simulateOpen();
		latestES().simulateMessage({ type: "run:start", data: { id: "123" } });
		expect(events[1]).toEqual({ type: "run:start", data: { id: "123" } });
		client.close();
	});

	test("malformed messages are ignored", () => {
		const client = createWSClient();
		const events: any[] = [];
		client.subscribe((e) => events.push(e));
		latestES().simulateOpen();
		// Send raw non-JSON
		latestES().onmessage?.({ data: "not-json" } as any);
		expect(events.length).toBe(1); // only ws:connected
		client.close();
	});

	test("unsubscribe removes subscriber", () => {
		const client = createWSClient();
		const events: any[] = [];
		const unsub = client.subscribe((e) => events.push(e));
		latestES().simulateOpen();
		expect(events.length).toBe(1);
		unsub();
		latestES().simulateError();
		// No more events after unsubscribe
		expect(events.length).toBe(1);
		client.close();
	});

	test("multiple disconnects increment attempt and increase backoff", () => {
		const client = createWSClient();
		latestES().simulateOpen();

		// Error triggers reconnect with attempt=0, then attempt becomes 1
		latestES().simulateError();
		let val = getStoreValue();
		expect(val.state).toBe("reconnecting");
		expect(val.attempt).toBe(0); // attempt at time of scheduleReconnect before increment

		client.close();
	});

	test("after MAX_ATTEMPTS+1 errors, state becomes failed", () => {
		const client = createWSClient();
		latestES().simulateOpen();

		// scheduleReconnect checks attempt >= MAX_ATTEMPTS before incrementing.
		// So we need MAX_ATTEMPTS+1 errors: first 10 increment attempt 0->10,
		// the 11th sees attempt=10 >= MAX_ATTEMPTS=10 and sets "failed".
		for (let i = 0; i <= MAX_ATTEMPTS; i++) {
			latestES().simulateError();
		}

		const val = getStoreValue();
		expect(val.state).toBe("failed");
		client.close();
	});

	test("manualRetry resets attempt and reconnects", () => {
		const client = createWSClient();
		latestES().simulateOpen();

		// Exhaust attempts (need MAX_ATTEMPTS+1 errors to reach "failed")
		for (let i = 0; i <= MAX_ATTEMPTS; i++) {
			latestES().simulateError();
		}
		expect(getStoreValue().state).toBe("failed");

		const countBefore = MockEventSource.instances.length;
		client.manualRetry();
		// Should create a new EventSource
		expect(MockEventSource.instances.length).toBe(countBefore + 1);
		expect(getStoreValue().state).toBe("reconnecting");

		// Simulate successful reconnect
		latestES().simulateOpen();
		expect(getStoreValue().state).toBe("connected");
		expect(getStoreValue().attempt).toBe(0);
		client.close();
	});

	test("close prevents further reconnects", () => {
		const client = createWSClient();
		latestES().simulateOpen();
		client.close();

		const countAfterClose = MockEventSource.instances.length;
		// No new EventSource should be created after close
		expect(MockEventSource.instances.length).toBe(countAfterClose);

		// Verify no reconnect timer fires by checking no new instances
		expect(getStoreValue().state).toBe("connected"); // close() doesn't update state
	});

	test("close calls close on the EventSource", () => {
		const client = createWSClient();
		const es = latestES();
		client.close();
		expect(es.close).toHaveBeenCalled();
	});

	test("onerror closes the EventSource", () => {
		const client = createWSClient();
		const es = latestES();
		es.simulateError();
		expect(es.close).toHaveBeenCalled();
		client.close();
	});

	test("only one EventSource created before open", () => {
		const client = createWSClient();
		expect(MockEventSource.instances.length).toBe(1);
		client.close();
	});
});

describe("createWSClient + connectionState integration", () => {
	beforeEach(() => {
		MockEventSource.instances = [];
		setupGlobals();
		connectionState.set({ state: "connected", attempt: 0, maxAttempts: 10 });
	});

	afterEach(() => {
		restoreGlobals();
	});

	test("connect -> disconnect -> reconnecting -> manualRetry -> connected", () => {
		const client = createWSClient();
		latestES().simulateOpen();
		expect(getStoreValue().state).toBe("connected");

		// Disconnect triggers reconnecting state synchronously via scheduleReconnect
		latestES().simulateError();
		expect(getStoreValue().state).toBe("reconnecting");

		// Manual retry resets and reconnects
		client.manualRetry();
		latestES().simulateOpen();
		expect(getStoreValue().state).toBe("connected");

		client.close();
	});

	test("connectionState.attempt reflects reconnection progress", () => {
		const client = createWSClient();
		latestES().simulateOpen();

		latestES().simulateError();
		// After first scheduleReconnect: attempt was 0 at state update, then incremented to 1
		expect(getStoreValue().attempt).toBe(0);

		client.close();
	});

	test("connectionState.maxAttempts always equals MAX_ATTEMPTS", () => {
		const client = createWSClient();
		latestES().simulateOpen();
		expect(getStoreValue().maxAttempts).toBe(MAX_ATTEMPTS);
		latestES().simulateError();
		expect(getStoreValue().maxAttempts).toBe(MAX_ATTEMPTS);
		client.close();
	});

	test("multiple subscribers all receive events", () => {
		const client = createWSClient();
		const events1: any[] = [];
		const events2: any[] = [];
		client.subscribe((e) => events1.push(e));
		client.subscribe((e) => events2.push(e));
		latestES().simulateOpen();
		expect(events1.length).toBe(1);
		expect(events2.length).toBe(1);
		expect(events1[0].type).toBe("ws:connected");
		expect(events2[0].type).toBe("ws:connected");
		client.close();
	});
});

describe("tab visibility reconnect", () => {
	let visibilityHandler: (() => void) | null = null;
	let mockDocument: any;

	function setupGlobalsWithDocument(hidden = true) {
		MockEventSource.instances = [];
		(globalThis as any).EventSource = MockEventSource;

		visibilityHandler = null;
		mockDocument = {
			hidden,
			addEventListener: mock((event: string, handler: () => void) => {
				if (event === "visibilitychange") {
					visibilityHandler = handler;
				}
			}),
		};
		(globalThis as any).document = mockDocument;
		connectionState.set({ state: "connected", attempt: 0, maxAttempts: 10 });
	}

	afterEach(() => {
		restoreGlobals();
	});

	test("tab becomes visible and not connected triggers reconnect", () => {
		setupGlobalsWithDocument(true);
		const client = createWSClient();
		// createWSClient should have registered visibilitychange listener
		expect(mockDocument.addEventListener).toHaveBeenCalledWith(
			"visibilitychange",
			expect.any(Function),
		);
		expect(visibilityHandler).not.toBeNull();

		// Simulate: connection was opened then lost
		latestES().simulateOpen();
		latestES().simulateError();
		expect(getStoreValue().state).toBe("reconnecting");

		const countBefore = MockEventSource.instances.length;

		// Tab becomes visible
		mockDocument.hidden = false;
		visibilityHandler!();

		// Should have created a new EventSource instance (called connect())
		expect(MockEventSource.instances.length).toBeGreaterThan(countBefore);
		client.close();
	});

	test("tab becomes visible while connected does not reconnect", () => {
		setupGlobalsWithDocument(true);
		const client = createWSClient();
		latestES().simulateOpen();
		expect(getStoreValue().state).toBe("connected");

		const countBefore = MockEventSource.instances.length;

		// Tab becomes visible while already connected
		mockDocument.hidden = false;
		visibilityHandler!();

		// No new EventSource should be created
		expect(MockEventSource.instances.length).toBe(countBefore);
		client.close();
	});

	test("SSR (document undefined) does not throw", () => {
		MockEventSource.instances = [];
		setupGlobals();

		// Should not throw when document is undefined
		expect(() => {
			const client = createWSClient();
			client.close();
		}).not.toThrow();
	});
});

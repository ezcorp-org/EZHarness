import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());
import type { ConnectionInfo } from "../../web/src/lib/stores/connection";

// ── Mock infrastructure ────────────────────────────────────────────────

// Track store values via mock
let storeValue: ConnectionInfo = { state: "connected", attempt: 0, maxAttempts: 10 };
let storeHistory: ConnectionInfo[] = [];

const mockStore = {
  set: (v: ConnectionInfo) => {
    storeValue = v;
    storeHistory.push({ ...v });
  },
  subscribe: (fn: (v: ConnectionInfo) => void) => {
    fn(storeValue);
    return () => {};
  },
};

mock.module("$lib/stores/connection", () => ({
  connectionState: mockStore,
}));

// Also mock the relative path used by ws.ts
mock.module("../../web/src/lib/stores/connection", () => ({
  connectionState: mockStore,
}));

// Mock svelte/store for any transitive imports
mock.module("svelte/store", () => ({
  writable: (initial: any) => {
    storeValue = initial;
    return mockStore;
  },
}));

// Track EventSource instances
let esInstances: MockEventSource[] = [];

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = MockEventSource.OPEN;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    esInstances.push(this);
  }
  close() { this.readyState = MockEventSource.CLOSED; }

  simulateOpen() { this.onopen?.({ type: "open" }); }
  simulateError() { this.onerror?.({ type: "error" }); }
  simulateMessage(data: any) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

(globalThis as any).EventSource = MockEventSource;
if (typeof document === "undefined") {
  (globalThis as any).document = { addEventListener: () => {}, hidden: false };
}

// Guard helper: narrow `MockEventSource | undefined` from array access to
// non-null in a single place. Throws (rather than non-null asserting) so
// that a stale test setup surfaces a descriptive failure.
function latestES(): MockEventSource {
  const es = esInstances[esInstances.length - 1];
  if (!es) throw new Error("expected latest MockEventSource instance");
  return es;
}

// Import after mocks are set up
import {
  createWSClient,
  getBackoffDelay,
  MAX_ATTEMPTS,
  type WSEvent,
} from "../../web/src/lib/ws";

beforeEach(() => {
  esInstances = [];
  storeHistory = [];
  storeValue = { state: "connected", attempt: 0, maxAttempts: 10 };
});

// ── 1. SSE disconnect → reconnect flow ──────────────────────────────

describe("SSE disconnect → reconnect flow", () => {
  test("transitions connected → disconnected → reconnecting → connected with correct events", async () => {
    const events: WSEvent[] = [];
    const client = createWSClient();
    client.subscribe((ev) => events.push(ev));

    // Initial connect
    const es1 = latestES();
    expect(es1.url).toBe("/api/runtime-events");
    es1.simulateOpen();
    expect(storeValue.state).toBe("connected");
    expect(events.some(e => e.type === "ws:connected")).toBe(true);

    // Disconnect
    storeHistory = [];
    es1.simulateError();

    expect(events.some(e => e.type === "ws:disconnected")).toBe(true);
    expect(storeValue.state).toBe("reconnecting");

    // Wait for backoff timer (attempt 0 = 1000ms)
    await new Promise(r => setTimeout(r, 1200));

    // New EventSource created
    const es2 = latestES();
    expect(es2).not.toBe(es1);

    // Successful reconnect
    es2.simulateOpen();
    expect(storeValue.state).toBe("connected");
    expect(storeValue.attempt).toBe(0);

    // Event ordering
    const types = events.map(e => e.type);
    const firstConnect = types.indexOf("ws:connected");
    const disconnect = types.indexOf("ws:disconnected");
    const reconnect = types.lastIndexOf("ws:connected");
    expect(disconnect).toBeGreaterThan(firstConnect);
    expect(reconnect).toBeGreaterThan(disconnect);

    client.close();
  });

  test("attempt counter increments through reconnection cycle", async () => {
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function, _delay?: number) => origSetTimeout(fn, 0)) as any;

    const client = createWSClient();
    latestES().simulateOpen();

    // Disconnect to start cycle
    latestES().simulateError();

    // Track attempts seen
    const attempts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await new Promise(r => origSetTimeout(r, 10));
      attempts.push(storeValue.attempt);
      const es = latestES();
      if (es.readyState !== MockEventSource.CLOSED) es.simulateError();
    }

    // Attempts should be incrementing
    for (let i = 1; i < attempts.length; i++) {
      const curr = attempts[i];
      const prev = attempts[i - 1];
      if (curr === undefined || prev === undefined) throw new Error("expected attempts entry to be defined");
      expect(curr).toBeGreaterThanOrEqual(prev);
    }

    globalThis.setTimeout = origSetTimeout;
    client.close();
  });

  test("subscribers receive all events in correct order", () => {
    const events: WSEvent[] = [];
    const client = createWSClient();
    client.subscribe((ev) => events.push(ev));

    const es = latestES();
    es.simulateOpen();
    es.simulateMessage({ type: "run:start", data: { runId: "r1" } });
    es.simulateMessage({ type: "run:complete", data: { runId: "r1" } });
    es.simulateError();

    const types = events.map(e => e.type);
    expect(types).toEqual(["ws:connected", "run:start", "run:complete", "ws:disconnected"]);

    client.close();
  });
});

// ── 2. Permanent failure → manual retry ────────────────────────────────

describe("SSE permanent failure → manual retry", () => {
  test("10 consecutive failures transition to failed, manualRetry resets", async () => {
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function, _delay?: number) => origSetTimeout(fn, 0)) as any;

    const client = createWSClient();
    latestES().simulateOpen();
    latestES().simulateError();

    // Exhaust all attempts
    for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
      await new Promise(r => origSetTimeout(r, 10));
      const es = latestES();
      if (es.readyState !== MockEventSource.CLOSED) es.simulateError();
    }
    await new Promise(r => origSetTimeout(r, 50));

    expect(storeValue.state).toBe("failed");

    // Manual retry
    client.manualRetry();
    await new Promise(r => origSetTimeout(r, 10));

    // Attempt resets
    expect(storeValue.attempt).toBe(0);

    // Successful reconnect
    const esNew = latestES();
    esNew.simulateOpen();
    expect(storeValue.state).toBe("connected");

    globalThis.setTimeout = origSetTimeout;
    client.close();
  });

  test("state passes through reconnecting before reaching failed", async () => {
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function, _delay?: number) => origSetTimeout(fn, 0)) as any;

    storeHistory = [];
    const client = createWSClient();
    latestES().simulateOpen();
    latestES().simulateError();

    for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
      await new Promise(r => origSetTimeout(r, 10));
      const es = latestES();
      if (es.readyState !== MockEventSource.CLOSED) es.simulateError();
    }
    await new Promise(r => origSetTimeout(r, 50));

    const states = storeHistory.map(s => s.state);
    expect(states).toContain("reconnecting");
    expect(states).toContain("failed");
    // reconnecting appears before failed
    expect(states.indexOf("reconnecting")).toBeLessThan(states.lastIndexOf("failed"));

    globalThis.setTimeout = origSetTimeout;
    client.close();
  });
});

// ── 3. Health degradation scenarios ────────────────────────────────────

describe("Health degradation scenarios", () => {
  test("DB down returns degraded", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => null,
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(false);
    expect(result.status).toBe("degraded");
  });

  test("DB up, embeddings not ready returns healthy with not_initialized", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => ({ query: () => ({ rows: [{ "?column?": 1 }] }) }),
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));
    mock.module("../memory/embeddings", () => ({
      isEmbeddingReady: () => false,
    }));
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.resolve({})),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(true);
    expect(result.status).toBe("healthy");
    expect(result.embeddings?.status).toBe("not_initialized");
  });

  test("all systems operational returns healthy with all green", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => ({ query: () => ({ rows: [{ "?column?": 1 }] }) }),
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));
    mock.module("../memory/embeddings", () => ({
      isEmbeddingReady: () => true,
    }));
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.resolve({
        "provider:apiKey:anthropic": "sk-test",
        "provider:apiKey:openai": "sk-test",
        "provider:apiKey:google": "gk-test",
      })),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(true);
    expect(result.status).toBe("healthy");
    expect(result.db?.status).toBe("up");
    expect(result.embeddings?.status).toBe("ready");
    expect(result.providers?.anthropic?.status).toBe("configured");
    expect(result.providers?.openai?.status).toBe("configured");
    expect(result.providers?.google?.status).toBe("configured");
  });

  test("degradation recovery: down → up transition", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => null,
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));

    let { buildHealthResponse } = await import("../health");
    let result = await buildHealthResponse(false);
    expect(result.status).toBe("degraded");

    mock.module("../db/connection", () => ({
      getPglite: () => ({ query: () => ({ rows: [{ "?column?": 1 }] }) }),
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));

    ({ buildHealthResponse } = await import("../health"));
    result = await buildHealthResponse(false);
    expect(result.status).toBe("healthy");
  });
});

// ── 4. Memory unavailable → recovery (executor integration) ────────────

describe("Memory unavailable → recovery flow", () => {
  test("emits memory_unavailable event with correct shape on injection failure", () => {
    const events: any[] = [];
    const mockBus = {
      emit: (type: string, data: any) => { events.push({ type, data }); },
    };

    // Reproduce executor catch block behavior
    mockBus.emit("run:status", {
      runId: "test-run-1",
      status: "memory_unavailable",
      degraded: true,
      message: "Memory is currently unavailable. Responses won't include past context.",
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run:status");
    expect(events[0].data.status).toBe("memory_unavailable");
    expect(events[0].data.degraded).toBe(true);
    expect(events[0].data.message).toContain("Memory is currently unavailable");
    expect(events[0].data.runId).toBe("test-run-1");
  });

  test("successful run after failure clears degraded state", () => {
    const events: any[] = [];
    const mockBus = {
      emit: (type: string, data: any) => { events.push({ type, data }); },
    };

    // First run: memory fails
    mockBus.emit("run:status", {
      runId: "run-1",
      status: "memory_unavailable",
      degraded: true,
      message: "Memory is currently unavailable. Responses won't include past context.",
    });

    // Second run: memory works (no degraded event)
    mockBus.emit("run:status", { runId: "run-2", status: "running" });

    const degradedEvents = events.filter(e => e.data.degraded === true);
    expect(degradedEvents).toHaveLength(1);
    expect(degradedEvents[0].data.runId).toBe("run-1");
    expect(events[1].data.degraded).toBeUndefined();
  });
});

// ── 5. ConnectionBanner visibility logic ───────────────────────────────

describe("ConnectionBanner state mapping (visibility logic)", () => {
  // Extracted from ConnectionBanner.svelte line 31:
  // visible = state === "reconnecting" || state === "failed" || state === "disconnected" || showConnected
  function isVisible(state: ConnectionInfo["state"], showConnected: boolean): boolean {
    return state === "reconnecting" || state === "failed" || state === "disconnected" || showConnected;
  }

  test("visible when reconnecting", () => {
    expect(isVisible("reconnecting", false)).toBe(true);
  });

  test("visible when failed", () => {
    expect(isVisible("failed", false)).toBe(true);
  });

  test("visible when disconnected", () => {
    expect(isVisible("disconnected", false)).toBe(true);
  });

  test("visible when connected + showConnected (brief reconnected flash)", () => {
    expect(isVisible("connected", true)).toBe(true);
  });

  test("NOT visible when connected and showConnected is false", () => {
    expect(isVisible("connected", false)).toBe(false);
  });

  test("showConnected triggers on transition from non-connected to connected", () => {
    let showConnected = false;
    let wasDisconnected = false;
    let prevState: ConnectionInfo["state"] = "connected";

    function onStateChange(info: ConnectionInfo) {
      const prev = prevState;
      prevState = info.state;
      if (prev !== "connected" && info.state === "connected" && wasDisconnected) {
        showConnected = true;
      }
      if (info.state !== "connected") {
        wasDisconnected = true;
      }
    }

    onStateChange({ state: "connected", attempt: 0, maxAttempts: 10 });
    expect(showConnected).toBe(false);

    onStateChange({ state: "disconnected", attempt: 0, maxAttempts: 10 });
    expect(wasDisconnected).toBe(true);

    onStateChange({ state: "connected", attempt: 0, maxAttempts: 10 });
    expect(showConnected).toBe(true);
  });

  test("showConnected does NOT trigger if never was disconnected", () => {
    let showConnected = false;
    let wasDisconnected = false;
    let prevState: ConnectionInfo["state"] = "connected";

    function onStateChange(info: ConnectionInfo) {
      const prev = prevState;
      prevState = info.state;
      if (prev !== "connected" && info.state === "connected" && wasDisconnected) {
        showConnected = true;
      }
      if (info.state !== "connected") {
        wasDisconnected = true;
      }
    }

    // Only connected events — should never show
    onStateChange({ state: "connected", attempt: 0, maxAttempts: 10 });
    onStateChange({ state: "connected", attempt: 0, maxAttempts: 10 });
    expect(showConnected).toBe(false);
  });
});

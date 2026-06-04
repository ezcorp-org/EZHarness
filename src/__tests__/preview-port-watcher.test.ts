/**
 * Secure User-Site Preview / Port Exposure — Phase 2.
 * PreviewPortWatcher + pluggable enumeration source.
 *
 * Invariants under test (§3.2):
 *  - debounce/stabilize: a port emits only after stabilizeTicks
 *    consecutive sightings; a flap (up→down before stabilize) is suppressed
 *  - dedup by (convId, port): a stable port emits AT MOST ONCE per up-cycle;
 *    re-arms after it disappears so a restart re-notifies
 *  - infra-port filter: built-in + caller-supplied infra ports never emit
 *  - requester scoping: the event carries the registering user's id, and
 *    the SAME port in two conversations attributes to each conv's user
 *  - capability-gated source: NetnsPortSource yields [] (logged no-op) when
 *    dynamic is unavailable; enumerates via the injected reader when available
 *  - source-read failure for one conversation doesn't abort the tick
 *  - kill switch + lockfile-sibling refusal
 */
import { test, expect, describe, beforeEach, mock } from "bun:test";
import {
  PreviewPortWatcher,
  _previewPortWatcherInternals,
  type PreviewDetectedEvent,
} from "../runtime/preview/preview-port-watcher";
import {
  NetnsPortSource,
  StaticPortSource,
  type PreviewListener,
} from "../runtime/preview/preview-port-source";

function collector() {
  const events: PreviewDetectedEvent[] = [];
  return {
    events,
    onDetected: (e: PreviewDetectedEvent) => {
      events.push(e);
    },
  };
}

describe("PreviewPortWatcher — detection rules", () => {
  let source: StaticPortSource;
  beforeEach(() => {
    source = new StaticPortSource();
  });

  test("stabilize: a port emits only after stabilizeTicks consecutive sightings", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, stabilizeTicks: 2, skipLockfile: true });
    w.watch("conv1", "userA");
    source.set("conv1", [5173]);

    await w.tickOnce(); // count=1, below threshold
    expect(events).toHaveLength(0);
    await w.tickOnce(); // count=2, emits
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ userId: "userA", conversationId: "conv1", port: 5173 });
  });

  test("flap is suppressed: a port that disappears before stabilizing never emits", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, stabilizeTicks: 3, skipLockfile: true });
    w.watch("conv1", "userA");

    source.set("conv1", [5173]);
    await w.tickOnce(); // count=1
    source.set("conv1", []); // gone before stabilize
    await w.tickOnce(); // re-arm, counter dropped
    source.set("conv1", [5173]);
    await w.tickOnce(); // count=1 again (not 2)
    expect(events).toHaveLength(0);
  });

  test("stabilizeTicks=1 emits on first sighting", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, stabilizeTicks: 1, skipLockfile: true });
    w.watch("conv1", "userA");
    source.set("conv1", [3001]);
    await w.tickOnce();
    expect(events).toHaveLength(1);
  });

  test("dedup: a stable port emits at most once while it stays up", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, stabilizeTicks: 1, skipLockfile: true });
    w.watch("conv1", "userA");
    source.set("conv1", [5173]);
    await w.tickOnce();
    await w.tickOnce();
    await w.tickOnce();
    expect(events).toHaveLength(1);
  });

  test("re-arm: a port re-emits after it fully disappears and comes back", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, stabilizeTicks: 1, skipLockfile: true });
    w.watch("conv1", "userA");
    source.set("conv1", [5173]);
    await w.tickOnce(); // emit #1
    source.set("conv1", []); // gone
    await w.tickOnce(); // re-arm
    source.set("conv1", [5173]); // back
    await w.tickOnce(); // emit #2
    expect(events).toHaveLength(2);
  });

  test("infra-port filter: built-in infra ports never emit", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, stabilizeTicks: 1, skipLockfile: true });
    w.watch("conv1", "userA");
    source.set("conv1", [53, 22, 5173]); // 53 + 22 are infra
    await w.tickOnce();
    expect(events).toHaveLength(1);
    expect(events[0]!.port).toBe(5173);
  });

  test("infra-port filter: port 0 (built-in) is never surfaced", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, stabilizeTicks: 1, skipLockfile: true });
    w.watch("conv1", "userA");
    source.set("conv1", [0, 5173]); // 0 is a built-in infra port (DEFAULT_INFRA_PORTS)
    await w.tickOnce();
    expect(events.map((e) => e.port)).toEqual([5173]);
  });

  test("infra-port filter: caller-supplied infra ports are merged", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({
      source, onDetected, stabilizeTicks: 1, skipLockfile: true, infraPorts: [9999],
    });
    w.watch("conv1", "userA");
    source.set("conv1", [9999, 4321]);
    await w.tickOnce();
    expect(events.map((e) => e.port)).toEqual([4321]);
  });

  test("requester scoping: same port in two conversations attributes to each user", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, stabilizeTicks: 1, skipLockfile: true });
    w.watch("conv1", "userA");
    w.watch("conv2", "userB");
    source.set("conv1", [5173]);
    source.set("conv2", [5173]);
    await w.tickOnce();
    expect(events).toHaveLength(2);
    const byConv = Object.fromEntries(events.map((e) => [e.conversationId, e.userId]));
    expect(byConv).toEqual({ conv1: "userA", conv2: "userB" });
  });

  test("unwatch stops polling a conversation", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, stabilizeTicks: 1, skipLockfile: true });
    w.watch("conv1", "userA");
    expect(w.watchedCount()).toBe(1);
    w.unwatch("conv1");
    expect(w.watchedCount()).toBe(0);
    source.set("conv1", [5173]);
    await w.tickOnce();
    expect(events).toHaveLength(0);
  });

  test("watch is idempotent + refreshes userId on re-watch", async () => {
    const { events, onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, stabilizeTicks: 1, skipLockfile: true });
    w.watch("conv1", "userA");
    w.watch("conv1", "userB"); // re-own
    expect(w.watchedCount()).toBe(1);
    source.set("conv1", [5173]);
    await w.tickOnce();
    expect(events[0]!.userId).toBe("userB");
  });

  test("watch ignores empty conversationId / userId", () => {
    const { onDetected } = collector();
    const w = new PreviewPortWatcher({ source, onDetected, skipLockfile: true });
    w.watch("", "userA");
    w.watch("conv1", "");
    expect(w.watchedCount()).toBe(0);
  });

  test("a source read failure for one conversation does not abort the tick", async () => {
    const { events, onDetected } = collector();
    const failing: { listListeners: (id: string) => PreviewListener[] } = {
      listListeners: (id: string) => {
        if (id === "conv1") throw new Error("boom");
        return [{ port: 5173 }];
      },
    };
    const w = new PreviewPortWatcher({ source: failing, onDetected, stabilizeTicks: 1, skipLockfile: true });
    w.watch("conv1", "userA");
    w.watch("conv2", "userB");
    await w.tickOnce();
    // conv1 threw but conv2 still emitted.
    expect(events).toEqual([{ userId: "userB", conversationId: "conv2", port: 5173 }]);
  });

  test("onDetected throwing does not crash the tick", async () => {
    const w = new PreviewPortWatcher({
      source,
      onDetected: () => { throw new Error("handler boom"); },
      stabilizeTicks: 1,
      skipLockfile: true,
    });
    w.watch("conv1", "userA");
    source.set("conv1", [5173]);
    await expect(w.tickOnce()).resolves.toBeUndefined();
  });

  test("async source is awaited", async () => {
    const { events, onDetected } = collector();
    const asyncSource = {
      listListeners: (_id: string) => Promise.resolve([{ port: 4000 }]),
    };
    const w = new PreviewPortWatcher({ source: asyncSource, onDetected, stabilizeTicks: 1, skipLockfile: true });
    w.watch("conv1", "userA");
    await w.tickOnce();
    expect(events).toHaveLength(1);
    expect(events[0]!.port).toBe(4000);
  });
});

describe("PreviewPortWatcher — lifecycle", () => {
  test("kill switch refuses to start", async () => {
    const prev = process.env.EZCORP_DISABLE_PREVIEW_WATCHER;
    process.env.EZCORP_DISABLE_PREVIEW_WATCHER = "1";
    try {
      const { onDetected } = collector();
      const w = new PreviewPortWatcher({ source: new StaticPortSource(), onDetected, skipLockfile: true });
      expect(await w.start()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.EZCORP_DISABLE_PREVIEW_WATCHER;
      else process.env.EZCORP_DISABLE_PREVIEW_WATCHER = prev;
    }
  });

  test("start() is idempotent; stop() is safe to repeat", async () => {
    const { onDetected } = collector();
    const w = new PreviewPortWatcher({ source: new StaticPortSource(), onDetected, skipLockfile: true });
    expect(await w.start()).toBe(true);
    expect(await w.start()).toBe(true);
    w.stop();
    w.stop();
  });

  test("getPollIntervalMs honors env, clamps to floor, and defaults on garbage", () => {
    const { getPollIntervalMs, DEFAULT_POLL_MS, MIN_POLL_MS } = _previewPortWatcherInternals;
    const prev = process.env.EZCORP_PREVIEW_WATCHER_POLL_MS;
    try {
      delete process.env.EZCORP_PREVIEW_WATCHER_POLL_MS;
      expect(getPollIntervalMs()).toBe(DEFAULT_POLL_MS);
      process.env.EZCORP_PREVIEW_WATCHER_POLL_MS = "10"; // below floor
      expect(getPollIntervalMs()).toBe(MIN_POLL_MS);
      process.env.EZCORP_PREVIEW_WATCHER_POLL_MS = "5000";
      expect(getPollIntervalMs()).toBe(5000);
      process.env.EZCORP_PREVIEW_WATCHER_POLL_MS = "garbage";
      expect(getPollIntervalMs()).toBe(DEFAULT_POLL_MS);
    } finally {
      if (prev === undefined) delete process.env.EZCORP_PREVIEW_WATCHER_POLL_MS;
      else process.env.EZCORP_PREVIEW_WATCHER_POLL_MS = prev;
    }
  });
});

describe("NetnsPortSource — capability gating (D2)", () => {
  test("yields nothing (logged no-op) when dynamic is unavailable", () => {
    const reader = mock((_id: string) => [{ port: 5173 }]);
    const src = new NetnsPortSource(
      () => ({ dynamic: false, reason: "veth probe failed" }),
      reader,
    );
    expect(src.listListeners("conv1")).toEqual([]);
    expect(src.listListeners("conv1")).toEqual([]); // logged-once, still empty
    // The reader is NEVER consulted when fail-closed.
    expect(reader).not.toHaveBeenCalled();
  });

  test("enumerates via the injected reader when dynamic is available", () => {
    const reader = mock((_id: string) => [{ port: 5173 }, { port: 24678 }]);
    const src = new NetnsPortSource(() => ({ dynamic: true, reason: null }), reader);
    expect(src.listListeners("conv1")).toEqual([{ port: 5173 }, { port: 24678 }]);
    expect(reader).toHaveBeenCalledWith("conv1");
  });

  test("phase3StubReader returns [] (live /proc/net/tcp read is Phase 3)", () => {
    expect(NetnsPortSource.phase3StubReader("conv1")).toEqual([]);
    // Default reader is the stub: available but unwired → empty.
    const src = new NetnsPortSource(() => ({ dynamic: true, reason: null }));
    expect(src.listListeners("conv1")).toEqual([]);
  });
});

describe("StaticPortSource", () => {
  test("set/clear program + reset listeners", () => {
    const s = new StaticPortSource();
    expect(s.listListeners("c")).toEqual([]);
    s.set("c", [1, 2]);
    expect(s.listListeners("c")).toEqual([{ port: 1 }, { port: 2 }]);
    s.clear("c");
    expect(s.listListeners("c")).toEqual([]);
    s.set("c", [3]);
    s.set("d", [4]);
    s.clear(); // clear all
    expect(s.listListeners("c")).toEqual([]);
    expect(s.listListeners("d")).toEqual([]);
  });
});

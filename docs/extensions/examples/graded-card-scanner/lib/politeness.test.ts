// Unit tests for the politeness layer — per-host rate queue + robots
// gate. Deterministic: a fake clock/sleep drives the queue and a fake
// fetch drives robots. No real timers, no network.

import { describe, expect, test } from "bun:test";
import {
  BROWSER_USER_AGENT,
  createHostQueue,
  createQueuedFetch,
  createRobots,
  parseRobots,
  type FetchImpl,
} from "./politeness";

// ── createHostQueue ────────────────────────────────────────────────

/** A fake clock whose `now()` only advances when `sleep(ms)` is called. */
function fakeClock() {
  let t = 0;
  const now = () => t;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    t += ms;
  };
  return { now, sleep, sleeps, advance: (ms: number) => { t += ms; } };
}

describe("createHostQueue", () => {
  test("serializes same-host calls and enforces the min gap", async () => {
    const clock = fakeClock();
    const queue = createHostQueue(1100, clock.now, clock.sleep);
    const order: string[] = [];

    const a = queue.run("h", async () => { order.push("a"); return 1; });
    const b = queue.run("h", async () => { order.push("b"); return 2; });

    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(order).toEqual(["a", "b"]); // strictly sequential
    // First call fires at t=0 (no prior); second waits the full gap.
    expect(clock.sleeps).toEqual([1100]);
  });

  test("no wait when the gap has already elapsed between calls", async () => {
    const clock = fakeClock();
    const queue = createHostQueue(1100, clock.now, clock.sleep);
    await queue.run("h", async () => "first");
    clock.advance(2000); // more than the gap passes on its own
    await queue.run("h", async () => "second");
    expect(clock.sleeps).toEqual([]); // never had to sleep
  });

  test("different hosts run independently (no cross-host gap)", async () => {
    const clock = fakeClock();
    const queue = createHostQueue(1100, clock.now, clock.sleep);
    await queue.run("host-a", async () => 1);
    await queue.run("host-b", async () => 2); // first call to host-b → no wait
    expect(clock.sleeps).toEqual([]);
  });

  test("a failed task does not wedge the host queue", async () => {
    const clock = fakeClock();
    const queue = createHostQueue(1100, clock.now, clock.sleep);
    await expect(queue.run("h", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // The next call still runs (and waits out the gap from the failed one).
    expect(await queue.run("h", async () => "ok")).toBe("ok");
    expect(clock.sleeps).toEqual([1100]);
  });

  test("defaults (1100ms gap, real clock) construct without injected deps", async () => {
    const queue = createHostQueue();
    expect(await queue.run("h", async () => 42)).toBe(42);
  });
});

// ── createQueuedFetch ───────────────────────────────────────────────

describe("createQueuedFetch", () => {
  test("routes calls through the queue keyed on the URL host", async () => {
    const clock = fakeClock();
    const queue = createHostQueue(1100, clock.now, clock.sleep);
    const seen: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      seen.push(url);
      return new Response("ok", { status: 200 }) as Response;
    };
    const qf = createQueuedFetch(queue, fetchImpl);

    const res = await qf("https://api.psacard.com/x", { method: "GET" });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://api.psacard.com/x"]);

    // Two same-host calls serialize with the min gap; a different host is free.
    await qf("https://api.psacard.com/y");
    await qf("https://www.pricecharting.com/z");
    expect(clock.sleeps).toEqual([1100]); // only the same-host repeat waited
  });

  test("injects the browser User-Agent, and a caller-supplied UA wins", async () => {
    const queue = createHostQueue(0);
    const seen: Array<string | null> = [];
    const fetchImpl: FetchImpl = async (_url, init) => {
      seen.push(new Headers(init?.headers).get("user-agent"));
      return new Response("ok", { status: 200 }) as Response;
    };
    const qf = createQueuedFetch(queue, fetchImpl);

    await qf("https://h/a");
    await qf("https://h/b", { headers: { "user-agent": "custom-agent/1.0" } });
    expect(seen[0]).toBe(BROWSER_USER_AGENT);
    expect(seen[1]).toBe("custom-agent/1.0"); // caller override wins
  });

  test("timeoutMs arms an AbortSignal that aborts a stalled fetch", async () => {
    const queue = createHostQueue(0);
    let seenSignal: AbortSignal | undefined;
    const stalling: FetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        seenSignal = init?.signal ?? undefined;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const qf = createQueuedFetch(queue, stalling);

    await expect(qf("https://h/slow", undefined, 5)).rejects.toThrow("aborted");
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });
});

// ── parseRobots ─────────────────────────────────────────────────────

describe("parseRobots", () => {
  test("collects Disallow prefixes for the * group only", () => {
    const rules = parseRobots(
      [
        "# comment",
        "User-agent: *",
        "Disallow: /private",
        "Disallow: /tmp   # inline comment",
        "",
        "User-agent: BadBot",
        "Disallow: /",
      ].join("\n"),
    );
    expect(rules.disallow).toEqual(["/private", "/tmp"]);
  });

  test("empty Disallow value grants everything; malformed lines ignored", () => {
    const rules = parseRobots(["User-agent: *", "Disallow:", "not-a-directive", "Allow: /x"].join("\n"));
    expect(rules.disallow).toEqual([]);
  });

  test("no * group → no rules", () => {
    expect(parseRobots("User-agent: Googlebot\nDisallow: /").disallow).toEqual([]);
  });
});

// ── createRobots ────────────────────────────────────────────────────

function robotsFetch(status: number, body: string): FetchImpl {
  return async () =>
    new Response(body, { status }) as Response;
}

describe("createRobots", () => {
  test("allows a path not covered by any Disallow prefix", async () => {
    const robots = createRobots(robotsFetch(200, "User-agent: *\nDisallow: /private"));
    expect(await robots.isAllowed("www.pricecharting.com", "/search-products")).toBe(true);
  });

  test("blocks a path under a Disallow prefix", async () => {
    const robots = createRobots(robotsFetch(200, "User-agent: *\nDisallow: /search"));
    expect(await robots.isAllowed("www.pricecharting.com", "/search-products")).toBe(false);
  });

  test("caches robots.txt — fetched once per host", async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls++;
      return new Response("User-agent: *\nDisallow: /x", { status: 200 }) as Response;
    };
    const robots = createRobots(fetchImpl);
    await robots.isAllowed("h", "/a");
    await robots.isAllowed("h", "/b");
    expect(calls).toBe(1);
  });

  test("missing robots.txt (404) → allow all", async () => {
    const robots = createRobots(robotsFetch(404, "Not Found"));
    expect(await robots.isAllowed("h", "/anything")).toBe(true);
  });

  test("robots.txt fetch failure → allow all (unavailable ≠ disallow)", async () => {
    const robots = createRobots(async () => { throw new Error("network down"); });
    expect(await robots.isAllowed("h", "/anything")).toBe(true);
  });
});

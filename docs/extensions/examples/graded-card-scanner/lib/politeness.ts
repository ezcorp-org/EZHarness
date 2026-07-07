// ── politeness.ts — per-host rate queue + robots.txt gate ──────────
//
// Live lookups touch two third-party hosts (api.psacard.com,
// www.pricecharting.com). The council's non-negotiable politeness rules
// (spec §"Non-negotiable invariants" #2) are enforced here, in one place:
//
//   - createHostQueue: serializes every request to a host and holds a
//     ≥1.1s gap between them. Sequential per host — a second call to the
//     same host waits out the gap; different hosts run independently.
//   - createRobots: fetches + caches each host's robots.txt once and
//     answers isAllowed(host, path). Robots UNAVAILABLE ≠ disallowed —
//     a fetch failure or non-200 is treated as "allowed" (the rate
//     queue still applies); only an explicit `Disallow:` prefix blocks.
//
// Both are factory/pure style with injectable clock + fetch so the
// tests run deterministically with no real timers or network.

/** The single fetch signature every source module + the queue share.
 *  The sandbox-preload wraps `globalThis.fetch` with the manifest's
 *  network allowlist, so this is that wrapped builtin at runtime and a
 *  fake in tests. */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export type Now = () => number;
export type Sleep = (ms: number) => Promise<void>;

const defaultNow: Now = () => Date.now();
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface HostQueue {
  /** Run `task`, serialized behind any pending call to the same host and
   *  spaced ≥ minGapMs from the previous one. */
  run<T>(host: string, task: () => Promise<T>): Promise<T>;
}

/**
 * Per-host sequential queue with a minimum inter-request gap. The clock
 * (`now`) and `sleep` are injectable so tests drive the gap with a fake
 * clock instead of real time.
 */
export function createHostQueue(
  minGapMs = 1100,
  now: Now = defaultNow,
  sleep: Sleep = defaultSleep,
): HostQueue {
  const chains = new Map<string, Promise<unknown>>();
  const lastAt = new Map<string, number>();

  return {
    run<T>(host: string, task: () => Promise<T>): Promise<T> {
      const prev = chains.get(host) ?? Promise.resolve();
      const next = prev.then(async () => {
        const last = lastAt.get(host);
        if (last !== undefined) {
          const wait = last + minGapMs - now();
          if (wait > 0) await sleep(wait);
        }
        lastAt.set(host, now());
        return task();
      });
      // Keep the per-host chain alive regardless of task outcome so one
      // failed request never wedges the queue for that host.
      chains.set(
        host,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    },
  };
}

/** A realistic current desktop Chrome User-Agent, sent on EVERY outbound
 *  request (PSA API, PriceCharting search/product, robots.txt) so we look
 *  like a normal browser rather than an anonymous bot — spec politeness
 *  invariant #2. A caller-supplied `user-agent` in `init` overrides it. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** A queued fetch that also accepts an optional per-call `timeoutMs`. */
export type TimedFetch = (
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

/**
 * Wrap a fetch so every call is routed through `queue` (keyed on the URL
 * host) and carries the browser User-Agent — the one-liner index.ts uses
 * to make ALL outbound requests obey the per-host gap + politeness UA.
 *
 * When a call passes `timeoutMs`, the AbortController + timer are created
 * INSIDE the queue slot (so time spent waiting behind the per-host gap
 * never eats the budget), and the signal is left armed via an unref'd
 * timer across the caller's body read — so a stalled response is aborted
 * too, without the timer keeping the process alive.
 */
export function createQueuedFetch(queue: HostQueue, fetchImpl: FetchImpl): TimedFetch {
  return (url, init, timeoutMs) =>
    queue.run(new URL(url).host, () => {
      const headers = new Headers(init?.headers);
      if (!headers.has("user-agent")) headers.set("user-agent", BROWSER_USER_AGENT);
      if (timeoutMs === undefined) return fetchImpl(url, { ...init, headers });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      return fetchImpl(url, { ...init, headers, signal: controller.signal });
    });
}

// ── robots.txt ──────────────────────────────────────────────────────

interface RuleSet {
  disallow: string[];
}

export interface Robots {
  isAllowed(host: string, path: string): Promise<boolean>;
}

/**
 * Minimal robots.txt parser — collects `Disallow:` prefixes that apply
 * to the `User-agent: *` group. Comments (`#…`) and non-`*` groups are
 * ignored; an empty `Disallow:` value grants everything (per the spec).
 */
export function parseRobots(text: string): RuleSet {
  const disallow: string[] = [];
  let appliesToStar = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      appliesToStar = value === "*";
    } else if (field === "disallow" && appliesToStar && value !== "") {
      disallow.push(value);
    }
  }
  return { disallow };
}

/**
 * Fetch + cache each host's robots.txt (once) and answer path-allowance.
 * A missing/errored robots.txt is treated as "allow all" — unavailable
 * is NOT disallow (the rate queue still throttles either way).
 */
export function createRobots(fetchImpl: FetchImpl): Robots {
  const cache = new Map<string, RuleSet>();

  async function rulesFor(host: string): Promise<RuleSet> {
    const cached = cache.get(host);
    if (cached) return cached;
    let rules: RuleSet = { disallow: [] };
    try {
      const res = await fetchImpl(`https://${host}/robots.txt`);
      if (res.ok) rules = parseRobots(await res.text());
      // non-200 (404, 5xx) → no rules → allow all
    } catch {
      // network failure → unavailable ≠ disallow → allow all
    }
    cache.set(host, rules);
    return rules;
  }

  return {
    async isAllowed(host: string, path: string): Promise<boolean> {
      const rules = await rulesFor(host);
      return !rules.disallow.some((prefix) => path.startsWith(prefix));
    },
  };
}

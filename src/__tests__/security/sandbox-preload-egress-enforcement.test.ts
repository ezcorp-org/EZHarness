// The sandbox's fetch ENFORCEMENT wiring — the four arms that act on a
// `classifyFetch` decision (`sandbox-preload.ts`, `installFetchWrapper`).
//
// ## Why this file exists
//
// `classifyFetch` itself is thoroughly covered by network-wrapper.test.ts,
// but that is the DECISION. The switch that acts on it is the egress boundary
// of the extension sandbox, and three of its four arms were never driven
// through the patched `fetch`:
//
//     case "invalid":  throw new Error(decision.reason);          // 0 hits
//     case "deny":     throw new Error(decision.reason);          // 0 hits
//     case "internal": return internalFetchViaRpc(urlStr, init);  // 0 hits
//     case "external": return originalFetch(...);                 // 46 hits
//
// The `deny` arm was not untested — network-wrapper.integration.test.ts and
// sb2-network-egress.test.ts drive it six ways between them. But they spawn a
// real `bun --preload` SUBPROCESS, and bun's coverage collector only sees the
// process it runs in, so none of it reaches lcov. Those remain the right shape
// for behavioural assertions (it is how the preload really runs); this file is
// the in-process complement that makes the wiring MEASURABLE, in the same
// spirit as sandbox-preload-inprocess.test.ts.
//
// `internal` and `invalid` were genuinely untested anywhere. The internal lane
// is the SSRF carve-out (sandbox-and-isolation.md §5): internal hosts must be
// forwarded to the host via `ezcorp/network.internal` reverse-RPC so the host
// PDP decides, *because the wrapper cannot trust its own env for internal
// hosts*. "Routes via RPC" and "does not dial directly" are two halves of that
// property, so both are asserted.
//
// ## Shape
//
// Everything the wrapper reads is captured at INSTALL time — `installFetchWrapper`
// reads `EZCORP_PERMITTED_HOSTS`/`EZCORP_TOOL_NETWORK_CAPS` once and binds
// `globalThis.fetch` as `originalFetch` — so the env and the fetch stub below
// are set BEFORE the preload is imported. One env configuration exercises all
// four arms, which matters because the preload can only be installed once per
// process (and it poisons this process's fs/network globals on the way in —
// keep anything needing a real filesystem above the import, as the sibling
// in-process spec does).
//
// The internal-lane assertion drives the SDK's REAL production channel and
// captures the JSON-RPC frame via `Bun.stdout.writer` — the same seam
// packages/@ezcorp/sdk/test/_stdout-writer-spy.ts uses, and necessary because
// the channel deliberately avoids `process.stdout.write` to survive the fs
// poisoning. No mock.module: `@ezcorp/sdk/runtime` is neither snapshotted in
// helpers/mock-cleanup.ts nor exempt in mock-cleanup-coverage.test.ts, and an
// exemption to make a test convenient is the wrong direction.
import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { join } from "node:path";

const PRELOAD = join(import.meta.dir, "..", "..", "extensions", "runtime", "sandbox-preload.ts");

/** The one host the wrapper is told to permit; everything else must deny. */
const ALLOWED_HOST = "api.allowed.example";
/** Loopback — `INTERNAL_HOST_RE` classifies this as internal (the SSRF lane). */
const INTERNAL_URL = "http://127.0.0.1:9/probe";

process.env.EZCORP_NETWORK_ALLOWED = "1";
process.env.EZCORP_PERMITTED_HOSTS = ALLOWED_HOST;
delete process.env.EZCORP_TOOL_NETWORK_CAPS;

/**
 * Stands in for the real builtin. `installFetchWrapper` binds whatever
 * `globalThis.fetch` is at install time as `originalFetch`, so recording here
 * is what makes "did this URL actually egress?" observable — and lets the
 * internal-lane test assert a NEGATIVE that would otherwise be invisible.
 */
const egressed: string[] = [];
const EXTERNAL_STUB_STATUS = 299;
(globalThis as { fetch: unknown }).fetch = async (input: unknown): Promise<Response> => {
  egressed.push(String(input));
  return new Response("external-stub", { status: EXTERNAL_STUB_STATUS });
};

/** JSON-RPC frames the SDK channel writes, plus a one-shot arrival signal. */
const frames: string[] = [];
let announceFrame: ((frame: string) => void) | null = null;
let stdoutSpy: { mockRestore: () => void } | null = null;

beforeAll(async () => {
  const sink = {
    write(chunk: string | ArrayBufferView): number {
      const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
      frames.push(s);
      announceFrame?.(s);
      return 0;
    },
    flush(): number {
      return 0;
    },
    end(): number {
      return 0;
    },
  } as unknown as ReturnType<typeof Bun.stdout.writer>;
  stdoutSpy = spyOn(Bun.stdout, "writer").mockImplementation(() => sink);

  await import(PRELOAD);
});

afterAll(() => {
  stdoutSpy?.mockRestore();
});

describe("sandbox fetch enforcement — the wiring that acts on classifyFetch", () => {
  test("deny: a host outside the allowlist throws, and never egresses", async () => {
    const before = egressed.length;
    // The REASON is asserted, not just the throw: the wrapper's contract is to
    // surface classifyFetch's reason, and a bare "request failed" would leave
    // an extension author guessing at a security decision.
    await expect(fetch("https://evil.example/steal")).rejects.toThrow(
      /not in the granted network allowlist/i,
    );
    // The throw is only half of "denied" — the point is that nothing left.
    expect(egressed.length, "a denied host must not reach the real fetch").toBe(before);
  });

  test("invalid: an unparseable URL throws before any lane is chosen", async () => {
    const before = egressed.length;
    await expect(fetch("not-a-url")).rejects.toThrow(/invalid URL passed to fetch/i);
    expect(egressed.length, "an invalid URL must not reach the real fetch").toBe(before);
  });

  test("external: an allowlisted host reaches the original fetch", async () => {
    const url = `https://${ALLOWED_HOST}/ok`;
    const res = await fetch(url);
    // Status pins that the response came from the captured original, not from
    // some other lane that happened not to throw.
    expect(res.status).toBe(EXTERNAL_STUB_STATUS);
    expect(egressed).toContain(url);
  });

  test("internal: loopback is forwarded over ezcorp/network.internal, not dialled", async () => {
    const before = egressed.length;
    const arrived = new Promise<string>((resolve) => {
      announceFrame = resolve;
    });

    // Deliberately not awaited: no host is answering this channel, so the
    // request stays pending for the life of the process. The assertion is that
    // the FRAME was emitted — resolved by the sink, so it is event-driven and
    // carries no wall-clock dependency. The rejection handler is required:
    // src/__tests__/preload.ts calls __resetChannelForTests() at teardown,
    // which rejects everything still pending, and an unhandled rejection there
    // surfaces as an "Unhandled error between tests".
    const pending = fetch(INTERNAL_URL);
    pending.catch(() => {
      /* rejected at teardown by __resetChannelForTests — expected */
    });

    const msg = JSON.parse(await arrived) as {
      method?: string;
      params?: { url?: string };
    };
    // The RPC path is asserted positively — the method AND the forwarded URL —
    // rather than inferring it from the absence of a throw.
    expect(msg.method).toBe("ezcorp/network.internal");
    expect(msg.params?.url).toBe(INTERNAL_URL);

    // The SSRF carve-out itself: the sandbox must NOT dial an internal host
    // directly, because its own env cannot be trusted to gate one. This is the
    // assertion that would fail if the internal arm were ever "simplified"
    // into the external lane.
    expect(egressed.length, "an internal host must never reach the real fetch").toBe(before);
  }, 30_000);
});

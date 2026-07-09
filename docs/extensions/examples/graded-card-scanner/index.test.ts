// Unit tests for the graded-card-scanner extension subprocess.
//
// The tool handler is tested directly (no channel); the lookup seam is
// swapped so no live network is ever opened. Mirrors the price-chart
// example's test structure.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  __resetChannelForTests,
  __resetPagesForTests,
  getChannel,
  type HostChannel,
} from "@ezcorp/sdk/runtime";
import {
  _resetLookupForTests,
  _setLookupForTests,
  start,
  tools,
  type CardRecord,
} from "./index";
import { mockCard } from "./app/lib/mock-card.js";

const lookup = tools.lookup_card;
if (!lookup) throw new Error("lookup_card tool not registered");
const setToken = tools.set_psa_token;
if (!setToken) throw new Error("set_psa_token tool not registered");

function expectText(out: unknown): string {
  const o = out as { content?: Array<{ type: string; text: string }> };
  const first = o.content?.[0];
  if (!first || first.type !== "text") throw new Error("tool-result has no text content");
  return first.text;
}

function expectIsError(out: unknown): boolean {
  return (out as { isError?: boolean }).isError === true;
}

beforeEach(() => _resetLookupForTests());
afterEach(() => {
  _resetLookupForTests();
  // start() (boot test) swaps in the real pipeline + registers the Hub
  // page on the channel — reset both so nothing leaks across files.
  __resetPagesForTests();
  __resetChannelForTests();
});

describe("lookup_card input validation", () => {
  test("rejects a missing cert", async () => {
    const out = await lookup({}, {} as never);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("'cert' must be");
  });

  test("rejects a non-string cert", async () => {
    const out = await lookup({ cert: 49392223 }, {} as never);
    expect(expectIsError(out)).toBe(true);
  });

  test("rejects garbage text", async () => {
    const out = await lookup({ cert: "not-a-cert" }, {} as never);
    expect(expectIsError(out)).toBe(true);
  });

  test("rejects too-short digit strings", async () => {
    const out = await lookup({ cert: "1234" }, {} as never);
    expect(expectIsError(out)).toBe(true);
  });
});

describe("lookup_card happy path", () => {
  test("returns the full record for a bare cert", async () => {
    const out = await lookup({ cert: "49392223" }, {} as never);
    expect(expectIsError(out)).toBe(false);
    const record = JSON.parse(expectText(out)) as CardRecord;
    expect(record.cert).toBe("49392223");
    expect(record.identity.subject).toBe("Charizard");
    expect(record.grades).toHaveLength(10);
    // Missing values must be null (never 0) — the mock has none, but the
    // shape contract is asserted: every grade row carries pop and price keys.
    for (const g of record.grades) {
      expect(g).toContainKeys(["grade", "pop", "price"]);
    }
  });

  test("parses the cert out of a psacard.com URL", async () => {
    const out = await lookup(
      { cert: "https://www.psacard.com/cert/12345678?utm=qr" },
      {} as never,
    );
    expect(expectIsError(out)).toBe(false);
    const record = JSON.parse(expectText(out)) as CardRecord;
    expect(record.cert).toBe("12345678");
  });

  test("threads fresh=true through to the lookup impl", async () => {
    const calls: Array<{ cert: string; fresh: boolean }> = [];
    _setLookupForTests(async (cert, fresh) => {
      calls.push({ cert, fresh });
      return mockCard(cert, "2026-07-06T00:00:00.000Z");
    });
    await lookup({ cert: "49392223", fresh: true }, {} as never);
    await lookup({ cert: "49392223" }, {} as never);
    expect(calls).toEqual([
      { cert: "49392223", fresh: true },
      { cert: "49392223", fresh: false },
    ]);
  });

  test("non-boolean fresh is treated as false", async () => {
    const calls: boolean[] = [];
    _setLookupForTests(async (cert, fresh) => {
      calls.push(fresh);
      return mockCard(cert);
    });
    await lookup({ cert: "49392223", fresh: "yes" }, {} as never);
    expect(calls).toEqual([false]);
  });
});

describe("lookup_card failure path", () => {
  test("a throwing lookup surfaces as a toolError, not a crash", async () => {
    _setLookupForTests(async () => {
      throw new Error("psa api quota exceeded");
    });
    const out = await lookup({ cert: "49392223" }, {} as never);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("lookup failed for cert 49392223");
    expect(expectText(out)).toContain("psa api quota exceeded");
  });

  test("non-Error throwables are stringified", async () => {
    _setLookupForTests(async () => {
      throw "boom";
    });
    const out = await lookup({ cert: "49392223" }, {} as never);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("boom");
  });
});

describe("set_psa_token", () => {
  function saveResultText(out: unknown): string {
    return expectText(out);
  }

  test("rejects a non-string token", async () => {
    const out = await setToken({ token: 12345 }, {} as never);
    expect(expectIsError(out)).toBe(true);
    expect(saveResultText(out)).toContain("'token' must be a string");
  });

  test("rejects a too-short token", async () => {
    const out = await setToken({ token: "short" }, {} as never);
    expect(expectIsError(out)).toBe(true);
    expect(saveResultText(out)).toContain("10-200 characters");
  });

  test("rejects a too-long token", async () => {
    const out = await setToken({ token: "x".repeat(201) }, {} as never);
    expect(expectIsError(out)).toBe(true);
  });

  test("saves a valid token to encrypted user-scoped storage and never echoes it", async () => {
    const secret = "psa-live-token-abc123";
    const ch: HostChannel = getChannel();
    let params: Record<string, unknown> | null = null;
    const spy = spyOn(ch, "request");
    spy.mockImplementation((async (_method: string, p: unknown) => {
      params = p as Record<string, unknown>;
      return { ok: true, sizeBytes: 1 };
    }) as HostChannel["request"]);
    try {
      const out = await setToken({ token: `  ${secret}  ` }, {} as never);
      expect(expectIsError(out)).toBe(false);
      // The result NEVER contains the token (invariant #4).
      expect(saveResultText(out)).toBe("PSA token saved.");
      expect(saveResultText(out)).not.toContain(secret);
      // Written trimmed, to the encrypted user scope under the token key.
      expect(params).toMatchObject({
        action: "set",
        scope: "user",
        key: "psa-token",
        value: secret,
        encrypted: true,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("manifest", () => {
  test("declares both tools, the Hub page, and grants (no credential env grant)", async () => {
    const manifest = (await import("./ezcorp.config.ts")).default;
    expect(manifest.name).toBe("graded-card-scanner");
    expect(manifest.tools?.map((t) => t.name)).toEqual(["lookup_card", "set_psa_token"]);
    expect(manifest.permissions?.storage).toBe(true);
    // No credential-shaped `env` grant is declared — the PSA token is
    // supplied at runtime via the `set_psa_token` tool (encrypted secret),
    // which keeps the example installable past the env-key-leak install gate.
    expect("env" in manifest.permissions).toBe(false);
    expect(manifest.permissions?.network).toEqual([
      "api.psacard.com",
      "www.pricecharting.com",
    ]);
    expect(manifest.pages?.map((p) => p.id)).toEqual(["dashboard"]);
    expect(manifest.pages?.[0]?.title).toBe("Card Scanner");
  });
});

describe("boot", () => {
  test("start() wires the dispatcher + boots the channel without throwing", () => {
    // Idempotent channel guard makes this safe in-process; covers the
    // path `bun run index.ts` exercises in prod.
    expect(() => start()).not.toThrow();
  });
});

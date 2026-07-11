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
  _resetIdentifyForTests,
  _resetLookupForTests,
  _setIdentifyForTests,
  _setLookupForTests,
  start,
  tools,
  type CardRecord,
} from "./index";
import { mockCard } from "./app/lib/mock-card.js";
import { emptyIdentity, type IdentifySlabRecord } from "./lib/identify";

const lookup = tools.lookup_card;
if (!lookup) throw new Error("lookup_card tool not registered");
const setToken = tools.set_psa_token;
if (!setToken) throw new Error("set_psa_token tool not registered");
const identify = tools.identify_slab;
if (!identify) throw new Error("identify_slab tool not registered");

function expectText(out: unknown): string {
  const o = out as { content?: Array<{ type: string; text: string }> };
  const first = o.content?.[0];
  if (!first || first.type !== "text") throw new Error("tool-result has no text content");
  return first.text;
}

function expectIsError(out: unknown): boolean {
  return (out as { isError?: boolean }).isError === true;
}

beforeEach(() => {
  _resetLookupForTests();
  _resetIdentifyForTests();
});
afterEach(() => {
  _resetLookupForTests();
  _resetIdentifyForTests();
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

describe("identify_slab", () => {
  function makeRecord(overrides: Partial<IdentifySlabRecord> = {}): IdentifySlabRecord {
    return {
      cert: "49392223",
      grader: "PSA",
      identity: { ...emptyIdentity(), subject: "Charizard", grade: "PSA 9" },
      grades: { PSA: { "9": 2587.5, "10": 30100 } },
      deltas: [
        {
          company: "PSA",
          steps: [{ from: "9", to: "10", fromPrice: 2587.5, toPrice: 30100, pct: 1063.3 }],
        },
      ],
      sources: {
        decode: { source: "zxing", fetchedAt: "2026-07-09T00:00:00.000Z" },
        identity: { source: "psa-api", fetchedAt: "2026-07-09T00:00:00.000Z" },
        price: { source: "pricecharting", fetchedAt: "2026-07-09T00:00:00.000Z" },
      },
      ...overrides,
    };
  }

  const PNG_URI = `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`;

  test("rejects a missing attachment", async () => {
    const out = await identify({}, {} as never);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("'attachment' must be");
  });

  test("rejects a non-string attachment", async () => {
    const out = await identify({ attachment: 42 }, {} as never);
    expect(expectIsError(out)).toBe(true);
  });

  test("rejects an unresolved handle (not a data: URI)", async () => {
    const out = await identify(
      { attachment: "ez-attachment://not-resolved" },
      {} as never,
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("did not resolve to a data: URI");
  });

  test("rejects an empty data-URI payload", async () => {
    const out = await identify({ attachment: "data:image/png;base64," }, {} as never);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("empty payload");
  });

  test("happy path: decodes the data URI and returns the record JSON", async () => {
    const calls: Array<{ bytes: Uint8Array; mimeType: string }> = [];
    _setIdentifyForTests(async (bytes, mimeType) => {
      calls.push({ bytes, mimeType });
      return makeRecord();
    });
    const out = await identify(
      { attachment: PNG_URI, filename: "slab.png", mimeType: "image/png" },
      {} as never,
    );
    expect(expectIsError(out)).toBe(false);
    const record = JSON.parse(expectText(out)) as IdentifySlabRecord;
    expect(record.cert).toBe("49392223");
    expect(record.grader).toBe("PSA");
    expect(record.deltas[0]?.steps[0]?.pct).toBe(1063.3);
    // The data URI's OWN mime is authoritative; bytes are the decoded base64.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.mimeType).toBe("image/png");
    expect(Array.from(calls[0]!.bytes)).toEqual([1, 2, 3]);
  });

  test("falls back to the caller-supplied mimeType when the data URI omits one", async () => {
    const mimes: string[] = [];
    _setIdentifyForTests(async (_bytes, mimeType) => {
      mimes.push(mimeType);
      return makeRecord();
    });
    const bare = `data:;base64,${Buffer.from([9]).toString("base64")}`;
    await identify({ attachment: bare, mimeType: "image/jpeg" }, {} as never);
    await identify({ attachment: bare }, {} as never);
    expect(mimes).toEqual(["image/jpeg", ""]);
  });

  test("a throwing pipeline surfaces as a toolError naming the file", async () => {
    _setIdentifyForTests(async () => {
      throw new Error("unsupported image MIME");
    });
    const out = await identify(
      { attachment: PNG_URI, filename: "slab.png" },
      {} as never,
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("identify_slab failed for slab.png");
    expect(expectText(out)).toContain("unsupported image MIME");
  });

  test("non-Error throwables are stringified; missing filename labels 'attachment'", async () => {
    _setIdentifyForTests(async () => {
      throw "boom";
    });
    const out = await identify({ attachment: PNG_URI }, {} as never);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("identify_slab failed for attachment: boom");
  });
});

describe("manifest", () => {
  test("declares the three tools, the Hub page, and grants (no credential env grant)", async () => {
    const manifest = (await import("./ezcorp.config.ts")).default;
    expect(manifest.name).toBe("graded-card-scanner");
    expect(manifest.tools?.map((t) => t.name)).toEqual([
      "lookup_card",
      "identify_slab",
      "set_psa_token",
    ]);
    expect(manifest.permissions?.storage).toBe(true);
    // No credential-shaped `env` grant is declared — the PSA token is
    // supplied at runtime via the `set_psa_token` tool (encrypted secret),
    // which keeps the example installable past the env-key-leak install gate.
    expect("env" in manifest.permissions).toBe(false);
    // Least privilege: cgccomics.com QR payloads are classified (CGC) but
    // the lookup always fetches www.cgccards.com — only that host is granted.
    expect(manifest.permissions?.network).toEqual([
      "api.psacard.com",
      "www.pricecharting.com",
      "www.cgccards.com",
    ]);
    expect(manifest.pages?.map((p) => p.id)).toEqual(["dashboard"]);
    expect(manifest.pages?.[0]?.title).toBe("Card Scanner");
  });

  test("declares the psa_api_token secret setting targeting resolveToken's storage key", async () => {
    const manifest = (await import("./ezcorp.config.ts")).default;
    const { TOKEN_STORAGE_KEY } = await import("./lib/token.ts");
    const field = manifest.settings?.psa_api_token;
    expect(field?.type).toBe("secret");
    expect(field?.label).toBe("PSA API token");
    // MUST equal lib/token.ts's TOKEN_STORAGE_KEY — that is what makes the
    // settings-page write readable by resolveToken with zero code changes.
    expect(field && "storageKey" in field ? field.storageKey : undefined).toBe(
      TOKEN_STORAGE_KEY,
    );
    // The description points users at the free-token source.
    expect(
      field?.description?.includes("api.psacard.com"),
    ).toBe(true);
  });

  test("declares the identify_slab preprocessor (deterministic preprocess) with the chart cardType", async () => {
    const manifest = (await import("./ezcorp.config.ts")).default;
    expect(manifest.preprocessors).toEqual([
      {
        tool: "identify_slab",
        accepts: ["image/png", "image/jpeg"],
        description: "Identify a graded-card slab photo (PSA/CGC/BGS/SGC).",
      },
    ]);
    const identify = manifest.tools?.find((t) => t.name === "identify_slab");
    expect(identify?.cardType).toBe("grade-delta-chart");
    // The preprocessor's declared tool MUST exist in tools[] — the host
    // manifest validator enforces this at admit time; pin it here too so
    // a rename can't silently break the deterministic trigger.
    expect(manifest.tools?.some((t) => t.name === manifest.preprocessors?.[0]?.tool)).toBe(true);
  });
});

describe("boot", () => {
  test("start() wires the dispatcher + boots the channel without throwing", () => {
    // Idempotent channel guard makes this safe in-process; covers the
    // path `bun run index.ts` exercises in prod.
    expect(() => start()).not.toThrow();
  });
});

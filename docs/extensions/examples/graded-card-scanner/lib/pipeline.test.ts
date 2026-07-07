// Unit tests for buildLookup — cache hit / fresh bypass, source merge,
// null-honesty, recent-list cap/order, and the best-effort onLookup hook.
// All deps injected; no channel, no network.

import { describe, expect, test } from "bun:test";
import {
  GRADE_LABELS,
  RECENT_CAP,
  RECENT_KEY,
  buildLookup,
  certKey,
  type PipelineDeps,
  type PipelineStorage,
  type RecentEntry,
} from "./pipeline";
import type { CardRecord } from "../app/lib/format.js";
import type { PsaResult } from "./sources/psa-api";
import type { PriceMap } from "./sources/pricecharting";

// ── In-memory Storage fake ──────────────────────────────────────────

function memoryStorage(): PipelineStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T = unknown>(key: string) {
      return data.has(key)
        ? { value: data.get(key) as T, exists: true }
        : { value: null, exists: false };
    },
    async set<T = unknown>(key: string, value: T) {
      data.set(key, value);
      return { ok: true };
    },
  };
}

const okPsa: PsaResult = {
  ok: true,
  identity: { subject: "Charizard", year: "1999", set: "Pokemon Base Set", cardNo: "4", variety: "Holo", grade: "PSA 9" },
  popAtGrade: 2101,
  popHigher: 121,
};

const somePrices: PriceMap = { Ungraded: 381.55, "PSA 7": 714.5, "PSA 8": 1201.99, "PSA 9": 2587.5, "PSA 10": 30100 };

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    getToken: async () => "a-token",
    fetchPsa: async () => okPsa,
    fetchPrices: async () => ({ ...somePrices }),
    storage: memoryStorage(),
    now: () => "2026-07-06T14:00:00.000Z",
    ...overrides,
  };
}

describe("buildLookup — merge", () => {
  test("builds 11 grade rows with pop only on the scanned grade + mapped prices", async () => {
    const lookup = buildLookup(deps());
    const record = await lookup("49392223", false);

    expect(record.cert).toBe("49392223");
    expect(record.identity.subject).toBe("Charizard");
    expect(record.grades.map((g) => g.grade)).toEqual([...GRADE_LABELS]);
    expect(record.grades).toHaveLength(11);

    // pop only on PSA 9 (the scanned grade); null everywhere else.
    const psa9 = record.grades.find((g) => g.grade === "PSA 9");
    expect(psa9?.pop).toBe(2101);
    expect(record.grades.filter((g) => g.pop !== null)).toHaveLength(1);

    // Prices from the mapping; PSA 1–6 have no column → null.
    expect(record.grades.find((g) => g.grade === "Ungraded")?.price).toBe(381.55);
    expect(record.grades.find((g) => g.grade === "PSA 10")?.price).toBe(30100);
    expect(record.grades.find((g) => g.grade === "PSA 3")?.price).toBeNull();

    expect(record.sources.identity?.source).toBe("psa-api");
    expect(record.sources.pop?.source).toBe("psa-api");
    expect(record.sources.price?.source).toBe("pricecharting");
    expect(record.sources.identity?.fetchedAt).toBe("2026-07-06T14:00:00.000Z");
  });

  test("population from a 'MINT 9' grade lands on the PSA 9 row only", async () => {
    const mintPsa: PsaResult = {
      ...okPsa,
      identity: { ...okPsa.identity, grade: "MINT 9" },
      popAtGrade: 2101,
    };
    const record = await buildLookup(deps({ fetchPsa: async () => mintPsa }))("1", true);
    expect(record.grades.find((g) => g.grade === "PSA 9")?.pop).toBe(2101);
    expect(record.grades.filter((g) => g.pop !== null)).toHaveLength(1);
  });

  test("no token → empty identity, null pop, psa-api:no-token stamp", async () => {
    const record = await buildLookup(
      deps({
        getToken: async () => null,
        fetchPsa: async () => ({ ok: false, kind: "no-token" }),
        fetchPrices: async () => ({ Ungraded: null, "PSA 7": null, "PSA 8": null, "PSA 9": null, "PSA 10": null }),
      }),
    )("1", false);

    expect(record.identity.subject).toBe("");
    expect(record.grades.every((g) => g.pop === null)).toBe(true);
    expect(record.sources.identity?.source).toBe("psa-api:no-token");
    expect(record.sources.price?.source).toBe("pricecharting");
  });

  test("psa error kind → psa-api:error(<kind>) stamp", async () => {
    const record = await buildLookup(deps({ fetchPsa: async () => ({ ok: false, kind: "quota" }) }))("1", false);
    expect(record.sources.identity?.source).toBe("psa-api:error(quota)");
  });

  test("psa ok + pricecharting throw → prices null, pricecharting:error stamp", async () => {
    const record = await buildLookup(
      deps({ fetchPrices: async () => { throw new Error("network down"); } }),
    )("1", false);
    expect(record.grades.every((g) => g.price === null)).toBe(true);
    expect(record.sources.price?.source).toBe("pricecharting:error");
    // Identity still came through — a price failure doesn't sink the record.
    expect(record.sources.identity?.source).toBe("psa-api");
  });
});

describe("buildLookup — cache", () => {
  test("cache hit returns the stored record without re-fetching", async () => {
    const storage = memoryStorage();
    const cached: CardRecord = { cert: "1", identity: okPsa.identity, grades: [], sources: {} };
    storage.data.set(certKey("1"), cached);

    let psaCalls = 0;
    const record = await buildLookup(
      deps({ storage, fetchPsa: async () => { psaCalls++; return okPsa; } }),
    )("1", false);

    expect(record).toBe(cached);
    expect(psaCalls).toBe(0);
  });

  test("fresh=true bypasses the cache and overwrites it", async () => {
    const storage = memoryStorage();
    const stale: CardRecord = { cert: "1", identity: okPsa.identity, grades: [], sources: {} };
    storage.data.set(certKey("1"), stale);

    let psaCalls = 0;
    const record = await buildLookup(
      deps({ storage, fetchPsa: async () => { psaCalls++; return okPsa; } }),
    )("1", true);

    expect(psaCalls).toBe(1);
    expect(record).not.toBe(stale);
    expect(record.grades).toHaveLength(11);
    expect(storage.data.get(certKey("1"))).toBe(record); // overwritten
  });
});

describe("buildLookup — recent list", () => {
  test("prepends newest-first, dedupes by cert, caps at RECENT_CAP", async () => {
    const storage = memoryStorage();
    const d = deps({ storage });
    const lookup = buildLookup(d);

    await lookup("100", true);
    await lookup("200", true);
    await lookup("100", true); // repeat → moves to front, not duplicated

    const recent = storage.data.get(RECENT_KEY) as RecentEntry[];
    expect(recent.map((r) => r.cert)).toEqual(["100", "200"]);
    expect(recent[0]).toEqual({
      cert: "100",
      title: "1999 Pokemon Base Set Charizard #4",
      grade: "PSA 9",
      value: 2587.5, // price at its own grade (PSA 9)
      at: "2026-07-06T14:00:00.000Z",
    });
  });

  test("caps the list at RECENT_CAP entries", async () => {
    const storage = memoryStorage();
    const lookup = buildLookup(deps({ storage }));
    for (let i = 0; i < RECENT_CAP + 5; i++) await lookup(String(1000 + i), true);
    const recent = storage.data.get(RECENT_KEY) as RecentEntry[];
    expect(recent).toHaveLength(RECENT_CAP);
    expect(recent[0]?.cert).toBe(String(1000 + RECENT_CAP + 4)); // newest
  });

  test("a corrupt (non-array) recent value is treated as empty", async () => {
    const storage = memoryStorage();
    storage.data.set(RECENT_KEY, "not-an-array");
    const record = await buildLookup(deps({ storage }))("1", true);
    const recent = storage.data.get(RECENT_KEY) as RecentEntry[];
    expect(recent).toHaveLength(1);
    expect(record.cert).toBe("1");
  });
});

describe("buildLookup — onLookup hook", () => {
  test("fires after an uncached lookup, not on a cache hit", async () => {
    const storage = memoryStorage();
    let fires = 0;
    const lookup = buildLookup(deps({ storage, onLookup: async () => { fires++; } }));

    await lookup("1", false); // uncached
    expect(fires).toBe(1);

    await lookup("1", false); // now cached → no fire
    expect(fires).toBe(1);

    await lookup("1", true); // fresh → fires
    expect(fires).toBe(2);
  });

  test("a throwing onLookup never fails the lookup (best-effort refresh)", async () => {
    const record = await buildLookup(
      deps({ onLookup: async () => { throw new Error("push failed"); } }),
    )("1", false);
    expect(record.cert).toBe("1"); // succeeded despite the push error
  });
});

describe("buildLookup — failed identity is not persisted", () => {
  test("no-token lookups always re-fetch, never cache, and leave recent empty; a later live lookup wins", async () => {
    const storage = memoryStorage();
    const tokenBox = { value: null as string | null };
    let psaCalls = 0;
    const lookup = buildLookup(
      deps({
        storage,
        getToken: async () => tokenBox.value,
        fetchPsa: async (_cert, token) => {
          psaCalls++;
          return token ? okPsa : { ok: false, kind: "no-token" };
        },
      }),
    );

    // Two failed (no-token) lookups both hit the source — no stale cache.
    await lookup("1", false);
    await lookup("1", false);
    expect(psaCalls).toBe(2);
    expect(storage.data.has(certKey("1"))).toBe(false);
    expect(storage.data.get(RECENT_KEY) ?? []).toEqual([]); // recent untouched

    // Token appears; a plain (fresh=false) lookup now returns live data and
    // IS cached + recorded — no stale null record blocked it.
    tokenBox.value = "a-token";
    const record = await lookup("1", false);
    expect(psaCalls).toBe(3);
    expect(record.identity.subject).toBe("Charizard");
    expect(storage.data.has(certKey("1"))).toBe(true);
    expect((storage.data.get(RECENT_KEY) as RecentEntry[]).map((r) => r.cert)).toEqual(["1"]);
  });

  test("onLookup does not fire for a failed identity lookup", async () => {
    let fires = 0;
    await buildLookup(
      deps({ fetchPsa: async () => ({ ok: false, kind: "http" }), onLookup: async () => { fires++; } }),
    )("1", false);
    expect(fires).toBe(0);
  });
});

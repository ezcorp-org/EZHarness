// Unit tests for the sanity script — the fixtures path runs the REAL
// parsers offline (deterministic), and injected deps exercise every
// pass/fail branch. No live network.

import { describe, expect, test } from "bun:test";
import {
  defaultMakeDeps,
  fixturesDeps,
  formatReport,
  liveDeps,
  main,
  memoryStorage,
  parseArgs,
  runSanity,
} from "./sanity-check";
import type { PipelineDeps, PipelineStorage } from "../lib/pipeline";
import type { PsaResult } from "../lib/sources/psa-api";
import type { PriceMap } from "../lib/sources/pricecharting";

const okPsa: PsaResult = {
  ok: true,
  identity: { subject: "Charizard", year: "1999", set: "Pokemon Base Set", cardNo: "4", variety: "Holo", grade: "PSA 9" },
  popAtGrade: 2101,
  popHigher: 121,
};
const goodPrices: PriceMap = { Ungraded: 381.55, "PSA 7": 714.5, "PSA 8": 1201.99, "PSA 9": 2587.5, "PSA 10": 30100 };

function customDeps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    getToken: async () => "token",
    fetchPsa: async () => okPsa,
    fetchPrices: async () => ({ ...goodPrices }),
    storage: memoryStorage(),
    now: () => "2026-07-06T00:00:00.000Z",
    ...over,
  };
}

describe("runSanity", () => {
  test("fixtures: real parsers pass every check", async () => {
    const report = await runSanity(["49392223"], fixturesDeps());
    expect(report.ok).toBe(true);
    expect(report.results[0]).toEqual({
      cert: "49392223",
      identityOk: true,
      popOk: true,
      pricesOk: true,
      cacheOk: true,
      pass: true,
    });
  });

  test("no-token → identity check fails", async () => {
    const report = await runSanity(["1"], customDeps({ fetchPsa: async () => ({ ok: false, kind: "no-token" }) }));
    expect(report.ok).toBe(false);
    expect(report.results[0]!.identityOk).toBe(false);
  });

  test("non-integer population → pop check fails", async () => {
    const badPop: PsaResult = { ...okPsa, popAtGrade: 2101.5 };
    const report = await runSanity(["1"], customDeps({ fetchPsa: async () => badPop }));
    expect(report.results[0]!.popOk).toBe(false);
    expect(report.results[0]!.identityOk).toBe(true); // isolated failure
  });

  test("negative price → price check fails", async () => {
    const report = await runSanity(["1"], customDeps({ fetchPrices: async () => ({ ...goodPrices, Ungraded: -5 }) }));
    expect(report.results[0]!.pricesOk).toBe(false);
  });

  test("cache miss (storage that never persists) → cache check fails", async () => {
    const noPersist: PipelineStorage = {
      async get() { return { value: null, exists: false }; },
      async set() { return { ok: true }; },
    };
    const report = await runSanity(["1"], customDeps({ storage: noPersist }));
    expect(report.results[0]!.cacheOk).toBe(false);
  });
});

describe("formatReport", () => {
  test("renders a PASS row and the all-clear footer", () => {
    const out = formatReport({
      results: [{ cert: "1", identityOk: true, popOk: true, pricesOk: true, cacheOk: true, pass: true }],
      ok: true,
    });
    expect(out).toContain("PASS");
    expect(out).toContain("All checks passed.");
  });

  test("renders FAIL markers and the drift footer", () => {
    const out = formatReport({
      results: [{ cert: "1", identityOk: false, popOk: true, pricesOk: true, cacheOk: true, pass: false }],
      ok: false,
    });
    expect(out).toContain("FAIL");
    expect(out).toContain("drifted");
  });
});

describe("parseArgs", () => {
  test("separates the --fixtures flag from cert args", () => {
    expect(parseArgs(["49392223", "--fixtures", "12345678"])).toEqual({
      fixtures: true,
      certs: ["49392223", "12345678"],
    });
  });
  test("no flag → live mode, all args are certs", () => {
    expect(parseArgs(["49392223"])).toEqual({ fixtures: false, certs: ["49392223"] });
  });
  test("empty argv → no certs", () => {
    expect(parseArgs([])).toEqual({ fixtures: false, certs: [] });
  });
});

describe("main", () => {
  test("--fixtures with a cert → exit 0 and logs a passing report", async () => {
    const logs: string[] = [];
    const code = await main(["--fixtures", "49392223"], (m) => logs.push(m));
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("All checks passed.");
  });

  test("a failing lookup (injected deps) → exit 1", async () => {
    const code = await main(
      ["49392223"],
      () => {},
      () => customDeps({ fetchPsa: async () => ({ ok: false, kind: "no-token" }) }),
    );
    expect(code).toBe(1);
  });

  test("no certs → exit 2 with usage", async () => {
    const logs: string[] = [];
    const code = await main([], (m) => logs.push(m));
    expect(code).toBe(2);
    expect(logs.join("\n")).toContain("usage:");
  });
});

describe("deps builders", () => {
  test("defaultMakeDeps(true) builds the offline fixtures deps", async () => {
    const report = await runSanity(["49392223"], defaultMakeDeps(true));
    expect(report.ok).toBe(true);
  });

  test("defaultMakeDeps(false) + liveDeps construct without touching the network", async () => {
    for (const deps of [defaultMakeDeps(false), liveDeps({})]) {
      expect(typeof deps.getToken).toBe("function");
      expect(typeof deps.fetchPsa).toBe("function");
      expect(typeof deps.fetchPrices).toBe("function");
      expect(typeof deps.now()).toBe("string");
    }
  });

  test("liveDeps resolves the token from env (no Storage on the CLI)", async () => {
    expect(await liveDeps({ PSA_API_TOKEN: "env-token-value" }).getToken()).toBe("env-token-value");
    expect(await liveDeps({}).getToken()).toBeNull();
  });
});

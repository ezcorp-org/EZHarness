// Unit tests for the shared pure-logic modules under app/lib/ — the
// same files the browser SPA imports. No DOM, no network, no IndexedDB.

import { describe, expect, test } from "bun:test";
import { isValidCert, parseCertInput } from "./app/lib/cert.js";
import { createScanGate } from "./app/lib/dedupe.js";
import {
  buildGradeRows,
  cardTitle,
  formatMoney,
  formatPct,
  gradeSortKey,
  isSameGrade,
  searchMatch,
  valueAtOwnGrade,
} from "./app/lib/format.js";
import { mockCard } from "./app/lib/mock-card.js";
import { buildChartSvg } from "./app/lib/chart.js";
import { buildDecodeVariants } from "./app/lib/decode-plan.js";

// ── cert.js ──────────────────────────────────────────────────────────

describe("parseCertInput", () => {
  test("accepts bare digits (5–10)", () => {
    expect(parseCertInput("49392223")).toBe("49392223");
    expect(parseCertInput("  12345 ")).toBe("12345");
    expect(parseCertInput("1234567890")).toBe("1234567890");
  });

  test("rejects out-of-range digit runs and garbage", () => {
    expect(parseCertInput("1234")).toBeNull();
    expect(parseCertInput("12345678901")).toBeNull();
    expect(parseCertInput("hello")).toBeNull();
    expect(parseCertInput("")).toBeNull();
    expect(parseCertInput("   ")).toBeNull();
    expect(parseCertInput(42 as never)).toBeNull();
    expect(parseCertInput(null as never)).toBeNull();
  });

  test("extracts the cert from psacard.com URLs (QR payloads)", () => {
    expect(parseCertInput("https://www.psacard.com/cert/49392223")).toBe("49392223");
    expect(parseCertInput("http://psacard.com/cert/12345678/psa")).toBe("12345678");
    expect(parseCertInput("HTTPS://WWW.PSACARD.COM/CERT/87654321?src=qr")).toBe("87654321");
    expect(parseCertInput("https://www.psacard.com/cert/87654321#top")).toBe("87654321");
  });

  test("rejects non-PSA URLs and malformed cert paths", () => {
    expect(parseCertInput("https://example.com/cert/49392223")).toBeNull();
    expect(parseCertInput("https://www.psacard.com/pop/12345678")).toBeNull();
    expect(parseCertInput("https://www.psacard.com/cert/12345678901")).toBeNull();
  });

  test("isValidCert mirrors the bare-digit rule", () => {
    expect(isValidCert("49392223")).toBe(true);
    expect(isValidCert("1234")).toBe(false);
    expect(isValidCert(49392223 as never)).toBe(false);
  });
});

// ── dedupe.js ────────────────────────────────────────────────────────

describe("createScanGate", () => {
  test("first sighting is new; repeats inside the window are cooldown", () => {
    let t = 0;
    const gate = createScanGate({ cooldownMs: 8000, now: () => t });
    expect(gate.tryAcquire("111111")).toBe("new");
    gate.settle("111111");
    t = 4000;
    expect(gate.tryAcquire("111111")).toBe("cooldown");
  });

  test("in-flight guard blocks until settle()", () => {
    let t = 0;
    const gate = createScanGate({ cooldownMs: 8000, now: () => t });
    expect(gate.tryAcquire("111111")).toBe("new");
    t = 20_000; // even past the cooldown, an unfinished lookup blocks
    expect(gate.tryAcquire("111111")).toBe("in-flight");
    gate.settle("111111");
    t = 40_000;
    expect(gate.tryAcquire("111111")).toBe("new");
  });

  test("the cooldown window refreshes on every sighting (card held in frame)", () => {
    let t = 0;
    const gate = createScanGate({ cooldownMs: 8000, now: () => t });
    gate.tryAcquire("111111");
    gate.settle("111111");
    // Sighted every 5s — never 8s out of frame, so never re-captured.
    for (t = 5000; t <= 30_000; t += 5000) {
      expect(gate.tryAcquire("111111")).toBe("cooldown");
    }
    t += 8001; // now it left the frame long enough
    expect(gate.tryAcquire("111111")).toBe("new");
  });

  test("distinct certs are independent; reset() forgets everything", () => {
    let t = 0;
    const gate = createScanGate({ now: () => t });
    expect(gate.tryAcquire("111111")).toBe("new");
    expect(gate.tryAcquire("222222")).toBe("new");
    gate.reset();
    expect(gate.tryAcquire("111111")).toBe("new");
  });

  test("defaults (8s window, Date.now) apply when no opts given", () => {
    const gate = createScanGate();
    expect(gate.tryAcquire("333333")).toBe("new");
    expect(gate.tryAcquire("333333")).toBe("in-flight");
  });
});

// ── format.js ────────────────────────────────────────────────────────

describe("formatMoney", () => {
  test("null/undefined/NaN → N/A, never 0", () => {
    expect(formatMoney(null)).toBe("N/A");
    expect(formatMoney(undefined)).toBe("N/A");
    expect(formatMoney(Number.NaN)).toBe("N/A");
  });

  test("formats USD with cents and thousands separators", () => {
    expect(formatMoney(30100)).toBe("$30,100.00");
    expect(formatMoney(714.5)).toBe("$714.50");
    expect(formatMoney(0)).toBe("$0.00"); // a REAL zero renders as zero
  });
});

describe("gradeSortKey / isSameGrade", () => {
  test("orders Ungraded < PSA 1 < PSA 8.5 < PSA 10", () => {
    expect(gradeSortKey("Ungraded")).toBe(0);
    expect(gradeSortKey("PSA 1")).toBe(1);
    expect(gradeSortKey("PSA 8.5")).toBe(8.5);
    expect(gradeSortKey("GEM MT 10")).toBe(10);
    expect(gradeSortKey("???")).toBe(-1);
  });

  test("matches grade labels across formats", () => {
    expect(isSameGrade("PSA 9", "MINT 9")).toBe(true);
    expect(isSameGrade("PSA 9", "9")).toBe(true);
    expect(isSameGrade("PSA 9", "PSA 10")).toBe(false);
    expect(isSameGrade("???", "???")).toBe(false); // unknowns never match
    expect(isSameGrade("Ungraded", "Ungraded")).toBe(true);
  });
});

describe("buildGradeRows", () => {
  test("sorts low→high and computes % vs the next lower PRICED grade", () => {
    const rows = buildGradeRows([
      { grade: "PSA 10", pop: 10, price: 300 },
      { grade: "PSA 8", pop: 100, price: 100 },
      { grade: "PSA 9", pop: 50, price: null }, // unpriced gap in the middle
    ]);
    expect(rows.map((r) => r.grade)).toEqual(["PSA 8", "PSA 9", "PSA 10"]);
    expect(rows[0]?.pctVsLower).toBeNull(); // nothing lower
    expect(rows[1]?.pctVsLower).toBeNull(); // no price → no pct
    expect(rows[2]?.pctVsLower).toBe(200); // 300 vs 100, skipping the gap
  });

  test("does not mutate its input", () => {
    const input = [
      { grade: "PSA 10", pop: 1, price: 2 },
      { grade: "PSA 1", pop: 1, price: 1 },
    ];
    buildGradeRows(input);
    expect(input[0]?.grade).toBe("PSA 10");
  });
});

describe("formatPct", () => {
  test("signs, one decimal, em-dash for null", () => {
    expect(formatPct(200)).toBe("+200.0%");
    expect(formatPct(-12.44)).toBe("−12.4%");
    expect(formatPct(null)).toBe("—");
  });
});

describe("valueAtOwnGrade / cardTitle / searchMatch", () => {
  const record = mockCard("49392223", "2026-07-06T00:00:00.000Z");

  test("valueAtOwnGrade reads the scanned grade's price", () => {
    expect(valueAtOwnGrade(record)).toBe(2587.5); // PSA 9
    const gradeless = { ...record, identity: { ...record.identity, grade: "PSA 4.5" } };
    expect(valueAtOwnGrade(gradeless)).toBeNull();
  });

  test("cardTitle composes year/set/subject/#", () => {
    expect(cardTitle(record.identity)).toBe("1999 Pokemon Base Set Charizard #4");
    expect(cardTitle({ ...record.identity, cardNo: "" })).toBe("1999 Pokemon Base Set Charizard");
  });

  test("searchMatch hits cert, identity fields, and empty query", () => {
    const saved = { cert: "49392223", record };
    expect(searchMatch(saved, "")).toBe(true);
    expect(searchMatch(saved, "4939")).toBe(true);
    expect(searchMatch(saved, "charizard")).toBe(true);
    expect(searchMatch(saved, "1999")).toBe(true);
    expect(searchMatch(saved, "zzz")).toBe(false);
    expect(searchMatch({ cert: "111111", record: null }, "charizard")).toBe(false);
  });
});

// ── mock-card.js ─────────────────────────────────────────────────────

describe("mockCard", () => {
  test("substitutes the cert and stamps every source as mock", () => {
    const r = mockCard("87654321", "2026-07-06T00:00:00.000Z");
    expect(r.cert).toBe("87654321");
    expect(r.grades).toHaveLength(10);
    expect(r.sources.identity?.source).toBe("mock");
    expect(r.sources.pop?.fetchedAt).toBe("2026-07-06T00:00:00.000Z");
  });

  test("defaults fetchedAt to now when not injected", () => {
    const r = mockCard("87654321");
    expect(Date.parse(r.sources.price?.fetchedAt ?? "")).toBeGreaterThan(0);
  });
});

// ── chart.js ─────────────────────────────────────────────────────────

describe("buildChartSvg", () => {
  const grades = mockCard("49392223").grades;

  test("renders a bar per populated grade and highlights the scanned one", () => {
    const svg = buildChartSvg(grades, "PSA 9");
    expect(svg.match(/<rect /g)).toHaveLength(10);
    expect(svg.match(/gcs-bar-scanned/g)).toHaveLength(1);
    expect(svg).toContain('data-grade="PSA 9"');
  });

  test("null prices leave a GAP — no dot, no zero, pen lifts", () => {
    const svg = buildChartSvg(
      [
        { grade: "PSA 1", pop: 5, price: 100 },
        { grade: "PSA 2", pop: 5, price: null },
        { grade: "PSA 3", pop: 5, price: 300 },
      ],
      "PSA 3",
    );
    expect(svg.match(/<circle [^>]*gcs-price-dot/g)).toHaveLength(2);
    expect(svg).not.toContain("$0.00");
    // Pen lift: the gap leaves two ISOLATED points — nothing to connect,
    // so no line path is emitted at all (a bridge across the gap would
    // fabricate a trend through missing data).
    expect(svg).not.toContain("<path");
  });

  test("a contiguous priced run draws one connected line", () => {
    const svg = buildChartSvg(
      [
        { grade: "PSA 1", pop: 5, price: 100 },
        { grade: "PSA 2", pop: 5, price: 200 },
      ],
      "PSA 1",
    );
    const d = /<path d="([^"]+)"/.exec(svg)?.[1] ?? "";
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d.match(/L/g)).toHaveLength(1);
  });

  test("null pop renders no bar; unknown scanned grade highlights nothing", () => {
    const svg = buildChartSvg(
      [
        { grade: "PSA 1", pop: null, price: null },
        { grade: "PSA 2", pop: 7, price: null },
      ],
      "PSA 10",
    );
    expect(svg.match(/<rect /g)).toHaveLength(1);
    expect(svg).not.toContain("gcs-bar-scanned");
    expect(svg).not.toContain("gcs-price-dot");
  });

  test("escapes grade labels in markup", () => {
    const svg = buildChartSvg([{ grade: 'PSA "9" <b>', pop: 3, price: 5 }], "none");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt;");
  });

  test("empty input renders the no-data placeholder", () => {
    expect(buildChartSvg([], "PSA 9")).toContain("No grade data");
  });
});

// ── decode-plan.js ───────────────────────────────────────────────────

describe("buildDecodeVariants", () => {
  const tilesOf = (w: number, h: number) => buildDecodeVariants(w, h).filter((v) => v.quietZone);

  test("non-positive dimensions yield no variants", () => {
    expect(buildDecodeVariants(0, 100)).toEqual([]);
    expect(buildDecodeVariants(100, 0)).toEqual([]);
    expect(buildDecodeVariants(-5, 50)).toEqual([]);
    expect(buildDecodeVariants(Number.NaN, 50)).toEqual([]);
  });

  test("a typical phone frame → 2 full-frame passes, 3 bands, then a tile grid", () => {
    const v = buildDecodeVariants(1200, 1600);
    const frame = v.slice(0, 2);
    const bands = v.slice(2, 5);
    const tiles = v.filter((x) => x.quietZone);

    // 1–2: whole frame downscaled so the long side ≤ 1200 (1200/1600 = 0.75),
    // once without TRY_HARDER then once with it; never quiet-zone padded.
    for (const full of frame) {
      expect(full).toMatchObject({ sx: 0, sy: 0, sw: 1200, sh: 1600, quietZone: false });
      expect(full.scale).toBeCloseTo(0.75, 5);
    }
    expect(frame[0]?.tryHarder).toBe(false);
    expect(frame[1]?.tryHarder).toBe(true);

    // 3–5: three full-width bands at the third boundaries, always TRY_HARDER,
    // never quiet-zone padded, budget-capped between ×1 and the ×3 ceiling.
    expect(bands.map((b) => b.sy)).toEqual([0, 453, 986]);
    for (const band of bands) {
      expect(band).toMatchObject({ sx: 0, sw: 1200, tryHarder: true, quietZone: false });
      expect(band.scale).toBeGreaterThan(1);
      expect(band.scale).toBeLessThan(3);
    }

    // 6+: the tile grid is the rest of the ladder, appended AFTER the bands.
    expect(v.slice(5)).toEqual(tiles);
    expect(tiles.length).toBeGreaterThan(0);
    expect(v).toHaveLength(5 + tiles.length);
  });

  test("only tiles are quiet-zone padded, and they carry a ×2–×6 upscale", () => {
    const v = buildDecodeVariants(1200, 1600);
    expect(v.slice(0, 5).every((x) => x.quietZone === false)).toBe(true);
    for (const t of v.filter((x) => x.quietZone)) {
      expect(t.tryHarder).toBe(true);
      expect(t.scale).toBeGreaterThanOrEqual(2);
      expect(t.scale).toBeLessThanOrEqual(6);
    }
  });

  test("the tile grid overlaps 50% and stays within the ≤80 cap", () => {
    const tiles = tilesOf(1200, 1600);
    expect(tiles.length).toBeLessThanOrEqual(80);
    // tile width = round(0.34 · 1200) = 408 → 50%-overlap step = 204.
    const xs = [...new Set(tiles.map((t) => t.sx))].sort((a, b) => a - b);
    expect(xs[0]).toBe(0);
    expect(xs[1]).toBe(204);
  });

  test("edge tiles sit flush to the right and bottom of the frame", () => {
    const tiles = tilesOf(1200, 1600);
    expect(tiles.some((t) => t.sx + t.sw === 1200)).toBe(true);
    expect(tiles.some((t) => t.sy + t.sh === 1600)).toBe(true);
  });

  test("every variant's region stays inside the source frame", () => {
    for (const [w, h] of [
      [1200, 1600],
      [800, 600],
      [40, 60],
      [3000, 4000],
      [10, 1],
    ] as const) {
      for (const v of buildDecodeVariants(w, h)) {
        expect(v.sx).toBeGreaterThanOrEqual(0);
        expect(v.sy).toBeGreaterThanOrEqual(0);
        expect(v.sw).toBeGreaterThanOrEqual(1);
        expect(v.sh).toBeGreaterThanOrEqual(1);
        expect(v.sx + v.sw).toBeLessThanOrEqual(w);
        expect(v.sy + v.sh).toBeLessThanOrEqual(h);
      }
    }
  });

  test("a small frame is never downscaled (full-frame scale stays 1)", () => {
    const v = buildDecodeVariants(800, 600); // long side < 1200
    expect(v[0]?.scale).toBe(1);
    expect(v[1]?.scale).toBe(1);
  });

  test("a tiny frame upscales bands to the ×3 ceiling", () => {
    const bands = buildDecodeVariants(40, 60).slice(2, 5);
    expect(bands).toHaveLength(3);
    for (const band of bands) expect(band.scale).toBe(3);
  });

  test("a frame too large for a padded tile skips the tile pass entirely", () => {
    const v = buildDecodeVariants(3000, 4000);
    expect(v[0]?.scale).toBeCloseTo(0.3, 5); // 1200/4000 — full frame downscaled
    for (const band of v.slice(2, 5)) expect(band.scale).toBe(1); // budget floors scale at ×1
    expect(v.filter((x) => x.quietZone)).toHaveLength(0); // a padded tile would blow the budget
    expect(v).toHaveLength(5);
  });

  test("a degenerate 1px-tall frame still produces valid (sh ≥ 1) bands and tiles", () => {
    const v = buildDecodeVariants(10, 1);
    for (const band of v.slice(2, 5)) expect(band.sh).toBeGreaterThanOrEqual(1);
    for (const t of v.filter((x) => x.quietZone)) expect(t.sh).toBeGreaterThanOrEqual(1);
  });
});

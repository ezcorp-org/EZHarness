/**
 * query-aux (db-audit): pins the clamp semantics of the sql.raw interval
 * chokepoint (`src/db/queries/sql-interval.ts`).
 *
 * `safeIntervalCount` / `nowMinusInterval` are the SOLE guard that keeps
 * `sql.raw` interval construction injection-safe (INTERVAL literals can't be
 * parameterized). Before this suite the 100% line-coverage of the module was
 * satisfied by any transitive happy-path call — the guarded behaviors
 * (NaN/Infinity → fallback, negative → 0, over-cap → 3650, float → floor) and
 * the emitted SQL fragment (a BARE integer, never a param, never adversarial
 * text) were never asserted. A refactor that dropped `Math.floor` or the bound
 * would keep coverage green and ship a non-integer to `sql.raw`. This asserts
 * every boundary + the rendered SQL so that regression fails here.
 */
import { test, expect, describe } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { safeIntervalCount, nowMinusInterval } from "../sql-interval";

describe("safeIntervalCount — clamp boundaries", () => {
  const CASES: Array<[string, number, number | undefined, number]> = [
    ["passes an in-range integer", 30, undefined, 30],
    ["zero stays zero", 0, undefined, 0],
    ["negative clamps to 0", -5, undefined, 0],
    ["large negative clamps to 0", -100000, undefined, 0],
    ["over the 3650 cap clamps to 3650", 9999, undefined, 3650],
    ["exactly 3650 is kept", 3650, undefined, 3650],
    ["3651 clamps to 3650", 3651, undefined, 3650],
    ["float floors down", 3.9, undefined, 3],
    ["negative float floors then clamps to 0", -0.5, undefined, 0],
    ["NaN falls back to default", NaN, undefined, 30],
    ["+Infinity falls back to default", Infinity, undefined, 30],
    ["-Infinity falls back to default", -Infinity, undefined, 30],
    ["NaN honours a custom fallback", NaN, 7, 7],
  ];
  for (const [label, input, fallback, expected] of CASES) {
    test(label, () => {
      const out = fallback === undefined
        ? safeIntervalCount(input)
        : safeIntervalCount(input, fallback);
      expect(out).toBe(expected);
      // The result is ALWAYS a plain integer — this is the property the
      // sql.raw interpolation relies on.
      expect(Number.isInteger(out)).toBe(true);
    });
  }
});

describe("nowMinusInterval — rendered SQL only ever carries a bare clamped integer", () => {
  const dialect = new PgDialect();
  const render = (count: number, unit: "days" | "minutes") =>
    dialect.sqlToQuery(nowMinusInterval(count, unit));

  test("in-range days render literally", () => {
    const q = render(30, "days");
    expect(q.sql).toBe("NOW() - INTERVAL '30 days'");
    // Nothing is bound — the count + unit are sql.raw, so a param leak
    // would mean the value escaped the clamp.
    expect(q.params).toEqual([]);
  });

  test("minutes unit is emitted verbatim (fixed union, not user input)", () => {
    expect(render(15, "minutes").sql).toBe("NOW() - INTERVAL '15 minutes'");
  });

  test("over-cap count renders the clamped 3650, not the raw value", () => {
    expect(render(9999, "days").sql).toBe("NOW() - INTERVAL '3650 days'");
  });

  test("negative count renders 0", () => {
    expect(render(-5, "days").sql).toBe("NOW() - INTERVAL '0 days'");
  });

  test("non-finite count renders the fallback default", () => {
    expect(render(Infinity, "minutes").sql).toBe("NOW() - INTERVAL '30 minutes'");
  });

  test("adversarial float never reaches SQL as a non-integer", () => {
    const q = render(90.9999, "days");
    expect(q.sql).toBe("NOW() - INTERVAL '90 days'");
    // Belt-and-braces: the rendered fragment must contain no decimal point.
    expect(q.sql).not.toContain(".");
  });
});

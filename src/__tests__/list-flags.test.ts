/**
 * `withListFlags` — the derived, read-only fields the Extensions page needs
 * on every extension row.
 *
 * The point of the mapper is that ONE answer reaches the page from both
 * surfaces that ship rows to it (the SSR loader and `GET /api/extensions`).
 * So the assertions here are about the derivation: it comes from the
 * bundled catalog rather than the browser's guess, it is name-keyed, and it
 * never disturbs the row it decorates.
 */

import { test, expect, describe } from "bun:test";
import { withListFlags, withListFlagsAll } from "../extensions/list-flags";
import { getCriticalBundledExtensions } from "../extensions/bundled";
import { userConsequenceFor } from "../extensions/critical-consequence";

const CRITICAL = getCriticalBundledExtensions().map((c) => c.name);

describe("withListFlags", () => {
  test("marks every catalog-critical extension", () => {
    // Driven off the catalog, so adding a fourth `critical: true` entry
    // cannot leave the UI silently unaware of it.
    expect(CRITICAL.length).toBeGreaterThan(0);
    for (const name of CRITICAL) {
      expect(withListFlags({ name }).isCritical).toBe(true);
    }
  });

  test("does not mark an ordinary extension", () => {
    for (const name of ["scratchpad", "web-search", "some-user-extension"]) {
      expect(withListFlags({ name }).isCritical).toBe(false);
    }
  });

  test("carries the consequence sentence for a critical row only", () => {
    const critical = withListFlags({ name: CRITICAL[0]! });
    expect(critical.criticalConsequence).toBe(userConsequenceFor(CRITICAL[0]!));

    // Absent, not empty — the page reads its PRESENCE as "this row needs the
    // extra confirm step", so an empty string would be a false yes.
    const ordinary = withListFlags({ name: "scratchpad" });
    expect("criticalConsequence" in ordinary).toBe(false);
  });

  test("preserves every existing field on the row", () => {
    const row = { id: "ext-1", name: "scratchpad", enabled: true, nested: { a: 1 } };

    const flagged = withListFlags(row);

    expect(flagged).toMatchObject(row);
    // A copy, not a mutation: the callers map over DB rows.
    expect(row).not.toHaveProperty("isCritical");
  });
});

describe("withListFlagsAll", () => {
  test("flags each row independently and keeps the order", () => {
    const rows = [{ name: "scratchpad" }, { name: CRITICAL[0]! }, { name: "web-search" }];

    const flagged = withListFlagsAll(rows);

    expect(flagged.map((r) => r.name)).toEqual(rows.map((r) => r.name));
    expect(flagged.map((r) => r.isCritical)).toEqual([false, true, false]);
  });

  test("an empty list stays empty", () => {
    expect(withListFlagsAll([])).toEqual([]);
  });
});

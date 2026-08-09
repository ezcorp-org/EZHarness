/**
 * Unit tests for `inferGoalKind` — the stable hook that classifies a
 * persisted `ez-action-result` row as one of the five Phase-2 goal
 * kinds (status / achieved / cleared / paused / rejected) without
 * modifying Phase 1's `EzActionResult` contract.
 *
 * Each fixture below mirrors a title string that `src/runtime/goal-
 * host.ts` actually produces (verified against the file's
 * `build*Card` functions at lines 697–814). If a host-side title is
 * renamed, the matching prefix entry in `goal-row-logic.ts` MUST
 * change in lockstep — both are host-owned, the coupling is
 * intentional.
 *
 * Lives under `web/src/lib/components/` with the `.unit.test.ts`
 * suffix so the web vitest config picks it up. No DOM, no Svelte —
 * pure logic. Mirrors `relative-time.unit.test.ts`'s pattern.
 */

import { describe, test, expect } from "vitest";
import { inferGoalKind, type EzActionResultLike } from "./goal-row-logic";

function payload(
  title: string,
  body = "—",
  variant: "success" | "info" | "warning" | "error" = "info",
): EzActionResultLike {
  return { card: { title, body, variant } };
}

describe("inferGoalKind — host-defined title prefix mapping", () => {
  test("status: 'Goal active' (buildStatusCard, active branch)", () => {
    expect(inferGoalKind(payload("Goal active"))).toBe("status");
  });

  test("status: 'No active goal' (buildStatusCard none branch / buildNoGoalCard)", () => {
    expect(inferGoalKind(payload("No active goal"))).toBe("status");
  });

  test("achieved: 'Goal achieved' (buildAchievedCard)", () => {
    expect(inferGoalKind(payload("Goal achieved"))).toBe("achieved");
  });

  test("cleared: 'Goal cleared' (buildClearedCard)", () => {
    expect(inferGoalKind(payload("Goal cleared"))).toBe("cleared");
  });

  test("cleared: 'Goal stopped — reached turn cap' (buildTurnCapCard — FR-12.6, terminal-clean)", () => {
    expect(inferGoalKind(payload("Goal stopped — reached turn cap"))).toBe("cleared");
  });

  test("paused: 'Goal paused' (buildStatusCard paused branch / buildPausedCard)", () => {
    expect(inferGoalKind(payload("Goal paused"))).toBe("paused");
  });

  test("rejected: 'Goal condition too long' (buildRejectTooLongCard — FR-3)", () => {
    expect(inferGoalKind(payload("Goal condition too long"))).toBe("rejected");
  });

  test("rejected: '/goal disabled' (buildDisabledCard / inline disabled card in messages route)", () => {
    expect(inferGoalKind(payload("/goal disabled"))).toBe("rejected");
  });
});

describe("inferGoalKind — prefix matching (host may suffix the title)", () => {
  test("'Goal achieved — final reason' still matches achieved", () => {
    // `startsWith` semantics so future suffixing doesn't break.
    expect(inferGoalKind(payload("Goal achieved — final reason"))).toBe("achieved");
  });

  test("'Goal paused (eval failed 3x)' still matches paused", () => {
    expect(inferGoalKind(payload("Goal paused (eval failed 3x)"))).toBe("paused");
  });

  test("'Goal stopped — reached turn cap (50)' still matches cleared (turn-cap branch)", () => {
    expect(inferGoalKind(payload("Goal stopped — reached turn cap (50)"))).toBe("cleared");
  });

  test("more-specific prefixes win: 'Goal stopped — reached turn cap' does NOT match a future 'Goal' wildcard", () => {
    // Defense: even if someone adds a less-specific prefix later,
    // the more-specific "Goal stopped" entry comes first in the
    // table so the turn-cap card lands in `cleared`, not whatever
    // generic fallback follows.
    expect(inferGoalKind(payload("Goal stopped — reached turn cap"))).toBe("cleared");
  });
});

describe("inferGoalKind — defensive null returns for non-goal rows", () => {
  test("returns null for a non-goal ez-action-result (e.g. lessons-keeper)", () => {
    // Real lessons-keeper title — must not get a goal-kind attribute.
    expect(inferGoalKind(payload("Lesson captured"))).toBeNull();
  });

  test("returns null for an arbitrary EZ-action title", () => {
    expect(inferGoalKind(payload("Distiller declined"))).toBeNull();
    expect(inferGoalKind(payload("Action failed"))).toBeNull();
  });

  test("returns null for null / undefined / empty content", () => {
    expect(inferGoalKind(null)).toBeNull();
    expect(inferGoalKind(undefined)).toBeNull();
    expect(inferGoalKind({})).toBeNull();
  });

  test("returns null for malformed card (missing title)", () => {
    expect(inferGoalKind({ card: { body: "x", variant: "info" } })).toBeNull();
  });

  test("returns null when title is not a string (defensive against deserialization noise)", () => {
    expect(
      inferGoalKind({ card: { title: 123 as unknown as string, body: "x", variant: "info" } }),
    ).toBeNull();
    expect(
      inferGoalKind({ card: { title: null as unknown as string, body: "x", variant: "info" } }),
    ).toBeNull();
  });

  test("returns null for an empty title string", () => {
    expect(inferGoalKind(payload(""))).toBeNull();
  });
});

describe("inferGoalKind — substring-match guard", () => {
  test("a title that merely *contains* a goal phrase mid-string does NOT match (prefix-only)", () => {
    // Defense against a hypothetical EZ-action whose title is
    // "ImportError: Goal achieved import failed" — that is not a
    // goal row, so prefix-only matching is correct.
    expect(inferGoalKind(payload("ImportError: Goal achieved import failed"))).toBeNull();
  });

  test("a leading-whitespace title does NOT match (we do not trim — host titles never have leading whitespace)", () => {
    // If a future host change ever adds leading whitespace, the
    // missed match degrades to "no goal markup" — strictly safer
    // than over-matching foreign rows. The fix would be to remove
    // the whitespace at the host source, not loosen the matcher.
    expect(inferGoalKind(payload(" Goal achieved"))).toBeNull();
  });
});

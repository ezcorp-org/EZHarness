/**
 * The consent rules for an `approval` step — ported invariants 5 and 6.
 *
 * Pure, so these are exhaustive rather than representative: the guard is
 * the single thing standing between three answer surfaces and a consent
 * bypass, and it has no I/O to make that expensive.
 */
import { test, expect, describe } from "bun:test";
import {
  crossCheckItemIds,
  enforceNamedApproval,
  requireItemConsent,
  type ParkedApproval,
} from "../runtime/workflow-approval-guard";

/** A step with two items awaiting a decision. */
const withItems: ParkedApproval = {
  choices: ["approve", "reject"],
  requireItemConsent: true,
  itemIds: ["f1", "f2"],
};

/** A step that requires consent but has nothing outstanding. */
const clean: ParkedApproval = {
  choices: ["approve", "reject"],
  requireItemConsent: true,
  itemIds: [],
};

/** A step that never asked for item-level consent. */
const noConsent: ParkedApproval = {
  choices: ["ship", "hold"],
  requireItemConsent: false,
  itemIds: [],
};

describe("declared choices", () => {
  test("an undeclared choice is rejected, never coerced", () => {
    // It would otherwise flow into `$steps.<gate>.output.choice` and be
    // read downstream as though the author had allowed it.
    const res = requireItemConsent(withItems, { choice: "maybe", itemIds: ["f1"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not one of this step's declared choices");
    expect(res.error).toContain("approve, reject");
  });

  test("the choice check applies even to a step with nothing to consent to", () => {
    const res = requireItemConsent(noConsent, { choice: "launch" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("declared choices");
  });

  test("every declared choice is accepted on a clean step", () => {
    for (const choice of clean.choices) {
      expect(requireItemConsent(clean, { choice }).ok).toBe(true);
    }
  });
});

describe("invariant 5 — no blanket approval", () => {
  test("an ids-free answer over a step WITH items is refused", () => {
    const res = requireItemConsent(withItems, { choice: "approve" });
    expect(res.ok).toBe(false);
    // The message has to tell the human what to do next.
    expect(res.error).toContain("must name the itemIds");
    expect(res.error).toContain("2 item(s)");
  });

  test("naming the ids passes — that IS the proof of surface", () => {
    const res = requireItemConsent(withItems, { choice: "approve", itemIds: ["f1", "f2"] });
    expect(res.ok).toBe(true);
    expect(res.consentAllUsed).toBeUndefined();
  });

  test("naming a SUBSET passes — a partial decision is still a decision", () => {
    expect(requireItemConsent(withItems, { choice: "approve", itemIds: ["f1"] }).ok).toBe(true);
  });

  test("a CLEAN step answers ids-free — nothing was withheld", () => {
    const res = requireItemConsent(clean, { choice: "approve" });
    expect(res.ok).toBe(true);
    // Not a blanket clear, so nothing to flag.
    expect(res.consentAllUsed).toBeUndefined();
  });

  test("consentAll passes AND is flagged, so a bulk clear is never silent", () => {
    const res = requireItemConsent(withItems, { choice: "approve", consentAll: true });
    expect(res.ok).toBe(true);
    expect(res.consentAllUsed).toBe(true);
  });

  test("consentAll:false is not standing consent", () => {
    // Only an explicit `true` bypasses — a falsy value must not be read
    // as permission.
    const res = requireItemConsent(withItems, { choice: "approve", consentAll: false });
    expect(res.ok).toBe(false);
  });

  test("an empty itemIds array does not count as naming anything", () => {
    const res = requireItemConsent(withItems, { choice: "approve", itemIds: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("must name the itemIds");
  });

  test("a step that never required consent is unaffected", () => {
    expect(requireItemConsent(noConsent, { choice: "ship" }).ok).toBe(true);
    expect(enforceNamedApproval(noConsent, { choice: "hold" }).ok).toBe(true);
  });

  test("the requirement is choice-AGNOSTIC — rejecting also names its items", () => {
    // The port keys on approve/fix; a workflow's choices are
    // author-defined strings, so keying on the choice would bypass
    // consent the first time someone wrote `choices: [ship, hold]`.
    expect(requireItemConsent(withItems, { choice: "reject" }).ok).toBe(false);
    expect(requireItemConsent(withItems, { choice: "reject", itemIds: ["f2"] }).ok).toBe(true);
  });
});

describe("invariant 6 — named ids must exist", () => {
  test("an invented id is refused even though the array is non-empty", () => {
    // Without this, any non-empty array satisfies "named some ids", so a
    // junk id clears a gate nobody reviewed.
    const res = requireItemConsent(withItems, { choice: "approve", itemIds: ["nope"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown itemId(s): nope");
  });

  test("a real id mixed with an invented one is still refused", () => {
    const res = requireItemConsent(withItems, { choice: "approve", itemIds: ["f1", "ghost"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ghost");
    expect(res.error).not.toContain("f1");
  });

  test("an ids-free answer is governed by invariant 5, not this one", () => {
    expect(crossCheckItemIds(withItems, { choice: "approve" }).ok).toBe(true);
    expect(crossCheckItemIds(withItems, { choice: "approve", itemIds: [] }).ok).toBe(true);
  });
});

describe("ordering", () => {
  test("an undeclared choice is reported before any consent complaint", () => {
    // The first failure is the one the human has to fix; leading with
    // "name your ids" on a choice that will be rejected anyway sends
    // them down the wrong path.
    const res = requireItemConsent(withItems, { choice: "bogus" });
    expect(res.error).toContain("declared choices");
    expect(res.error).not.toContain("must name the itemIds");
  });

  test("a blanket-approval refusal is reported before the cross-check", () => {
    const res = requireItemConsent(withItems, { choice: "approve", itemIds: [] });
    expect(res.error).toContain("must name the itemIds");
    expect(res.error).not.toContain("Unknown itemId");
  });

  test("consentAll does NOT waive the cross-check on ids that were named", () => {
    // Standing consent excuses not naming ids; it does not make invented
    // ones real.
    const res = requireItemConsent(withItems, {
      choice: "approve",
      itemIds: ["ghost"],
      consentAll: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown itemId(s): ghost");
  });
});

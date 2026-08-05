/**
 * The fire-time consent verdict — `reconcileDelegationConsent`.
 *
 * This is the whole of D6's gate expressed as a pure function, so the
 * matrix is exhaustible here rather than through a ladder fixture. Three
 * verdicts, and each one is asserted BOTH ways: the case that reaches it
 * and the neighbouring case that does not. "It parks" is satisfied by a
 * function that parks unconditionally, and "it carries" by one that never
 * checks — the pairs are what make either claim mean anything.
 *
 * ## The property under test, said once
 *
 * A consent control refuses authority the human did not see. Authority is
 * REACH, reach is the capability closure, and the closure is a set — so
 * the only unsafe direction is GROWTH. Everything below is that sentence
 * with the corners filled in: growth parks, shrinkage carries, identical
 * sets carry, restructuring is not a change, and a digest that moved with
 * no set movement is a release rather than a re-grant.
 */
import { test, expect, describe } from "bun:test";
import {
  reconcileDelegationConsent,
  reconcileCapabilityKey,
  CONSENT_CARRIED_FORWARD_REASON,
  type ComputedDelegationConsent,
  type ReconcileCapability,
  type StoredDelegationConsent,
} from "../runtime/workflow-consent-reconcile";

const READ: ReconcileCapability = { kind: "filesystem", value: "/repo" };
const WRITE: ReconcileCapability = { kind: "filesystem", value: "/out" };
const AGENT: ReconcileCapability = { kind: "agent", value: null };

function stored(over: Partial<StoredDelegationConsent> = {}): StoredDelegationConsent {
  return {
    consentHash: "semantic-1",
    definitionHash: "graph-1",
    capabilitySet: [READ],
    ...over,
  };
}

function computed(over: Partial<ComputedDelegationConsent> = {}): ComputedDelegationConsent {
  return {
    consentHash: "semantic-1",
    definitionHash: "graph-1",
    capabilitySet: [READ],
    ...over,
  };
}

describe("the key shape matches what the hash takes", () => {
  test("`kind::value`, and a null value is the empty string", () => {
    // Not cosmetic: the stored set and the hashed set are compared as
    // strings, so a second spelling of the key here would make every
    // comparison a mismatch and every fire a park.
    expect(reconcileCapabilityKey(READ)).toBe("filesystem::/repo");
    expect(reconcileCapabilityKey(AGENT)).toBe("agent::");
  });
});

describe("fresh — both digests match", () => {
  test("nothing moved, so nothing is reported", () => {
    expect(reconcileDelegationConsent(stored(), computed())).toEqual({ kind: "fresh" });
  });

  test("…and it is the DIGESTS that decide, not the set", () => {
    // The pair. A run whose digests agree is not re-derived from the set:
    // the semantic digest already covers the closure, so agreeing digests
    // over a disagreeing set means the row was written inconsistently, and
    // the fast path is deliberately the fast path.
    expect(
      reconcileDelegationConsent(stored({ capabilitySet: [] }), computed()),
    ).toEqual({ kind: "fresh" });
  });
});

describe("park — the closure GREW", () => {
  test("one added key parks, and names it", () => {
    const verdict = reconcileDelegationConsent(
      stored({ consentHash: "semantic-0" }),
      computed({ capabilitySet: [READ, WRITE] }),
    );
    expect(verdict).toEqual({ kind: "park", added: ["filesystem::/out"] });
  });

  test("added keys are sorted and de-duplicated", () => {
    // The set is a SET. Two definitions in a closure declaring the same
    // capability authorize one thing, and an operator reading the audit
    // row must not be told it was added twice.
    const verdict = reconcileDelegationConsent(
      stored({ consentHash: "semantic-0", capabilitySet: [] }),
      computed({ capabilitySet: [WRITE, AGENT, READ, WRITE] }),
    );
    expect(verdict).toEqual({
      kind: "park",
      added: ["agent::", "filesystem::/out", "filesystem::/repo"],
    });
  });

  test("a SIMULTANEOUS narrowing does not excuse the growth", () => {
    // The sharp one. A release that swaps `/repo` for `/out` reaches
    // somewhere new, and "the set is the same size" is not a defence.
    const verdict = reconcileDelegationConsent(
      stored({ consentHash: "semantic-0" }),
      computed({ capabilitySet: [WRITE] }),
    );
    expect(verdict).toEqual({ kind: "park", added: ["filesystem::/out"] });
  });

  test("growth parks even when only the ADVISORY digest is what moved", () => {
    // The definition digest changing is the "a release edited it" signal,
    // and it must not be able to route a widening down the carry path.
    const verdict = reconcileDelegationConsent(
      stored({ definitionHash: "graph-0" }),
      computed({ capabilitySet: [READ, WRITE] }),
    );
    expect(verdict).toEqual({ kind: "park", added: ["filesystem::/out"] });
  });
});

describe("carry — something moved and NOTHING was added", () => {
  test("a DEFINITION-only release carries, with an empty `removed`", () => {
    // The defect this split exists for: a bundled extension's workflow
    // ships in the app image, so every release moved the old combined
    // digest and parked every delegation on it.
    const verdict = reconcileDelegationConsent(
      stored({ definitionHash: "graph-0" }),
      computed(),
    );
    expect(verdict).toEqual({
      kind: "carry",
      removed: [],
      semanticChanged: false,
      definitionChanged: true,
    });
  });

  test("a NARROWED closure carries, and names what the job lost", () => {
    const verdict = reconcileDelegationConsent(
      stored({ consentHash: "semantic-0", capabilitySet: [READ, WRITE, AGENT] }),
      computed({ capabilitySet: [READ] }),
    );
    expect(verdict).toEqual({
      kind: "carry",
      removed: ["agent::", "filesystem::/out"],
      semanticChanged: true,
      definitionChanged: false,
    });
  });

  test("a closure emptied entirely still carries — narrowing is never a refusal", () => {
    const verdict = reconcileDelegationConsent(
      stored({ consentHash: "semantic-0" }),
      computed({ capabilitySet: [] }),
    );
    expect(verdict).toMatchObject({ kind: "carry", removed: ["filesystem::/repo"] });
  });

  test("RESTRUCTURING is not a change: the same keys in a different order carry", () => {
    // A capability that moves from one definition in the closure to
    // another authorizes the same thing, which is why the closure is
    // flattened before it is compared.
    const verdict = reconcileDelegationConsent(
      stored({ consentHash: "semantic-0", capabilitySet: [READ, WRITE] }),
      computed({ capabilitySet: [WRITE, READ] }),
    );
    expect(verdict).toEqual({
      kind: "carry",
      removed: [],
      semanticChanged: true,
      definitionChanged: false,
    });
  });

  test("BOTH digests moving with no added key still carries", () => {
    const verdict = reconcileDelegationConsent(
      stored({ consentHash: "semantic-0", definitionHash: "graph-0" }),
      computed({ capabilitySet: [] }),
    );
    expect(verdict).toEqual({
      kind: "carry",
      removed: ["filesystem::/repo"],
      semanticChanged: true,
      definitionChanged: true,
    });
  });

  test("a PRE-SPLIT row (definition_hash NULL) reads as a definition change", () => {
    // The migration path, and the reason no backfill is performed: a row
    // written before the split has no honest value for the column, so
    // NULL routes it through the widening test on its first fire.
    const verdict = reconcileDelegationConsent(
      stored({ definitionHash: null }),
      computed(),
    );
    expect(verdict).toEqual({
      kind: "carry",
      removed: [],
      semanticChanged: false,
      definitionChanged: true,
    });
  });

  test("…and a PRE-SPLIT row whose closure GREW still parks", () => {
    // The pair. The nullable column is a migration affordance, never an
    // exemption from the gate.
    expect(
      reconcileDelegationConsent(
        stored({ definitionHash: null, consentHash: "a-v1-combined-digest" }),
        computed({ capabilitySet: [READ, WRITE] }),
      ),
    ).toEqual({ kind: "park", added: ["filesystem::/out"] });
  });
});

describe("the audit reason is a shared constant", () => {
  test("it reads 're-authorized by release', verbatim", () => {
    // The string an operator greps `audit_log` for when asking why a job
    // kept running across a deploy. A second spelling in a second place
    // is how that search starts missing rows.
    expect(CONSENT_CARRIED_FORWARD_REASON).toBe("re-authorized by release");
  });
});

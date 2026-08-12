/**
 * `critical-consequence.ts` — the one place that says what the agent loop
 * loses when a `critical` bundled extension is off.
 *
 * Two readers share it: the startup invariant logs the third-person form,
 * and the Extensions page shows the second-person form before a user
 * switches one off. The tests that matter are therefore (a) both critical
 * extensions have SPECIFIC text — the text was copy-pasted per call site
 * until `task-tracking` was being described as "agents cannot ask the
 * user", which is simply wrong — and (b) the fallback degrades to a vaguer
 * sentence rather than to nothing, so a future critical entry nobody
 * remembers to enumerate still warns.
 */

import { test, expect, describe } from "bun:test";
import {
  consequenceFor,
  userConsequenceFor,
} from "../extensions/critical-consequence";
import { getCriticalBundledExtensions } from "../extensions/bundled";

const CRITICAL = getCriticalBundledExtensions().map((c) => c.name);
const GENERIC_LOG = "agents lose a loop-safety capability";

describe("consequenceFor (log form)", () => {
  test("each critical extension gets its OWN clause", () => {
    expect(consequenceFor("ask-user")).toBe("agents cannot ask the user for clarification");
    expect(consequenceFor("task-tracking")).toBe(
      "agents cannot self-structure recovery / track multi-step work",
    );
    expect(consequenceFor("extension-author")).toBe(
      "agents cannot author or install extensions in chat",
    );
    // The bug this guards: one clause reused across all of them.
    expect(new Set(CRITICAL.map(consequenceFor)).size).toBe(CRITICAL.length);
  });

  test("every catalog-critical extension has non-generic text", () => {
    // Fails the day a third `critical: true` entry lands without a clause,
    // which is the only moment anyone can cheaply write one.
    for (const name of CRITICAL) {
      expect(consequenceFor(name)).not.toBe(GENERIC_LOG);
    }
  });

  test("an unknown name falls back to a generic clause, never empty", () => {
    expect(consequenceFor("not-a-critical-extension")).toBe(GENERIC_LOG);
  });
});

describe("userConsequenceFor (second-person form)", () => {
  test("addresses the reader directly", () => {
    // The log wants "agents cannot ask the user"; the person about to click
    // the toggle wants "ask you".
    expect(userConsequenceFor("ask-user")).toContain("you");
    expect(userConsequenceFor("task-tracking")).toContain("With it off");
  });

  test("every catalog-critical extension has non-generic text", () => {
    const generic = userConsequenceFor("not-a-critical-extension");
    for (const name of CRITICAL) {
      expect(userConsequenceFor(name)).not.toBe(generic);
    }
  });

  test("an unknown name falls back to a full sentence", () => {
    const fallback = userConsequenceFor("not-a-critical-extension");
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).toContain("loop safety");
  });
});

/**
 * Preparing a step result for `workflow_step_runs.output`: credential
 * redaction (ported invariant #12) and the size cap whose overflow a
 * resume must fail closed on.
 *
 * Pure — no DB, no clock. The persistence side of the same column
 * (the upsert and `loadStepResults`) is covered in
 * `workflow-run-persistence.test.ts` against real PGlite.
 */
import { test, expect, describe } from "bun:test";
import { redactSecrets, redactSecretsDeep } from "../runtime/secret-redaction";
import {
  isTruncatedStepOutput,
  MAX_STEP_OUTPUT_BYTES,
  prepareStepOutput,
} from "../runtime/workflow-step-output";
import type { AgentResult } from "../types";

describe("redactSecrets", () => {
  // One case per pattern: the port is verbatim, so a pattern that stops
  // matching here has silently diverged from the extension's copy.
  test.each([
    ['api_key: "abcdefghijklmnop"', "keyed credential"],
    ["ACCESS-TOKEN=abcdefghijklmnop", "hyphenated key form"],
    ["password: hunter2hunter2hunter2", "password"],
    ["authorization: Bearerabcdefghijkl", "authorization header"],
    ["sk-abcdefghijklmnopqrstuvwxyz", "OpenAI-style key"],
    ["ghp_abcdefghijklmnopqrstuvwxyz", "GitHub PAT"],
    ["gho_abcdefghijklmnopqrstuvwxyz", "GitHub OAuth token"],
    ["xoxb-abcdefghijklmnop", "Slack bot token"],
    ["AKIAABCDEFGHIJKLMNOP", "AWS access key id"],
    ["eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM", "JWT"],
  ])("redacts %j (%s)", (input) => {
    expect(redactSecrets(input)).toContain("[REDACTED]");
  });

  test("leaves innocent text byte-identical", () => {
    const clean = "Step 3 wrote 12 files to src/runtime and passed every gate.";
    expect(redactSecrets(clean)).toBe(clean);
  });

  test("redacts EVERY occurrence, not just the first", () => {
    // The patterns carry the `g` flag; a stateful `lastIndex` would make
    // this skip every other match.
    const two = "sk-aaaaaaaaaaaaaaaaaaaaaa and sk-bbbbbbbbbbbbbbbbbbbbbb";
    const out = redactSecrets(two);
    expect(out).toBe("[REDACTED] and [REDACTED]");
  });

  test("is stable across repeated calls on the same shared regexes", () => {
    // Guards the same `lastIndex` hazard across CALLS rather than within
    // one: the module-level patterns are reused for the life of the
    // process, so call N must behave exactly like call 1.
    const input = "ghp_abcdefghijklmnopqrstuvwxyz";
    const first = redactSecrets(input);
    for (let i = 0; i < 5; i++) expect(redactSecrets(input)).toBe(first);
  });
});

describe("redactSecretsDeep", () => {
  test("scrubs strings at every depth, in objects and arrays alike", () => {
    const out = redactSecretsDeep({
      note: "sk-aaaaaaaaaaaaaaaaaaaaaa",
      nested: { deeper: ["ghp_bbbbbbbbbbbbbbbbbbbbbb", "fine"] },
    });
    expect(out).toEqual({
      note: "[REDACTED]",
      nested: { deeper: ["[REDACTED]", "fine"] },
    });
  });

  test("leaves object KEYS alone", () => {
    // A key is a field name the workflow author chose, and rewriting one
    // would change the shape a later `$steps.<name>.<field>` ref
    // addresses. Only values are untrusted content.
    const out = redactSecretsDeep({ api_key: "short" }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["api_key"]);
  });

  test("never changes a non-string's TYPE", () => {
    // An `eq` condition against a number has to keep working.
    const out = redactSecretsDeep({ n: 42, b: true, z: null, u: undefined });
    expect(out).toEqual({ n: 42, b: true, z: null, u: undefined });
  });

  test("passes a bare primitive straight through", () => {
    expect(redactSecretsDeep(7)).toBe(7);
    expect(redactSecretsDeep(null)).toBeNull();
    expect(redactSecretsDeep("clean")).toBe("clean");
  });
});

describe("isTruncatedStepOutput", () => {
  test("recognizes the sentinel and nothing else", () => {
    expect(isTruncatedStepOutput({ __truncated: true, bytes: 1 })).toBe(true);
    // A real result must never be mistaken for the sentinel.
    expect(isTruncatedStepOutput({ success: true, output: null })).toBe(false);
    expect(isTruncatedStepOutput({ __truncated: false, bytes: 1 })).toBe(false);
    expect(isTruncatedStepOutput(null)).toBe(false);
    expect(isTruncatedStepOutput("__truncated")).toBe(false);
    expect(isTruncatedStepOutput(undefined)).toBe(false);
  });
});

describe("prepareStepOutput", () => {
  test("returns a small result redacted, with its shape intact", () => {
    const result: AgentResult = {
      success: true,
      output: { token: "sk-aaaaaaaaaaaaaaaaaaaaaa", draftId: "d-1" },
    };
    const prepared = prepareStepOutput(result);
    expect(prepared).toEqual({
      success: true,
      output: { token: "[REDACTED]", draftId: "d-1" },
    });
  });

  test("replaces an oversized result with the sentinel, carrying the size", () => {
    const prepared = prepareStepOutput({
      success: true,
      output: "x".repeat(MAX_STEP_OUTPUT_BYTES + 1),
    });
    expect(isTruncatedStepOutput(prepared)).toBe(true);
    // The recorded size is what tells an operator how far over it went.
    expect((prepared as { bytes: number }).bytes).toBeGreaterThan(
      MAX_STEP_OUTPUT_BYTES,
    );
  });

  test("redacts BEFORE measuring, so redaction can bring a payload under the cap", () => {
    // 15k secrets at 24 bytes each is ~360 KB raw — over the cap — but
    // each collapses to a 10-byte `[REDACTED]`, landing ~150 KB. If the
    // order were reversed this would be stored as the sentinel and the
    // step's value would be needlessly unrecoverable.
    const secret = "sk-aaaaaaaaaaaaaaaaaaaaa";
    expect(secret.length).toBe(24);
    const prepared = prepareStepOutput({
      success: true,
      output: Array.from({ length: 15_000 }, () => secret),
    });
    expect(isTruncatedStepOutput(prepared)).toBe(false);
    const out = (prepared as AgentResult).output as string[];
    expect(out).toHaveLength(15_000);
    expect(new Set(out)).toEqual(new Set(["[REDACTED]"]));
  });

  test("returns undefined for a result that cannot be serialized", () => {
    // Stored as SQL NULL, which a resume treats exactly like a truncated
    // value — fail closed. Writing a half-value would produce a row a
    // resume would trust.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(prepareStepOutput({ success: true, output: cyclic })).toBeUndefined();
  });

  test("stores a result sitting exactly on the cap", () => {
    // Boundary is `> cap`, not `>= cap`.
    const filler = "y".repeat(MAX_STEP_OUTPUT_BYTES);
    const prepared = prepareStepOutput({ success: true, output: filler });
    const exact = Buffer.byteLength(
      JSON.stringify({ success: true, output: filler }),
      "utf8",
    );
    // Sanity: the JSON wrapper pushes this over, so it must truncate...
    expect(exact).toBeGreaterThan(MAX_STEP_OUTPUT_BYTES);
    expect(isTruncatedStepOutput(prepared)).toBe(true);

    // ...while a payload whose FULL JSON lands on the cap is kept.
    const room = MAX_STEP_OUTPUT_BYTES - JSON.stringify({ success: true, output: "" }).length;
    const onCap: AgentResult = { success: true, output: "y".repeat(room) };
    expect(Buffer.byteLength(JSON.stringify(onCap), "utf8")).toBe(MAX_STEP_OUTPUT_BYTES);
    expect(isTruncatedStepOutput(prepareStepOutput(onCap))).toBe(false);
  });
});

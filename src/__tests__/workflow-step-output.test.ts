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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets, redactSecretsDeep } from "../runtime/secret-redaction";
import {
  isTruncatedStepOutput,
  MAX_RESOLVED_INPUT_BYTES,
  MAX_STEP_OUTPUT_BYTES,
  prepareResolvedInput,
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
    expect((prepared as { bytes: number }).bytes).toBeGreaterThan(MAX_STEP_OUTPUT_BYTES);
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
    const exact = Buffer.byteLength(JSON.stringify({ success: true, output: filler }), "utf8");
    // Sanity: the JSON wrapper pushes this over, so it must truncate...
    expect(exact).toBeGreaterThan(MAX_STEP_OUTPUT_BYTES);
    expect(isTruncatedStepOutput(prepared)).toBe(true);

    // ...while a payload whose FULL JSON lands on the cap is kept.
    const room = MAX_STEP_OUTPUT_BYTES - JSON.stringify({ success: true, output: "" }).length;
    const onCap: AgentResult = { success: true, output: "y".repeat(room) };
    expect(Buffer.byteLength(JSON.stringify(onCap), "utf8")).toBe(MAX_STEP_OUTPUT_BYTES);
    expect(isTruncatedStepOutput(prepareStepOutput(onCap))).toBe(false);
  });

  test("the sentinel's `bytes` is the REDACTED size, not the raw size", () => {
    // The truncation branch of redact-then-measure, which the test above
    // does not reach: there, redaction brought the payload under the cap
    // and the sentinel was never built.
    //
    // The property is that the number stored describes what WOULD have
    // been stored. Measuring first would report the raw size, which
    // overstates the row by however much the credentials weighed and
    // makes the "how far over did it go" signal unusable.
    const secret = "sk-aaaaaaaaaaaaaaaaaaaaa";
    const entries = 30_000;
    const prepared = prepareStepOutput({
      success: true,
      output: Array.from({ length: entries }, () => secret),
    });
    expect(isTruncatedStepOutput(prepared)).toBe(true);
    const reported = (prepared as { bytes: number }).bytes;

    const rawBytes = Buffer.byteLength(
      JSON.stringify({ success: true, output: Array.from({ length: entries }, () => secret) }),
      "utf8",
    );
    const redactedBytes = Buffer.byteLength(
      JSON.stringify({
        success: true,
        output: Array.from({ length: entries }, () => "[REDACTED]"),
      }),
      "utf8",
    );
    // Both are over the cap, so this discriminates the two orderings
    // rather than merely the two outcomes.
    expect(rawBytes).toBeGreaterThan(MAX_STEP_OUTPUT_BYTES);
    expect(redactedBytes).toBeGreaterThan(MAX_STEP_OUTPUT_BYTES);
    expect(redactedBytes).toBeLessThan(rawBytes);
    expect(reported).toBe(redactedBytes);
  });
});

describe("prepareResolvedInput", () => {
  test("redacts a credential threaded through the ref language", () => {
    // This is the whole reason the column is redacted: `resolved_input`
    // is whatever `$input` / `$steps` / `$prev` produced, which routinely
    // carries credentials an author threaded in — and the trace UI
    // renders it.
    const prepared = prepareResolvedInput({
      repo: "ezcorp/harness",
      token: "ghp_aaaaaaaaaaaaaaaaaaaaaa",
      nested: { auth: "Bearer eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM" },
      count: 3,
    });
    expect(prepared).toEqual({
      repo: "ezcorp/harness",
      token: "[REDACTED]",
      nested: { auth: "Bearer [REDACTED]" },
      // A non-string keeps its type, so a later numeric read still works.
      count: 3,
    });
  });

  test("caps at 64 KB — smaller than output's, and enforced", () => {
    // An input mapping is a handful of resolved refs; one needing 256 KB
    // is a smell. Unlike `output` this column is never read by a resume,
    // so truncating costs detail and not correctness.
    expect(MAX_RESOLVED_INPUT_BYTES).toBe(64 * 1024);
    expect(MAX_RESOLVED_INPUT_BYTES).toBeLessThan(MAX_STEP_OUTPUT_BYTES);

    const prepared = prepareResolvedInput({ blob: "x".repeat(MAX_RESOLVED_INPUT_BYTES + 1) });
    expect(isTruncatedStepOutput(prepared)).toBe(true);
    expect((prepared as { bytes: number }).bytes).toBeGreaterThan(MAX_RESOLVED_INPUT_BYTES);

    // A payload that fits under the SMALLER cap but would also have fit
    // under output's is stored — the cap is real, not decorative.
    const small = prepareResolvedInput({ blob: "x".repeat(1000) });
    expect(isTruncatedStepOutput(small)).toBe(false);
  });

  test("redacts BEFORE measuring, so a secret-heavy input still fits", () => {
    // Same ordering guarantee `output` gets, proven against the smaller
    // cap: 2500 secrets at 24 bytes is ~67 KB raw — over — and ~33 KB
    // once each collapses to `[REDACTED]`.
    const secret = "sk-aaaaaaaaaaaaaaaaaaaaa";
    const values = Array.from({ length: 2500 }, () => secret);
    expect(Buffer.byteLength(JSON.stringify({ values }), "utf8")).toBeGreaterThan(
      MAX_RESOLVED_INPUT_BYTES,
    );

    const prepared = prepareResolvedInput({ values });
    expect(isTruncatedStepOutput(prepared)).toBe(false);
    const out = (prepared as { values: string[] }).values;
    expect(new Set(out)).toEqual(new Set(["[REDACTED]"]));
  });

  test("stores an input sitting exactly on the cap", () => {
    // Boundary is `> cap`, not `>= cap` — the same reading as output's.
    const room = MAX_RESOLVED_INPUT_BYTES - JSON.stringify({ v: "" }).length;
    const onCap = { v: "y".repeat(room) };
    expect(Buffer.byteLength(JSON.stringify(onCap), "utf8")).toBe(MAX_RESOLVED_INPUT_BYTES);
    expect(isTruncatedStepOutput(prepareResolvedInput(onCap))).toBe(false);
  });

  test("returns undefined for an input that cannot be serialized", () => {
    // The serializability gate runs before the redaction walk, which has
    // no cycle guard. Without it this blows the stack and takes the run
    // with it; with it the caller writes SQL NULL.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(prepareResolvedInput(cyclic)).toBeUndefined();
  });
});

describe("one redactor, not two", () => {
  test("exactly one module in src/ implements a secret redactor", () => {
    // Acceptance criterion 3, asserted structurally because the failure
    // mode is silent: a second implementation would not throw when it
    // drifted from this one — it would keep storing values, just less
    // redacted ones, into a table the trace UI renders.
    //
    // Matches a DEFINITION (`function redactSecret…`), not a call site,
    // so importing the real thing is always fine.
    const root = join(import.meta.dir, "..");
    const definers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        if (/(?:function|const)\s+redactSecret\w*\s*[(=]/.test(readFileSync(full, "utf8"))) {
          definers.push(full.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(definers.sort()).toEqual(["runtime/secret-redaction.ts"]);
  });
});

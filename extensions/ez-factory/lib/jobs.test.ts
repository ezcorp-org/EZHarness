import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { __resetChannelForTests, getChannel } from "@ezcorp/sdk/runtime";
import type { HostChannel } from "@ezcorp/sdk/runtime";
import manifest from "../ezcorp.config";
import { JOB_FORM_FIELDS, jobIdFromActionPayload } from "./page";
import {
  BACKGROUND_TRIGGER_KINDS,
  createJobStore,
  diffJob,
  FACTORY_WORKFLOWS,
  isBackgroundTrigger,
  isFactoryWorkflow,
  isValidJobId,
  JOB_DRAFT_FIELDS,
  JOB_ID_RE,
  JOB_SETTABLE_INPUT_KEYS,
  JOB_STORAGE_SCOPE,
  JOB_STORE_VERSION,
  jobSettableInputKeys,
  MAX_CRON_LEN,
  MAX_JOB_DESCRIPTION_LEN,
  MAX_JOB_INPUT_CHARS,
  MAX_JOB_INPUT_DEPTH,
  MAX_JOB_NAME_LEN,
  MAX_JOB_RUNS_PER_DAY,
  MAX_JOB_TOKENS_PER_RUN,
  MAX_RUNS_PER_JOB,
  MAX_TIMEZONE_LEN,
  newJobId,
  RESERVED_CONTROL_FLOW_FIELDS,
  TRIGGER_ENVELOPE,
  triggerBounds,
  validateJobDraft,
  type FactoryJob,
  type JobRunRecord,
  type ValidatedJobDraft,
} from "./jobs";

/** The manifest's declared trigger envelope, for the mirror assertion. */
const manifestTriggers = (
  manifest.permissions as unknown as {
    triggers: { maxCron: number; maxWebhooks: number; maxRunsPerDay: number };
  }
).triggers;

// ── Fixtures ────────────────────────────────────────────────────────

/** Build a draft through the real validator; a bad fixture is a test bug. */
function draft(over: Record<string, unknown> = {}): ValidatedJobDraft {
  const result = validateJobDraft({ name: "Docs", workflow: "docs-factory", ...over });
  if (!result.ok) throw new Error(`fixture did not validate: ${result.error}`);
  return result.value;
}

/** Assert a draft is refused and hand back the message for a named check. */
function rejection(input: unknown): string {
  const result = validateJobDraft(input);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error;
}

const OPTS = { actor: "user-1", now: "2026-08-01T00:00:00.000Z" };

function job(over: Partial<FactoryJob> = {}): FactoryJob {
  return {
    id: "j1",
    name: "Docs",
    description: "",
    workflow: "docs-factory",
    input: {},
    trigger: { kind: "manual" },
    enabled: true,
    runAs: { kind: "user", id: "user-1" },
    consentHash: null,
    createdBy: "user-1",
    createdAt: OPTS.now,
    updatedBy: "user-1",
    updatedAt: OPTS.now,
    ...over,
  };
}

function runRecord(over: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    jobId: "j1",
    workflowRunId: "run-1",
    workflowName: "ez-factory:docs-factory",
    status: "running",
    startedAt: OPTS.now,
    finishedAt: null,
    suspendedReason: null,
    resumable: false,
    ...over,
  };
}

/**
 * In-memory stand-in for the host's storage handler.
 *
 * `delayMs > 0` makes `get` genuinely asynchronous, which is what opens the
 * interleaving window the lost-update test needs — an instantly-resolving
 * stub would hide the race the lock exists to prevent.
 */
function stubStorage(delayMs = 0): {
  mem: Map<string, unknown>;
  calls: { action: string; key: string }[];
} {
  const mem = new Map<string, unknown>();
  const calls: { action: string; key: string }[] = [];
  const channel = getChannel() as HostChannel;
  spyOn(channel, "request").mockImplementation((async (_method: string, params: unknown) => {
    const p = params as Record<string, unknown>;
    const key = String(p.key);
    calls.push({ action: String(p.action), key });
    if (p.action === "set") {
      mem.set(key, JSON.parse(JSON.stringify(p.value)));
      return { ok: true, sizeBytes: 1 };
    }
    if (p.action === "delete") return { deleted: mem.delete(key) };
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return mem.has(key)
      ? { value: mem.get(key), exists: true }
      : { value: null, exists: false };
  }) as HostChannel["request"]);
  return { mem, calls };
}

// ── Shipped-workflow constant ───────────────────────────────────────

describe("FACTORY_WORKFLOWS", () => {
  test("matches permissions.workflows.names in the manifest byte for byte", () => {
    // The two lists are the same security boundary read from two files. If
    // they drift, a job validates against a workflow the grant does not
    // authorize (or vice versa) and the failure surfaces at run time.
    expect(manifest.permissions?.workflows?.names).toEqual([...FACTORY_WORKFLOWS]);
  });

  test("isFactoryWorkflow accepts the three bare names and nothing else", () => {
    for (const name of FACTORY_WORKFLOWS) expect(isFactoryWorkflow(name)).toBe(true);
    expect(isFactoryWorkflow("ez-factory:docs-factory")).toBe(false);
    expect(isFactoryWorkflow("my-fork")).toBe(false);
    expect(isFactoryWorkflow(7)).toBe(false);
    expect(isFactoryWorkflow(undefined)).toBe(false);
  });

  test("jobSettableInputKeys returns the allowlist for each workflow", () => {
    for (const name of FACTORY_WORKFLOWS) {
      expect(jobSettableInputKeys(name)).toEqual(JOB_SETTABLE_INPUT_KEYS[name]);
    }
  });
});

// ── Invariant B — a job cannot configure away a protected step ──────
//
// Discrimination is built in rather than asserted about: every "X is
// refused" below is paired with a "Y is accepted" on the same code path, so
// a validator that rejected everything — or an allowlist collapsed to `[]` —
// fails these tests instead of passing them vacuously.

describe("invariant B — a job cannot skip a gate or approval step", () => {
  test("PROOF THE CONTROL IS LIVE: every workflow has a non-empty allowlist, and a listed key is accepted", () => {
    // Guards the vacuous pass. Emptying JOB_SETTABLE_INPUT_KEYS would make
    // every "unlisted key is refused" test below pass for the wrong reason;
    // this fails first.
    for (const workflow of FACTORY_WORKFLOWS) {
      const allowed = JOB_SETTABLE_INPUT_KEYS[workflow];
      expect(allowed.length).toBeGreaterThan(0);
      for (const key of allowed) {
        const result = validateJobDraft({
          name: "J",
          workflow,
          input: { [key]: "value" },
        });
        expect(result.ok).toBe(true);
      }
    }
  });

  test("door 1: an input key outside the workflow's allowlist is REFUSED", () => {
    // A `gate`/`approval` step guarded by `when: {ref: $input.needsReview,
    // op: eq, value: true}` is skipped by an operator who supplies `false`
    // AND by one who omits the key — `$input` resolves leniently, so a
    // value-level check cannot defend it. Only the closed key allowlist can.
    const error = rejection({
      name: "J",
      workflow: "docs-factory",
      input: { needsReview: false },
    });
    expect(error).toContain("needsReview");
    expect(error).toContain("not settable");
    // Same shape, allowlisted key → accepted. The refusal is about the KEY.
    expect(validateJobDraft({ name: "J", workflow: "docs-factory", input: { globs: "**/*.ts" } }).ok).toBe(true);
  });

  test("door 1: the allowlist is PER WORKFLOW — a key legal on one is refused on another", () => {
    // Both directions, so a single shared allowlist would fail this.
    expect(validateJobDraft({ name: "J", workflow: "draft-and-verify", input: { draft: "d" } }).ok).toBe(true);
    expect(rejection({ name: "J", workflow: "docs-factory", input: { draft: "d" } })).toContain("not settable");
    expect(validateJobDraft({ name: "J", workflow: "docs-factory", input: { globs: "**/*" } }).ok).toBe(true);
    expect(rejection({ name: "J", workflow: "draft-and-verify", input: { globs: "**/*" } })).toContain("not settable");
  });

  test("door 1: 'priorContent'/'priorVerdict' are NOT job-settable on draft-and-verify", () => {
    // The template declares them in `inputSchema`, but `docs-factory` supplies
    // them through its `review-loop` step's `input` mapping ($loop.last.*),
    // resolved by the executor — they never pass through this store. The gap
    // is the correct shape, not an oversight to "fix".
    expect(rejection({ name: "J", workflow: "draft-and-verify", input: { priorContent: "x" } })).toContain(
      "not settable",
    );
    expect(rejection({ name: "J", workflow: "draft-and-verify", input: { priorVerdict: "x" } })).toContain(
      "not settable",
    );
  });

  test("door 1: 'now' is not settable on etl-factory — a saved job would freeze one timestamp", () => {
    // A transform does no I/O and reads no clock, so `{{ $input.now }}` is a
    // caller-supplied string. Saved on a job it would stamp the same instant
    // on every run it ever fired. The run's own `startedAt` is on the trace.
    expect(rejection({ name: "J", workflow: "etl-factory", input: { now: "2026-08-01" } })).toContain(
      "not settable",
    );
  });

  test("door 2: 'skipDependents' is refused BY NAME, with the security message", () => {
    // Flipping skipDependents true→false un-skips the dependents of a
    // skipped step: a step downstream of an unanswered gate executes, with
    // no capability declaration touched. The message must be the
    // control-flow one, not the generic unknown-field one — that is what
    // distinguishes an active refusal from an accidental one.
    const asField = rejection({ name: "J", workflow: "docs-factory", skipDependents: false });
    expect(asField).toContain("skipDependents");
    expect(asField).toContain("control flow");
    expect(asField).not.toContain("unknown job field");

    const asInputKey = rejection({
      name: "J",
      workflow: "docs-factory",
      input: { skipDependents: false },
    });
    expect(asInputKey).toContain("control flow");
  });

  test("door 2: 'when' is refused BY NAME, with the security message", () => {
    const asField = rejection({ name: "J", workflow: "docs-factory", when: { ref: "$input.x", op: "eq" } });
    expect(asField).toContain("'when'");
    expect(asField).toContain("control flow");
    expect(asField).not.toContain("unknown job field");
  });

  test("door 2: every RESERVED_CONTROL_FLOW_FIELDS name is refused as a field and as an input key", () => {
    expect(RESERVED_CONTROL_FLOW_FIELDS.length).toBeGreaterThan(0);
    for (const name of RESERVED_CONTROL_FLOW_FIELDS) {
      expect(rejection({ name: "J", workflow: "docs-factory", [name]: "x" })).toContain("control flow");
      expect(
        rejection({ name: "J", workflow: "docs-factory", input: { [name]: "x" } }),
      ).toContain("control flow");
    }
  });

  test("door 2: a reserved name NESTED inside an allowlisted input value is refused too", () => {
    expect(
      rejection({ name: "J", workflow: "docs-factory", input: { globs: { when: "x" } } }),
    ).toContain("control flow");
  });

  test("door 3: a job cannot target a fork, and cannot name the namespaced form", () => {
    // A fork with the gate deleted is the same bypass by another route.
    expect(rejection({ name: "J", workflow: "my-fork" })).toContain("workflow must be one of");
    const namespaced = rejection({ name: "J", workflow: "ez-factory:docs-factory" });
    expect(namespaced).toContain("BARE name");
    // …and the bare form of the same workflow IS accepted, so the refusal is
    // about the prefix, not about the name.
    expect(validateJobDraft({ name: "J", workflow: "docs-factory" }).ok).toBe(true);
  });

  test("the store has no unvalidated write path: saveJob replaces the whole editable subset", async () => {
    // ez-code-factory's `updateJob(id, patch: Partial<Job>)` merges an
    // arbitrary patch straight into the row — a second write path around its
    // own PROTECTED_STEPS check. Here every semantic field arrives as a
    // ValidatedJobDraft, so a save cannot introduce one the validator never
    // saw.
    stubStorage();
    const store = createJobStore();
    await store.createJob(draft({ input: { globs: "a" } }), { id: "j1", ...OPTS });
    const saved = await store.saveJob("j1", draft({ input: { globs: "b" } }), OPTS);
    expect(saved?.input).toEqual({ globs: "b" });
  });
});

// ── validateJobDraft — shape and bounds ─────────────────────────────

describe("validateJobDraft — shape", () => {
  test("a non-object, null, or array draft is refused", () => {
    expect(rejection("nope")).toBe("job must be an object");
    expect(rejection(null)).toBe("job must be an object");
    expect(rejection([])).toBe("job must be an object");
  });

  test("an unknown field is refused, naming the allowed set", () => {
    const error = rejection({ name: "J", workflow: "docs-factory", projectId: "p1" });
    expect(error).toContain("unknown job field 'projectId'");
    expect(error).toContain(JOB_DRAFT_FIELDS.join(", "));
  });

  test("a valid draft normalizes: trimmed text, empty description, manual trigger, enabled", () => {
    const result = validateJobDraft({ name: "  Docs  ", workflow: "docs-factory" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({
      name: "Docs",
      description: "",
      workflow: "docs-factory",
      input: {},
      trigger: { kind: "manual" },
      enabled: true,
    } as ValidatedJobDraft);
  });
});

describe("validateJobDraft — bounds", () => {
  test("name is required: absent, blank, and whitespace-only are refused", () => {
    expect(rejection({ workflow: "docs-factory" })).toBe("name is required");
    expect(rejection({ name: "", workflow: "docs-factory" })).toBe("name is required");
    expect(rejection({ name: "   ", workflow: "docs-factory" })).toBe("name is required");
  });

  test("name must be a string", () => {
    expect(rejection({ name: 42, workflow: "docs-factory" })).toBe("name must be a string");
  });

  test(`name is refused over ${MAX_JOB_NAME_LEN} characters, and accepted at exactly it`, () => {
    expect(validateJobDraft({ name: "n".repeat(MAX_JOB_NAME_LEN), workflow: "docs-factory" }).ok).toBe(true);
    const error = rejection({ name: "n".repeat(MAX_JOB_NAME_LEN + 1), workflow: "docs-factory" });
    expect(error).toContain(`name must be ${MAX_JOB_NAME_LEN} characters or fewer`);
    expect(error).toContain(String(MAX_JOB_NAME_LEN + 1));
  });

  test("over-length text is REJECTED, never silently clamped", () => {
    // The divergence from ez-code-factory, which clamps job text to 500. A
    // truncated description is a wrong description the operator was never
    // told about.
    const long = "d".repeat(MAX_JOB_DESCRIPTION_LEN + 1);
    expect(rejection({ name: "J", workflow: "docs-factory", description: long })).toContain(
      `description must be ${MAX_JOB_DESCRIPTION_LEN} characters or fewer`,
    );
    const atLimit = validateJobDraft({
      name: "J",
      workflow: "docs-factory",
      description: "d".repeat(MAX_JOB_DESCRIPTION_LEN),
    });
    expect(atLimit.ok && atLimit.value.description.length).toBe(MAX_JOB_DESCRIPTION_LEN);
  });

  test("description must be a string; null is treated as absent", () => {
    expect(rejection({ name: "J", workflow: "docs-factory", description: 3 })).toBe(
      "description must be a string",
    );
    const withNull = validateJobDraft({ name: "J", workflow: "docs-factory", description: null });
    expect(withNull.ok && withNull.value.description).toBe("");
  });

  test("workflow is required and must be one of the three", () => {
    expect(rejection({ name: "J" })).toContain("got nothing");
    expect(rejection({ name: "J", workflow: 5 })).toContain("got nothing");
  });

  test("enabled must be a boolean; false survives, absent defaults true", () => {
    expect(rejection({ name: "J", workflow: "docs-factory", enabled: "yes" })).toBe(
      "enabled must be a boolean",
    );
    const off = validateJobDraft({ name: "J", workflow: "docs-factory", enabled: false });
    expect(off.ok && off.value.enabled).toBe(false);
  });
});

describe("validateJobDraft — trigger", () => {
  test("absent trigger defaults to manual", () => {
    const result = validateJobDraft({ name: "J", workflow: "docs-factory" });
    expect(result.ok && result.value.trigger).toEqual({ kind: "manual" });
  });

  test("manual is accepted", () => {
    const result = validateJobDraft({ name: "J", workflow: "docs-factory", trigger: { kind: "manual" } });
    expect(result.ok && result.value.trigger).toEqual({ kind: "manual" });
  });

  test("a non-object trigger is refused", () => {
    expect(rejection({ name: "J", workflow: "docs-factory", trigger: "manual" })).toBe(
      "trigger must be an object",
    );
    expect(rejection({ name: "J", workflow: "docs-factory", trigger: [] })).toBe(
      "trigger must be an object",
    );
    expect(rejection({ name: "J", workflow: "docs-factory", trigger: null })).toBe(
      "trigger must be an object",
    );
  });

  test("the two UNDISPATCHED kinds are still refused, and say why", () => {
    // `event` and `workflow` are modelled so a row written by a later
    // version round-trips; nothing registers for either, so a job carrying
    // one would save and never fire. Refusing them is the same rule that
    // used to refuse cron and webhook — it is the DISPATCH that changed,
    // not the principle.
    for (const kind of ["event", "workflow"]) {
      const error = rejection({ name: "J", workflow: "docs-factory", trigger: { kind } });
      expect(error).toContain(`trigger '${kind}' is modelled but not dispatched`);
    }
  });

  test("an unrecognized trigger kind is refused", () => {
    expect(rejection({ name: "J", workflow: "docs-factory", trigger: { kind: "sunrise" } })).toBe(
      "trigger.kind must be 'manual', 'cron' or 'webhook'",
    );
  });
});

describe("validateJobDraft — background triggers CANNOT exist without bounds", () => {
  // The blast-radius rule, and the reason it is asserted from every angle:
  // a cron job with no ceiling is a self-inflicted denial of service, and
  // this program has already shipped one permanent-DoS shape by accident.
  //
  // The bounds are on the TRIGGER's own type, so "a background job without
  // bounds" is unconstructible rather than merely rejected. These tests
  // pin the runtime half of that — the wire is `unknown` and TypeScript
  // defends nothing there.

  const cron = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: "J",
    workflow: "docs-factory",
    trigger: {
      kind: "cron",
      cron: "0 3 * * *",
      timezone: "UTC",
      maxRunsPerDay: 4,
      maxTokensPerRun: 50_000,
      ...over,
    },
  });

  test("a fully-specified cron trigger is accepted and normalized", () => {
    const result = validateJobDraft(cron());
    expect(result.ok && result.value.trigger).toEqual({
      kind: "cron",
      cron: "0 3 * * *",
      timezone: "UTC",
      maxRunsPerDay: 4,
      maxTokensPerRun: 50_000,
    });
  });

  test("a fully-specified webhook trigger is accepted and carries NO cron fields", () => {
    const result = validateJobDraft({
      name: "J",
      workflow: "docs-factory",
      // A stray `cron` on a webhook is DROPPED rather than stored: the
      // validator builds a fresh trigger from the fields that kind has,
      // so an extra key cannot ride along into storage.
      trigger: { kind: "webhook", cron: "0 3 * * *", maxRunsPerDay: 2, maxTokensPerRun: 100 },
    });
    expect(result.ok && result.value.trigger).toEqual({
      kind: "webhook",
      maxRunsPerDay: 2,
      maxTokensPerRun: 100,
    });
  });

  test("maxRunsPerDay is REQUIRED — omitting it does not default", () => {
    // No default and no unlimited, the same line core's own consent route
    // draws: a default is a number nobody chose, and an unlimited option
    // is the number everybody chooses.
    const error = rejection(cron({ maxRunsPerDay: undefined }));
    expect(error).toContain("trigger.maxRunsPerDay is required");
  });

  test("maxTokensPerRun is REQUIRED — omitting it does not default", () => {
    expect(rejection(cron({ maxTokensPerRun: undefined }))).toContain(
      "trigger.maxTokensPerRun is required",
    );
  });

  test("a webhook trigger needs both bounds too", () => {
    expect(
      rejection({ name: "J", workflow: "docs-factory", trigger: { kind: "webhook" } }),
    ).toContain("trigger.maxRunsPerDay is required");
  });

  test("maxRunsPerDay above the host's own per-key cap is REJECTED, not clamped", () => {
    // `MAX_JOB_RUNS_PER_DAY` is not a number invented here: it is
    // `defaultPerKeyCap(500, 25)` = 20, which the host applies to every
    // dynamic cron row regardless. A job saved with 21 would be throttled
    // to 20 silently, so refusing it is the honest version of the bound.
    expect(MAX_JOB_RUNS_PER_DAY).toBe(20);
    expect(rejection(cron({ maxRunsPerDay: MAX_JOB_RUNS_PER_DAY + 1 }))).toContain(
      `between 1 and ${MAX_JOB_RUNS_PER_DAY}`,
    );
    expect(validateJobDraft(cron({ maxRunsPerDay: MAX_JOB_RUNS_PER_DAY })).ok).toBe(true);
  });

  test("maxTokensPerRun above the console's cap is REJECTED, not clamped", () => {
    expect(rejection(cron({ maxTokensPerRun: MAX_JOB_TOKENS_PER_RUN + 1 }))).toContain(
      `between 1 and ${MAX_JOB_TOKENS_PER_RUN}`,
    );
    expect(validateJobDraft(cron({ maxTokensPerRun: MAX_JOB_TOKENS_PER_RUN })).ok).toBe(true);
  });

  test("zero and negative bounds are refused", () => {
    // Zero is the shape that reads as "unlimited" to a careless reader and
    // as "never" to the host. Neither is a number to store.
    expect(rejection(cron({ maxRunsPerDay: 0 }))).toContain("between 1 and");
    expect(rejection(cron({ maxRunsPerDay: -1 }))).toContain("between 1 and");
    expect(rejection(cron({ maxTokensPerRun: 0 }))).toContain("between 1 and");
  });

  test("fractional and non-finite bounds are refused", () => {
    expect(rejection(cron({ maxRunsPerDay: 2.5 }))).toContain("between 1 and");
    expect(rejection(cron({ maxTokensPerRun: Number.POSITIVE_INFINITY }))).toContain(
      "between 1 and",
    );
    expect(rejection(cron({ maxTokensPerRun: Number.NaN }))).toContain("between 1 and");
  });

  test("a NUMERIC STRING is accepted — the form wire carries only strings", () => {
    // Every value the Hub's form node collects is a string, so this is the
    // shape a real console submission has, not a convenience.
    const result = validateJobDraft(cron({ maxRunsPerDay: "6", maxTokensPerRun: " 900 " }));
    expect(result.ok && result.value.trigger).toMatchObject({
      maxRunsPerDay: 6,
      maxTokensPerRun: 900,
    });
  });

  test("a string that is not ALL digits is refused rather than parsed loosely", () => {
    // `parseInt` would read "20 runs" as 20 and `Number("")` is 0 —
    // neither is a number the operator typed.
    for (const bad of ["20 runs", "", " ", "1e3", "0x10", "-4", "2.5"]) {
      expect(rejection(cron({ maxRunsPerDay: bad }))).toContain("trigger.maxRunsPerDay");
    }
  });

  test("a boolean or object bound is refused", () => {
    expect(rejection(cron({ maxRunsPerDay: true }))).toContain("trigger.maxRunsPerDay is required");
    expect(rejection(cron({ maxTokensPerRun: {} }))).toContain(
      "trigger.maxTokensPerRun is required",
    );
  });
});

describe("validateJobDraft — the cron expression and its zone", () => {
  const withCron = (cron: unknown, timezone: unknown = "UTC"): Record<string, unknown> => ({
    name: "J",
    workflow: "docs-factory",
    trigger: { kind: "cron", cron, timezone, maxRunsPerDay: 4, maxTokensPerRun: 1000 },
  });

  test("a 5-field expression is accepted and trimmed", () => {
    const result = validateJobDraft(withCron("  0 3 * * 1  "));
    expect(result.ok && result.value.trigger).toMatchObject({ cron: "0 3 * * 1" });
  });

  test("a wrong field COUNT is refused, naming the count", () => {
    // 5 fields is the host's stated contract — its own validator's error
    // reads "expected 5 fields, got 4" — so checking it here cannot drift.
    expect(rejection(withCron("0 3 * *"))).toContain("must have 5 fields");
    expect(rejection(withCron("0 3 * * * *"))).toContain("must have 5 fields");
  });

  test("@shorthand is refused with the 5-field alternative spelled out", () => {
    expect(rejection(withCron("@daily"))).toContain("does not accept @shorthand");
  });

  test("a missing, blank or non-string expression is refused", () => {
    expect(rejection(withCron(undefined))).toContain("trigger.cron is required");
    expect(rejection(withCron("   "))).toContain("trigger.cron is required");
    expect(rejection(withCron(42))).toContain("trigger.cron is required");
  });

  test("an over-long expression is refused, not truncated", () => {
    expect(rejection(withCron(`0 3 * * ${"1,".repeat(MAX_CRON_LEN)}`))).toContain(
      `${MAX_CRON_LEN} characters or fewer`,
    );
  });

  test("SEMANTICS stay the host's — a sub-5-minute expression is NOT rejected here", () => {
    // Deliberate, and worth pinning so nobody "fixes" it into a second
    // opinion that can drift: `validateCron` (`src/extensions/cron.ts`)
    // owns field ranges, steps and the minimum interval, and
    // `ctx.triggers.register` reports its verdict verbatim on
    // `data.cronReason`. What bounds the damage in the meantime is
    // `maxRunsPerDay`, which is mandatory and capped — an every-minute
    // expression still cannot fire more than that.
    const result = validateJobDraft(withCron("* * * * *"));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.trigger).toMatchObject({ maxRunsPerDay: 4 });
  });

  test("a real IANA zone is accepted; an invented one is refused", () => {
    // The host does NOT check this: `triggers-handler.ts` only asserts
    // `typeof timezone === "string"` before handing it to `parseCron`,
    // which resolves it through `Intl` and THROWS on a bad zone. Asking
    // the same question here turns that into a field error.
    expect(validateJobDraft(withCron("0 3 * * *", "America/New_York")).ok).toBe(true);
    expect(validateJobDraft(withCron("0 3 * * *", "UTC")).ok).toBe(true);
    expect(rejection(withCron("0 3 * * *", "Mars/Olympus_Mons"))).toContain(
      "is not a time zone this runtime knows",
    );
    expect(rejection(withCron("0 3 * * *", "EST5EDT+bogus"))).toContain(
      "is not a time zone this runtime knows",
    );
  });

  test("a missing, blank or non-string zone is refused — never defaulted to the host's", () => {
    // The host WOULD default it, and that is exactly the problem: a
    // schedule whose meaning depends on the server's zone is a schedule
    // nobody chose.
    //
    // The ABSENT case is spelled out rather than routed through
    // `withCron`, whose default parameter would substitute "UTC" for an
    // explicit `undefined` and quietly test nothing.
    expect(
      rejection({
        name: "J",
        workflow: "docs-factory",
        trigger: { kind: "cron", cron: "0 3 * * *", maxRunsPerDay: 4, maxTokensPerRun: 1000 },
      }),
    ).toContain("trigger.timezone is required");
    expect(rejection(withCron("0 3 * * *", "  "))).toContain("trigger.timezone is required");
    expect(rejection(withCron("0 3 * * *", 7))).toContain("trigger.timezone is required");
  });

  test("an over-long zone is refused, not truncated", () => {
    expect(rejection(withCron("0 3 * * *", "A".repeat(MAX_TIMEZONE_LEN + 1)))).toContain(
      `${MAX_TIMEZONE_LEN} characters or fewer`,
    );
  });
});

describe("the background-trigger seams the fire path reads", () => {
  const cronTrigger = {
    kind: "cron",
    cron: "0 3 * * *",
    timezone: "UTC",
    maxRunsPerDay: 4,
    maxTokensPerRun: 50_000,
  } as const;

  test("isBackgroundTrigger is true for exactly cron and webhook", () => {
    // ONE predicate for "does this fire with nobody present". Three
    // hand-rolled `kind === "cron" || kind === "webhook"` checks across the
    // console, the fire path and the consent handoff is how one of them
    // ends up disagreeing the day a third background kind lands.
    expect(isBackgroundTrigger({ kind: "manual" })).toBe(false);
    expect(isBackgroundTrigger(cronTrigger)).toBe(true);
    expect(
      isBackgroundTrigger({ kind: "webhook", maxRunsPerDay: 1, maxTokensPerRun: 1 }),
    ).toBe(true);
    expect(isBackgroundTrigger({ kind: "event", event: "run:complete" })).toBe(false);
    expect(
      isBackgroundTrigger({ kind: "workflow", onWorkflow: "x", onStatus: ["success"] }),
    ).toBe(false);
  });

  test("BACKGROUND_TRIGGER_KINDS and isBackgroundTrigger agree", () => {
    // The list drives the console's `visibleWhen`; the predicate drives
    // the handlers. A disagreement would render bound fields for a kind
    // that carries none, or hide them from one that needs them.
    expect([...BACKGROUND_TRIGGER_KINDS]).toEqual(["cron", "webhook"]);
  });

  test("triggerBounds hands the delegation row its two NOT NULL columns", () => {
    // What the consent handoff prefills and the fire path enforces:
    // `workflow_delegations.max_runs_per_day` / `.max_tokens_per_run`.
    expect(triggerBounds(cronTrigger)).toEqual({ maxRunsPerDay: 4, maxTokensPerRun: 50_000 });
    expect(
      triggerBounds({ kind: "webhook", maxRunsPerDay: 9, maxTokensPerRun: 3 }),
    ).toEqual({ maxRunsPerDay: 9, maxTokensPerRun: 3 });
  });

  test("triggerBounds is null for every attended trigger", () => {
    // Not zero, not a default pair — `null` means "there is no delegation
    // here", which is a different statement from "the limits are 0".
    expect(triggerBounds({ kind: "manual" })).toBeNull();
    expect(triggerBounds({ kind: "event", event: "run:complete" })).toBeNull();
    expect(triggerBounds({ kind: "workflow", onWorkflow: "x", onStatus: [] })).toBeNull();
  });

  test("TRIGGER_ENVELOPE mirrors the manifest's permissions.triggers", () => {
    // Mirrored rather than imported (importing `../ezcorp.config` would
    // drag a `src/extensions/**` host module into the sandboxed bundle),
    // so this is the assertion that keeps the copy honest.
    expect(manifestTriggers.maxCron).toBe(TRIGGER_ENVELOPE.maxCron);
    expect(manifestTriggers.maxWebhooks).toBe(TRIGGER_ENVELOPE.maxWebhooks);
    expect(manifestTriggers.maxRunsPerDay).toBe(TRIGGER_ENVELOPE.maxRunsPerDay);
  });

  test("MAX_JOB_RUNS_PER_DAY is the host's own per-key derivation", () => {
    // `defaultPerKeyCap(envelope, maxCron)` = `max(1, floor(500 / 25))`.
    // Recomputed here from the mirrored envelope so a future envelope
    // change moves both together instead of stranding a literal.
    expect(MAX_JOB_RUNS_PER_DAY).toBe(
      Math.max(1, Math.floor(TRIGGER_ENVELOPE.maxRunsPerDay / TRIGGER_ENVELOPE.maxCron)),
    );
  });
});

describe("validateJobDraft — input", () => {
  test("input must be a plain object", () => {
    expect(rejection({ name: "J", workflow: "docs-factory", input: "globs" })).toBe(
      "input must be a plain object",
    );
    expect(rejection({ name: "J", workflow: "docs-factory", input: ["globs"] })).toBe(
      "input must be a plain object",
    );
    expect(rejection({ name: "J", workflow: "docs-factory", input: null })).toBe(
      "input must be a plain object",
    );
  });

  test("absent input becomes an empty object", () => {
    const result = validateJobDraft({ name: "J", workflow: "docs-factory" });
    expect(result.ok && result.value.input).toEqual({});
  });

  test("a value JSON would silently DROP is refused: undefined, functions, symbols, bigint", () => {
    const base = { name: "J", workflow: "docs-factory" };
    expect(rejection({ ...base, input: { globs: undefined } })).toContain("JSON silently drops");
    expect(rejection({ ...base, input: { globs: () => 1 } })).toContain("not JSON data");
    expect(rejection({ ...base, input: { globs: Symbol("x") } })).toContain("not JSON data");
    expect(rejection({ ...base, input: { globs: 1n } })).toContain("not JSON data");
  });

  test("a value JSON would silently COERCE is refused: NaN and Infinity", () => {
    const base = { name: "J", workflow: "docs-factory" };
    expect(rejection({ ...base, input: { globs: Number.NaN } })).toContain("turns into null");
    expect(rejection({ ...base, input: { globs: Number.POSITIVE_INFINITY } })).toContain(
      "turns into null",
    );
  });

  test("JSON-safe scalars, nulls, arrays and nested objects are accepted", () => {
    const result = validateJobDraft({
      name: "J",
      workflow: "docs-factory",
      input: { globs: ["a", 1, true, null, { nested: "ok" }], outPath: "out.md" },
    });
    expect(result.ok).toBe(true);
  });

  test(`input nested deeper than ${MAX_JOB_INPUT_DEPTH} levels is refused`, () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < MAX_JOB_INPUT_DEPTH + 1; i++) deep = { down: deep };
    const error = rejection({ name: "J", workflow: "docs-factory", input: { globs: deep } });
    expect(error).toContain(`nests deeper than ${MAX_JOB_INPUT_DEPTH}`);
  });

  test("a deep value inside an array is walked too", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < MAX_JOB_INPUT_DEPTH + 1; i++) deep = [deep];
    expect(rejection({ name: "J", workflow: "docs-factory", input: { globs: deep } })).toContain(
      "nests deeper than",
    );
  });

  test(`input serializing over ${MAX_JOB_INPUT_CHARS} characters is refused, not truncated`, () => {
    // Mirrors the host's MAX_WORKFLOW_INPUT_BYTES so the operator sees a
    // clear refusal here rather than a -32602 at fire time.
    const error = rejection({
      name: "J",
      workflow: "docs-factory",
      input: { globs: "x".repeat(MAX_JOB_INPUT_CHARS + 1) },
    });
    expect(error).toContain("input too large");
    expect(error).toContain(String(MAX_JOB_INPUT_CHARS));
  });
});

// ── diffJob ─────────────────────────────────────────────────────────

describe("diffJob", () => {
  test("reports only changed editable fields, from → to", () => {
    const before = job({ name: "A", input: { globs: "x" } });
    const after = job({ name: "B", input: { globs: "x" }, enabled: false });
    expect(diffJob(before, after)).toEqual({
      name: { from: "A", to: "B" },
      enabled: { from: true, to: false },
    });
  });

  test("an identical job diffs to nothing, and ids/timestamps are never reported", () => {
    const before = job();
    const after = job({ id: "j2", updatedAt: "2026-09-09T00:00:00.000Z", updatedBy: "user-2" });
    expect(diffJob(before, after)).toEqual({});
  });
});

// ── Ids ─────────────────────────────────────────────────────────────

describe("job ids", () => {
  test("the grammar excludes ':' — an id is spliced into a storage key", () => {
    expect(isValidJobId("j1")).toBe(true);
    expect(isValidJobId("a-b_c")).toBe(true);
    expect(isValidJobId("job:other")).toBe(false);
    expect(isValidJobId("-leading")).toBe(false);
    expect(isValidJobId("with/slash")).toBe(false);
    expect(isValidJobId("")).toBe(false);
    expect(isValidJobId("x".repeat(65))).toBe(false);
    expect(isValidJobId(7)).toBe(false);
  });

  test("newJobId mints an id the grammar accepts", () => {
    const id = newJobId();
    expect(JOB_ID_RE.test(id)).toBe(true);
    expect(newJobId()).not.toBe(id);
  });

  test("the page-action id reader lives in lib/page.ts, keyed on the real field", () => {
    // `parseJobIdPayload` used to live here and read `payload.jobId` — a
    // key no page action carries, because a form field id must match the
    // host's lowercase slug rule and the console's is `job_id`. It had no
    // production caller, and the day one arrived it refused every click
    // in silence. The reader now sits beside the field-id constant it
    // must agree with, and this asserts the PAIRING rather than keeping a
    // second copy of the charset rule.
    expect(jobIdFromActionPayload({ [JOB_FORM_FIELDS.jobId]: " j1 " })).toBe("j1");
    // The exact mistake, pinned: the camelCase key is not the wire key.
    expect(jobIdFromActionPayload({ jobId: "j1" })).toBeNull();
    expect(jobIdFromActionPayload({ [JOB_FORM_FIELDS.jobId]: "job:other" })).toBeNull();
    expect(jobIdFromActionPayload({ [JOB_FORM_FIELDS.jobId]: "  " })).toBeNull();
    expect(jobIdFromActionPayload({ [JOB_FORM_FIELDS.jobId]: 7 })).toBeNull();
    expect(jobIdFromActionPayload({})).toBeNull();
    expect(jobIdFromActionPayload(null)).toBeNull();
    expect(jobIdFromActionPayload([])).toBeNull();
    expect(jobIdFromActionPayload("j1")).toBeNull();
  });
});

// ── Store ───────────────────────────────────────────────────────────

describe("createJobStore — jobs", () => {
  beforeEach(() => __resetChannelForTests());
  afterEach(() => __resetChannelForTests());

  test("writes to the global scope — jobs are install-wide", async () => {
    const { calls } = stubStorage();
    expect(JOB_STORAGE_SCOPE).toBe("global");
    await createJobStore().createJob(draft(), { id: "j1", ...OPTS });
    expect(calls.length).toBeGreaterThan(0);
  });

  test("create → get → list round-trips, stamping attribution and the C3 placeholders", async () => {
    stubStorage();
    const store = createJobStore();
    const created = await store.createJob(draft({ description: "d", input: { globs: "**/*.ts" } }), {
      id: "j1",
      ...OPTS,
    });
    expect(created.ok).toBe(true);
    expect(created.ok && created.value).toMatchObject({
      id: "j1",
      description: "d",
      input: { globs: "**/*.ts" },
      // Written, never acted on: the host attributes from the calling
      // identity, and consent hashing is C3 (unbuilt).
      runAs: { kind: "user", id: "user-1" },
      consentHash: null,
      createdBy: "user-1",
      updatedBy: "user-1",
    });
    expect((await store.getJob("j1"))?.id).toBe("j1");
    expect((await store.listJobs()).map((j) => j.id)).toEqual(["j1"]);
  });

  test("an invalid id is refused before it can forge a storage key", async () => {
    stubStorage();
    const store = createJobStore();
    const result = await store.createJob(draft(), { id: "j1:evil", ...OPTS });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("invalid job id");
    expect(await store.listJobs()).toEqual([]);
  });

  test("a duplicate id is refused and does not overwrite the existing job", async () => {
    const { calls } = stubStorage();
    const store = createJobStore();
    await store.createJob(draft({ name: "First" }), { id: "j1", ...OPTS });
    const before = calls.filter((c) => c.action === "set").length;
    const dup = await store.createJob(draft({ name: "Second" }), { id: "j1", ...OPTS });
    expect(dup.ok).toBe(false);
    expect(dup.ok === false && dup.error).toContain("already exists");
    expect((await store.getJob("j1"))?.name).toBe("First");
    // …and it spent no write at all: an unchanged edit skips the round trip.
    expect(calls.filter((c) => c.action === "set").length).toBe(before);
  });

  test("getJob refuses an illegal id and returns null for a missing one", async () => {
    stubStorage();
    const store = createJobStore();
    expect(await store.getJob("j1:evil")).toBeNull();
    expect(await store.getJob("missing")).toBeNull();
  });

  test("listJobs skips an index entry whose blob is gone", async () => {
    const { mem } = stubStorage();
    const store = createJobStore();
    await store.createJob(draft(), { id: "j1", ...OPTS });
    await store.createJob(draft(), { id: "j2", ...OPTS });
    mem.delete("job:j1");
    expect((await store.listJobs()).map((j) => j.id)).toEqual(["j2"]);
  });

  test("saveJob replaces the editable fields and restamps updatedBy/updatedAt", async () => {
    stubStorage();
    const store = createJobStore();
    await store.createJob(draft({ name: "Old", input: { globs: "a" } }), { id: "j1", ...OPTS });
    const saved = await store.saveJob(
      "j1",
      draft({ name: "New", workflow: "etl-factory", input: { outPath: "out.md" } }),
      { actor: "user-2", now: "2026-08-02T00:00:00.000Z" },
    );
    expect(saved).toMatchObject({
      name: "New",
      workflow: "etl-factory",
      input: { outPath: "out.md" },
      updatedBy: "user-2",
      updatedAt: "2026-08-02T00:00:00.000Z",
      // Creation attribution is never rewritten by an edit.
      createdBy: "user-1",
      createdAt: OPTS.now,
    });
  });

  test("saveJob returns null for a missing job and for an illegal id", async () => {
    stubStorage();
    const store = createJobStore();
    expect(await store.saveJob("missing", draft(), OPTS)).toBeNull();
    expect(await store.saveJob("j1:evil", draft(), OPTS)).toBeNull();
  });

  test("setEnabled flips the flag and restamps; missing job → null", async () => {
    stubStorage();
    const store = createJobStore();
    await store.createJob(draft(), { id: "j1", ...OPTS });
    const off = await store.setEnabled("j1", false, { actor: "user-2", now: "2026-08-03T00:00:00.000Z" });
    expect(off).toMatchObject({ enabled: false, updatedBy: "user-2" });
    expect(await store.setEnabled("missing", false, OPTS)).toBeNull();
  });

  test("touchJob reaches the two bookkeeping fields and nothing else", async () => {
    stubStorage();
    const store = createJobStore();
    await store.createJob(draft({ name: "Docs" }), { id: "j1", ...OPTS });
    const withRun = await store.touchJob("j1", {
      lastRunAt: "2026-08-04T00:00:00.000Z",
      lastWorkflowRunId: "run-9",
    });
    expect(withRun).toMatchObject({
      lastRunAt: "2026-08-04T00:00:00.000Z",
      lastWorkflowRunId: "run-9",
      // A fire is not an edit: the audit trail must not claim someone
      // changed the job.
      name: "Docs",
      updatedBy: "user-1",
      updatedAt: OPTS.now,
    });
    const withoutRun = await store.touchJob("j1", { lastRunAt: "2026-08-05T00:00:00.000Z" });
    expect(withoutRun?.lastWorkflowRunId).toBe("run-9");
    expect(await store.touchJob("missing", { lastRunAt: OPTS.now })).toBeNull();
  });

  test("noteFire reaches ONE field, and a success replaces a previous refusal", async () => {
    // The field an operator reads when an unattended job stops. It has to
    // be as narrow as `touchJob` — a second wide write path around the
    // validator is the exact defect `ValidatedJobDraft` exists to prevent.
    stubStorage();
    const store = createJobStore();
    await store.createJob(draft({ name: "Docs" }), { id: "j1", ...OPTS });

    const refused = await store.noteFire("j1", {
      at: "2026-08-04T00:00:00.000Z",
      ok: false,
      reason: "DELEGATION_CONSENT_STALE",
      kind: "consent",
      remedy: "Consent again.",
    });
    expect(refused).toMatchObject({
      lastFire: {
        at: "2026-08-04T00:00:00.000Z",
        ok: false,
        reason: "DELEGATION_CONSENT_STALE",
        kind: "consent",
      },
      // A fire is not an edit.
      name: "Docs",
      updatedBy: "user-1",
      updatedAt: OPTS.now,
    });

    // The question this field answers is "is this job firing right now",
    // not "has it ever failed" — the history belongs to the audit trail.
    const recovered = await store.noteFire("j1", { at: "2026-08-05T00:00:00.000Z", ok: true });
    expect(recovered?.lastFire).toEqual({ at: "2026-08-05T00:00:00.000Z", ok: true });

    expect(await store.noteFire("missing", { at: OPTS.now, ok: true })).toBeNull();
  });

  test("deleteJob removes the blob, the index entry and every run record", async () => {
    const { mem } = stubStorage();
    const store = createJobStore();
    await store.createJob(draft(), { id: "j1", ...OPTS });
    await store.recordRun(runRecord({ workflowRunId: "run-1" }));
    await store.recordRun(runRecord({ workflowRunId: "run-2" }));
    expect(await store.deleteJob("j1")).toBe(true);
    expect(await store.getJob("j1")).toBeNull();
    expect(await store.listJobs()).toEqual([]);
    expect([...mem.keys()].filter((k) => k.startsWith("run"))).toEqual([]);
  });

  test("deleteJob tolerates a run index entry whose blob is already gone", async () => {
    const { mem } = stubStorage();
    const store = createJobStore();
    await store.createJob(draft(), { id: "j1", ...OPTS });
    await store.recordRun(runRecord({ workflowRunId: "run-1" }));
    mem.delete("run:j1:run-1");
    expect(await store.deleteJob("j1")).toBe(true);
    expect(mem.has("run-index:j1")).toBe(false);
  });

  test("deleteJob is false for a missing job and for an illegal id", async () => {
    stubStorage();
    const store = createJobStore();
    expect(await store.deleteJob("missing")).toBe(false);
    expect(await store.deleteJob("j1:evil")).toBe(false);
  });
});

describe("createJobStore — run records", () => {
  beforeEach(() => __resetChannelForTests());
  afterEach(() => __resetChannelForTests());

  test("records a run and lists it back", async () => {
    stubStorage();
    const store = createJobStore();
    const result = await store.recordRun(runRecord());
    expect(result.ok).toBe(true);
    expect((await store.listRuns("j1")).map((r) => r.workflowRunId)).toEqual(["run-1"]);
  });

  test("re-recording the same run updates in place and keeps one index entry", async () => {
    stubStorage();
    const store = createJobStore();
    await store.recordRun(runRecord({ status: "running" }));
    await store.recordRun(runRecord({ status: "success", finishedAt: "2026-08-01T01:00:00.000Z" }));
    const runs = await store.listRuns("j1");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("success");
  });

  test("newest first", async () => {
    stubStorage();
    const store = createJobStore();
    await store.recordRun(runRecord({ workflowRunId: "run-1" }));
    await store.recordRun(runRecord({ workflowRunId: "run-2" }));
    expect((await store.listRuns("j1")).map((r) => r.workflowRunId)).toEqual(["run-2", "run-1"]);
  });

  test(`the index is capped at ${MAX_RUNS_PER_JOB} and the evicted run blobs are deleted`, async () => {
    const { mem } = stubStorage();
    const store = createJobStore();
    for (let i = 0; i < MAX_RUNS_PER_JOB + 3; i++) {
      await store.recordRun(runRecord({ workflowRunId: `run-${i}` }));
    }
    const runs = await store.listRuns("j1");
    expect(runs).toHaveLength(MAX_RUNS_PER_JOB);
    expect(runs[0]?.workflowRunId).toBe(`run-${MAX_RUNS_PER_JOB + 2}`);
    // A capped index over uncapped blobs would leak storage forever.
    expect(mem.has("run:j1:run-0")).toBe(false);
    expect([...mem.keys()].filter((k) => k.startsWith("run:j1:"))).toHaveLength(MAX_RUNS_PER_JOB);
  });

  test("an illegal job id or run id is refused before it can forge a key", async () => {
    stubStorage();
    const store = createJobStore();
    const badJob = await store.recordRun(runRecord({ jobId: "j1:evil" }));
    expect(badJob.ok).toBe(false);
    expect(badJob.ok === false && badJob.error).toContain("invalid run record ids");
    const badRun = await store.recordRun(runRecord({ workflowRunId: "run:evil" }));
    expect(badRun.ok).toBe(false);
  });

  test("listRuns honours an explicit limit, refuses an illegal id, and skips a missing blob", async () => {
    const { mem } = stubStorage();
    const store = createJobStore();
    await store.recordRun(runRecord({ workflowRunId: "run-1" }));
    await store.recordRun(runRecord({ workflowRunId: "run-2" }));
    expect(await store.listRuns("j1", 1)).toHaveLength(1);
    expect(await store.listRuns("j1:evil")).toEqual([]);
    mem.delete("run:j1:run-2");
    expect((await store.listRuns("j1")).map((r) => r.workflowRunId)).toEqual(["run-1"]);
  });
});

describe("createJobStore — store meta", () => {
  beforeEach(() => __resetChannelForTests());
  afterEach(() => __resetChannelForTests());

  test("readMeta is null before anything is stamped", async () => {
    stubStorage();
    expect(await createJobStore().readMeta()).toBeNull();
  });

  test("ensureMeta stamps the current version on first use and is idempotent after", async () => {
    const { calls } = stubStorage();
    const store = createJobStore();
    const first = await store.ensureMeta(OPTS.now);
    expect(first).toEqual({
      ok: true,
      value: { version: JOB_STORE_VERSION, migratedAt: OPTS.now },
    });
    const writes = calls.filter((c) => c.action === "set" && c.key === "meta").length;
    const second = await store.ensureMeta("2026-09-09T00:00:00.000Z");
    expect(second.ok && second.value.migratedAt).toBe(OPTS.now);
    // Idempotent means it does not rewrite, not just that it returns the same
    // thing — a rewrite would move migratedAt every boot.
    expect(calls.filter((c) => c.action === "set" && c.key === "meta").length).toBe(writes);
  });

  test("a malformed meta row is treated as absent and restamped", async () => {
    const { mem } = stubStorage();
    const store = createJobStore();
    mem.set("meta", { version: "one" });
    expect(await store.readMeta()).toBeNull();
    const result = await store.ensureMeta(OPTS.now);
    expect(result.ok && result.value.version).toBe(JOB_STORE_VERSION);
  });

  test("FAILS CLOSED against a layout written by a newer build", async () => {
    const { mem, calls } = stubStorage();
    const store = createJobStore();
    mem.set("meta", { version: JOB_STORE_VERSION + 1, migratedAt: OPTS.now });
    const result = await store.ensureMeta(OPTS.now);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(`version ${JOB_STORE_VERSION + 1}`);
    // A v1 writer loose in a v2 key space corrupts exactly what the marker
    // exists to protect, so it must not write.
    expect(calls.filter((c) => c.action === "set" && c.key === "meta")).toEqual([]);
    expect((await store.readMeta())?.version).toBe(JOB_STORE_VERSION + 1);
  });
});

// ── Concurrency — the lost update `withLock` exists to prevent ───────

describe("concurrent writes", () => {
  beforeEach(() => __resetChannelForTests());
  afterEach(() => __resetChannelForTests());

  test("two concurrent creates both survive in job-index (no lost update)", async () => {
    // The failure this pins: the channel dispatches inbound frames
    // fire-and-forget, so two creates interleave, both read the same index,
    // and the second `set` discards the first's entry. Symptom is a job that
    // silently vanishes from the list, never an error.
    //
    // The 1ms `get` delay is what makes the window real — with an instantly
    // resolving stub the two calls never overlap and the test would pass
    // with the lock removed.
    stubStorage(1);
    const store = createJobStore();
    const results = await Promise.all([
      store.createJob(draft({ name: "A" }), { id: "ja", ...OPTS }),
      store.createJob(draft({ name: "B" }), { id: "jb", ...OPTS }),
      store.createJob(draft({ name: "C" }), { id: "jc", ...OPTS }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await store.listJobs()).map((j) => j.id).sort()).toEqual(["ja", "jb", "jc"]);
  });

  test("concurrent deletes leave the index consistent", async () => {
    stubStorage(1);
    const store = createJobStore();
    for (const id of ["ja", "jb", "jc"]) {
      await store.createJob(draft(), { id, ...OPTS });
    }
    await Promise.all([store.deleteJob("ja"), store.deleteJob("jb")]);
    expect((await store.listJobs()).map((j) => j.id)).toEqual(["jc"]);
  });

  test("concurrent run records all reach the run index", async () => {
    stubStorage(1);
    const store = createJobStore();
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => store.recordRun(runRecord({ workflowRunId: `run-${n}` }))),
    );
    expect((await store.listRuns("j1")).map((r) => r.workflowRunId).sort()).toEqual([
      "run-1",
      "run-2",
      "run-3",
      "run-4",
      "run-5",
    ]);
  });

  test("concurrent edits to the SAME job do not lose one another's write", async () => {
    stubStorage(1);
    const store = createJobStore();
    await store.createJob(draft(), { id: "j1", ...OPTS });
    await Promise.all([
      store.setEnabled("j1", false, OPTS),
      store.touchJob("j1", { lastRunAt: "2026-08-06T00:00:00.000Z" }),
    ]);
    const after = await store.getJob("j1");
    // Both mutations are visible. Unlocked, whichever read first would win
    // and the other field would silently revert to its pre-read value.
    expect(after?.enabled).toBe(false);
    expect(after?.lastRunAt).toBe("2026-08-06T00:00:00.000Z");
  });
});

// ── Structural: no `storage.set` outside a `withLock` ────────────────

describe("write-path discipline (source assertion)", () => {
  test("every storage mutation lives in the single `rmw` critical section", async () => {
    // A convention that looks like a boundary is worse than an acknowledged
    // convention. This asserts the boundary is structural: `rmw` is the only
    // function that mutates storage, and its body is a `withLock`. Adding a
    // second `storage.set` anywhere — inside a lock or not — fails here and
    // forces the author to say why.
    const source = await Bun.file(new URL("./jobs.ts", import.meta.url)).text();

    const setCalls = source.match(/storage\.set\(/g) ?? [];
    const deleteCalls = source.match(/storage\.delete\(/g) ?? [];
    expect(setCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(1);

    // Locate `rmw`'s body: from its signature to the first line that closes a
    // declaration at function-body indent.
    const start = source.indexOf("async function rmw<T>(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  }\n", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    expect(body).toContain("return withLock(lockName(key)");
    expect(body).toContain("storage.set(");
    expect(body).toContain("storage.delete(");
    // Non-vacuity: the slice is the function, not the whole file.
    expect(body.length).toBeLessThan(source.length / 2);
  });

  test("every lock name goes through the namespacing helper", async () => {
    // `withLock` keys are process-global across every module the extension
    // loads, so a bare `"meta"` would serialize against an unrelated
    // module's `"meta"`. Every call site must go through `lockName`.
    const source = await Bun.file(new URL("./jobs.ts", import.meta.url)).text();
    expect(source).toContain("ez-factory:jobs:");
    expect(source.match(/withLock\(/g) ?? []).toHaveLength(1);
    expect(source).toContain("withLock(lockName(key)");
  });
});

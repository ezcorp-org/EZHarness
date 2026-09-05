// ── lib/triggers.ts — the pure half of the unattended fire path ──────
//
// Everything here is a function over data, so every test is data in and
// data out. The WIRING these functions describe is proven end to end by
// `extensions/ez-factory/__tests__/unattended-fire-e2e.test.ts`, which
// drives a real cron tick to a completed `workflow_runs` row; this file
// pins the rules that file exercises so a rule change fails by name rather
// than as one line of an integration assertion.

import { describe, expect, test } from "bun:test";

import type { FactoryJob, JobTrigger } from "./jobs";
import { BACKGROUND_TRIGGER_KINDS } from "./jobs";
import {
  ALL_BACKGROUND_KINDS,
  describeFireRefusal,
  desiredRegistration,
  FIRE_REFUSAL_TABLE,
  fireRefusalReason,
  fireStateLabel,
  HOST_TRIGGER_KEY_RE,
  jobIdFromTriggerKey,
  LOCAL_REFUSAL,
  TRIGGER_KEY_PREFIX,
  triggerKeyForJob,
  triggerPlan,
  UNKNOWN_REFUSAL_REMEDY,
  UNTYPED_REFUSAL_REASON,
  type JobFireOutcome,
} from "./triggers";

const CRON: JobTrigger = {
  kind: "cron",
  cron: "0 3 * * *",
  timezone: "UTC",
  maxRunsPerDay: 5,
  maxTokensPerRun: 1000,
};
const HOOK: JobTrigger = { kind: "webhook", maxRunsPerDay: 5, maxTokensPerRun: 1000 };
const MANUAL: JobTrigger = { kind: "manual" };

function job(overrides: Partial<FactoryJob> = {}): FactoryJob {
  return {
    id: "8f1d0a6c-1111-4222-8333-444444444444",
    name: "n",
    description: "",
    workflow: "etl-factory",
    input: {},
    trigger: CRON,
    enabled: true,
    runAs: { kind: "user", id: "u1" },
    consentHash: null,
    createdBy: "u1",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedBy: "u1",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("the trigger key", () => {
  test("a job id becomes a prefixed, host-legal key", () => {
    const key = triggerKeyForJob("8f1d0a6c-1111-4222-8333-444444444444");
    expect(key).toBe(`${TRIGGER_KEY_PREFIX}8f1d0a6c-1111-4222-8333-444444444444`);
    expect(HOST_TRIGGER_KEY_RE.test(key!)).toBe(true);
    // 40 characters — comfortably inside the host's 64.
    expect(key!.length).toBeLessThanOrEqual(64);
  });


  test("an UPPERCASE job id is refused rather than lowercased", () => {
    // `isValidJobId` accepts `[A-Za-z0-9]`; the host's key charset does
    // not. Every id this console mints is a lowercase UUID, so this arm
    // only ever sees an id written by something else — and a silently
    // lowercased key would register a row dispatching to an id that does
    // not exist.
    expect(triggerKeyForJob("Nightly")).toBeNull();
  });

  test("an id the store itself would reject makes no key", () => {
    expect(triggerKeyForJob("has spaces")).toBeNull();
    expect(triggerKeyForJob("")).toBeNull();
    expect(triggerKeyForJob(`${"a".repeat(65)}`)).toBeNull();
  });

  test("the inverse reads a fired key back to its job", () => {
    expect(jobIdFromTriggerKey("job:abc-123")).toBe("abc-123");
  });

  test("the inverse fails CLOSED on everything else", () => {
    expect(jobIdFromTriggerKey("abc-123")).toBeNull();
    expect(jobIdFromTriggerKey("job:has spaces")).toBeNull();
    expect(jobIdFromTriggerKey("job:")).toBeNull();
    expect(jobIdFromTriggerKey(42)).toBeNull();
    expect(jobIdFromTriggerKey(undefined)).toBeNull();
    expect(jobIdFromTriggerKey(null)).toBeNull();
  });

  test("key → job → key round-trips", () => {
    const id = "8f1d0a6c-1111-4222-8333-444444444444";
    expect(jobIdFromTriggerKey(triggerKeyForJob(id)!)).toBe(id);
  });
});

describe("what a saved job wants the host to hold", () => {
  test("an enabled cron job wants a cron row carrying its expression and zone", () => {
    expect(desiredRegistration(job())).toEqual({
      kind: "cron",
      key: triggerKeyForJob(job().id)!,
      cron: "0 3 * * *",
      timezone: "UTC",
    });
  });

  test("an enabled webhook job wants a row that names NOTHING it could steer", () => {
    // No slug field, because the host mints the slug from its own prefix
    // and a digest of the extension name — forgery is inexpressible rather
    // than denied.
    expect(desiredRegistration(job({ trigger: HOOK }))).toEqual({
      kind: "webhook",
      key: triggerKeyForJob(job().id)!,
    });
  });

  test("a MANUAL job wants none", () => {
    expect(desiredRegistration(job({ trigger: MANUAL }))).toBeNull();
  });

  test("a DISABLED job wants none — retiring has to mean something", () => {
    expect(desiredRegistration(job({ enabled: false }))).toBeNull();
  });

  test("a job whose id cannot make a key wants none", () => {
    expect(desiredRegistration(job({ id: "Uppercase" }))).toBeNull();
  });

  test("a kind this build does not dispatch wants none", () => {
    const future = { kind: "event", event: "x" } as JobTrigger;
    expect(desiredRegistration(job({ trigger: future }))).toBeNull();
  });
});

describe("the save plan", () => {
  test("a CREATE registers and retires nothing", () => {
    expect(triggerPlan(job(), null)).toEqual({
      register: desiredRegistration(job()),
      unregister: [],
    });
  });

  test("cron → webhook retires the cron row and registers the hook", () => {
    const plan = triggerPlan(job({ trigger: HOOK }), CRON);
    expect(plan.register?.kind).toBe("webhook");
    expect(plan.unregister).toEqual(["cron"]);
  });

  test("cron → cron is an in-place UPDATE, not a retire-and-recreate", () => {
    // Re-registering a key updates the row host-side — same row, same
    // slug, same secret. Retiring first would destroy a webhook's secret
    // on every save, invalidating a token the user already wired up.
    const plan = triggerPlan(job(), CRON);
    expect(plan.register?.kind).toBe("cron");
    expect(plan.unregister).toEqual([]);
  });

  test("background → manual retires and registers nothing", () => {
    expect(triggerPlan(job({ trigger: MANUAL }), CRON)).toEqual({
      register: null,
      unregister: ["cron"],
    });
  });

  test("DISABLING a background job retires its row", () => {
    expect(triggerPlan(job({ enabled: false }), CRON)).toEqual({
      register: null,
      unregister: ["cron"],
    });
  });

  test("manual → manual touches nothing at all", () => {
    expect(triggerPlan(job({ trigger: MANUAL }), MANUAL)).toEqual({
      register: null,
      unregister: [],
    });
  });

  test("the every-kind list mirrors the store's", () => {
    expect([...ALL_BACKGROUND_KINDS]).toEqual([...BACKGROUND_TRIGGER_KINDS]);
  });
});

describe("classifying a refusal — the legibility control", () => {
  test("a stale consent is a CONSENT problem with a re-consent remedy", () => {
    const refusal = describeFireRefusal("DELEGATION_CONSENT_STALE");
    expect(refusal.kind).toBe("consent");
    expect(refusal.remedy).toContain("PARKED");
    expect(refusal.remedy).toContain("consent again");
  });

  test("a daily cap is a QUOTA, and says nothing is broken", () => {
    const refusal = describeFireRefusal("DELEGATION_QUOTA_EXCEEDED");
    expect(refusal.kind).toBe("quota");
    expect(refusal.remedy).toContain("Nothing is broken");
  });

  test("the instance-wide kill switch is a PLATFORM state, not this job's fault", () => {
    const refusal = describeFireRefusal("DELEGATION_DISABLED");
    expect(refusal.kind).toBe("platform");
    expect(refusal.remedy).toContain("Nothing about this job changed");
  });

  test("a missing grant is an INSTALL problem", () => {
    expect(describeFireRefusal("DELEGATION_NOT_GRANTED").kind).toBe("install");
    expect(describeFireRefusal("WORKFLOWS_NOT_GRANTED").kind).toBe("install");
  });

  test("every LOCAL refusal this console can make is classified", () => {
    for (const reason of Object.values(LOCAL_REFUSAL)) {
      const refusal = describeFireRefusal(reason);
      expect(refusal.kind).toBe("job");
      expect(refusal.remedy.length).toBeGreaterThan(0);
    }
  });

  test("an UNKNOWN code is carried verbatim, never silently re-labelled", () => {
    // A host that grows a deny code must say so rather than being folded
    // into a neighbouring bucket whose remedy would be wrong.
    const refusal = describeFireRefusal("DELEGATION_SOMETHING_NEW");
    expect(refusal.reason).toBe("DELEGATION_SOMETHING_NEW");
    expect(refusal.kind).toBe("unknown");
    expect(refusal.remedy).toBe(UNKNOWN_REFUSAL_REMEDY);
  });

  test("no table entry is missing a remedy, and none repeats another's", () => {
    const remedies = Object.values(FIRE_REFUSAL_TABLE).map((e) => e.remedy);
    expect(remedies.every((r) => r.length > 20)).toBe(true);
    expect(new Set(remedies).size).toBe(remedies.length);
  });

});

describe("reading the reason off a thrown host error", () => {
  test("the typed data.reason wins", () => {
    expect(fireRefusalReason({ data: { reason: "DELEGATION_NOT_FOUND" } })).toBe(
      "DELEGATION_NOT_FOUND",
    );
  });

  test("a throw with no typed reason gets a stable synthetic one", () => {
    // Never the MESSAGE: prose moves between builds and a trail keyed on
    // it cannot be aggregated.
    expect(fireRefusalReason(new Error("something went wrong"))).toBe(
      UNTYPED_REFUSAL_REASON,
    );
    expect(fireRefusalReason({ data: {} })).toBe(UNTYPED_REFUSAL_REASON);
    expect(fireRefusalReason({ data: { reason: 7 } })).toBe(UNTYPED_REFUSAL_REASON);
    expect(fireRefusalReason({ data: { reason: "" } })).toBe(UNTYPED_REFUSAL_REASON);
    expect(fireRefusalReason({ data: null })).toBe(UNTYPED_REFUSAL_REASON);
    expect(fireRefusalReason(null)).toBe(UNTYPED_REFUSAL_REASON);
    expect(fireRefusalReason(undefined)).toBe(UNTYPED_REFUSAL_REASON);
    expect(fireRefusalReason("a bare string")).toBe(UNTYPED_REFUSAL_REASON);
  });

  test("the synthetic reason is itself classifiable, so nothing falls off the end", () => {
    expect(describeFireRefusal(UNTYPED_REFUSAL_REASON).kind).toBe("unknown");
  });
});

describe("the console's one-line fire state", () => {
  const at = "2026-08-05T00:00:00.000Z";

  test("a job that has never fired unattended has no state to show", () => {
    expect(fireStateLabel(undefined)).toBeNull();
  });

  test("a job that fired cleanly has none either", () => {
    expect(fireStateLabel({ at, ok: true })).toBeNull();
  });

  test("each refusal kind reads differently — that IS the requirement", () => {
    const labels = (["consent", "quota", "platform", "install", "job"] as const).map(
      (kind) => fireStateLabel({ at, ok: false, kind } as JobFireOutcome),
    );
    expect(labels).toEqual([
      "consent stale — re-authorize",
      "paused by a limit",
      "platform paused",
      "needs an install fix",
      "refused by this console",
    ]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("an unclassified refusal still says SOMETHING rather than nothing", () => {
    expect(fireStateLabel({ at, ok: false, kind: "unknown" })).toBe("last fire refused");
    expect(fireStateLabel({ at, ok: false })).toBe("last fire refused");
  });
});

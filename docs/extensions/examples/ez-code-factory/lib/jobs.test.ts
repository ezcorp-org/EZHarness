import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { __resetChannelForTests, getChannel } from "@ezcorp/sdk/runtime";
import type { HostChannel } from "@ezcorp/sdk/runtime";
import {
  branchPatternValid,
  matchBranch,
  matchPushJob,
  isScheduleJobDue,
  shouldSynthesizeRun,
  validateJobDraft,
  diffJob,
  createJobStore,
  buildDefaultJob,
  loadJobsWithDefault,
  DEFAULT_JOB_ID,
  MAX_JOB_NAME_LEN,
  MAX_BRANCH_PATTERN_LEN,
  type Job,
  type JobTrigger,
} from "./jobs";
import { createAuditLog, type AuditEntry } from "./audit";

function job(over: Partial<Job> = {}): Job {
  return {
    id: over.id ?? "j1",
    name: over.name ?? "Job",
    trigger: over.trigger ?? { kind: "push", branchPattern: "*" },
    enabled: over.enabled ?? true,
    skipSteps: over.skipSteps ?? [],
    createdBy: "system",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedBy: "system",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...over,
  };
}

// ── Branch patterns ─────────────────────────────────────────────────

describe("branchPatternValid + matchBranch", () => {
  test("literal + single trailing glob are valid; interior/leading glob, regex, traversal are not", () => {
    expect(branchPatternValid("main")).toBe(true);
    expect(branchPatternValid("feature/*")).toBe(true);
    expect(branchPatternValid("*")).toBe(true);
    expect(branchPatternValid("release/1.2.3")).toBe(true);
    expect(branchPatternValid("fe*ature")).toBe(false);
    expect(branchPatternValid("*main")).toBe(false);
    expect(branchPatternValid("^main$")).toBe(false);
    expect(branchPatternValid("../etc")).toBe(false);
    expect(branchPatternValid("")).toBe(false);
    expect(branchPatternValid("x".repeat(MAX_BRANCH_PATTERN_LEN + 1))).toBe(false);
  });

  test("matchBranch: exact + trailing-glob prefix", () => {
    expect(matchBranch("main", "main")).toBe(true);
    expect(matchBranch("main", "maintenance")).toBe(false);
    expect(matchBranch("feature/*", "feature/x")).toBe(true);
    expect(matchBranch("feature/*", "hotfix/x")).toBe(false);
    expect(matchBranch("*", "anything")).toBe(true);
  });
});

describe("matchPushJob", () => {
  const exact = job({ id: "exact", trigger: { kind: "push", branchPattern: "main" } });
  const glob = job({ id: "glob", trigger: { kind: "push", branchPattern: "feature/*" } });
  const def = job({ id: DEFAULT_JOB_ID, trigger: { kind: "push", branchPattern: "*" } });

  test("exact beats glob beats default catch-all", () => {
    expect(matchPushJob([def, glob, exact], "main")!.id).toBe("exact");
    expect(matchPushJob([def, glob, exact], "feature/x")!.id).toBe("glob");
    expect(matchPushJob([def, glob, exact], "random")!.id).toBe(DEFAULT_JOB_ID);
  });

  test("disabled jobs are skipped; no match → null", () => {
    const disabledExact = job({ id: "exact", enabled: false, trigger: { kind: "push", branchPattern: "main" } });
    // Disabled exact ignored → falls through to the catch-all.
    expect(matchPushJob([def, disabledExact], "main")!.id).toBe(DEFAULT_JOB_ID);
    // Only a non-matching enabled job + no default → null (push-ignored).
    expect(matchPushJob([glob], "main")).toBeNull();
  });

  test("schedule/manual jobs never match a push", () => {
    const sched = job({ id: "s", trigger: { kind: "schedule", every: "daily", branch: "main" } });
    const manual = job({ id: "m", trigger: { kind: "manual", branch: "main" } });
    expect(matchPushJob([sched, manual], "main")).toBeNull();
  });
});

describe("isScheduleJobDue", () => {
  const now = new Date("2026-07-21T13:15:00.000Z");
  test("15m is due every tick", () => {
    const j = job({ trigger: { kind: "schedule", every: "15m", branch: "main" } });
    expect(isScheduleJobDue(j, now, new Date("2026-07-21T13:00:00.000Z"))).toBe(true);
    expect(isScheduleJobDue(j, now, null)).toBe(true);
  });
  test("hourly is due on the first tick of a new hour only", () => {
    const j = job({ trigger: { kind: "schedule", every: "hourly", branch: "main" } });
    expect(isScheduleJobDue(j, now, null)).toBe(true);
    expect(isScheduleJobDue(j, now, new Date("2026-07-21T12:45:00.000Z"))).toBe(true); // prior hour
    expect(isScheduleJobDue(j, now, new Date("2026-07-21T13:00:00.000Z"))).toBe(false); // same hour
  });
  test("daily is due on the first tick of a new UTC day only", () => {
    const j = job({ trigger: { kind: "schedule", every: "daily", branch: "main" } });
    expect(isScheduleJobDue(j, now, new Date("2026-07-20T23:45:00.000Z"))).toBe(true); // prior day
    expect(isScheduleJobDue(j, now, new Date("2026-07-21T00:00:00.000Z"))).toBe(false); // same day
  });
  test("non-schedule jobs are never due here", () => {
    expect(isScheduleJobDue(job({ trigger: { kind: "push", branchPattern: "*" } }), now, null)).toBe(false);
    expect(isScheduleJobDue(job({ trigger: { kind: "manual", branch: "m" } }), now, null)).toBe(false);
  });
});

describe("shouldSynthesizeRun", () => {
  test("skips a no-op tick (head unchanged); synthesizes on a new head / first run", () => {
    expect(shouldSynthesizeRun(job({ lastHeadSha: "abc" }), "abc")).toBe(false);
    expect(shouldSynthesizeRun(job({ lastHeadSha: "abc" }), "def")).toBe(true);
    expect(shouldSynthesizeRun(job(), "abc")).toBe(true); // never run before
    expect(shouldSynthesizeRun(job(), "")).toBe(false); // no head resolved
  });
});

// ── Validation ──────────────────────────────────────────────────────

describe("validateJobDraft", () => {
  test("accepts a valid push/schedule/manual draft (normalized)", () => {
    const push = validateJobDraft({ name: "  Nightly  ", trigger: { kind: "push", branchPattern: "release/*" }, enabled: true, skipSteps: ["test", "lint"] });
    expect(push.ok).toBe(true);
    if (push.ok) {
      expect(push.value.name).toBe("Nightly");
      expect(push.value.skipSteps).toEqual(["test", "lint"]);
    }
    expect(validateJobDraft({ name: "S", trigger: { kind: "schedule", every: "daily", branch: "main" }, enabled: true, skipSteps: [] }).ok).toBe(true);
    expect(validateJobDraft({ name: "M", trigger: { kind: "manual", branch: "main" }, enabled: true, skipSteps: [] }).ok).toBe(true);
  });

  test("rejects blank / over-long name", () => {
    expect(validateJobDraft({ name: "   ", trigger: { kind: "push", branchPattern: "*" }, enabled: true, skipSteps: [] }).ok).toBe(false);
    expect(validateJobDraft({ name: "x".repeat(MAX_JOB_NAME_LEN + 1), trigger: { kind: "push", branchPattern: "*" }, enabled: true, skipSteps: [] }).ok).toBe(false);
  });

  test("rejects an invalid branch pattern", () => {
    const r = validateJobDraft({ name: "J", trigger: { kind: "push", branchPattern: "fe*ature" }, enabled: true, skipSteps: [] });
    expect(r.ok).toBe(false);
  });

  test("rejects a PROTECTED step in skipSteps", () => {
    for (const protectedStep of ["intent", "rebase", "review", "push"]) {
      const r = validateJobDraft({ name: "J", trigger: { kind: "push", branchPattern: "*" }, enabled: true, skipSteps: [protectedStep as never] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("protected");
    }
  });

  test("rejects an unknown pipeline step", () => {
    const r = validateJobDraft({ name: "J", trigger: { kind: "push", branchPattern: "*" }, enabled: true, skipSteps: ["deploy" as never] });
    expect(r.ok).toBe(false);
  });

  test("schedule/manual triggers reject a glob branch", () => {
    expect(validateJobDraft({ name: "J", trigger: { kind: "schedule", every: "daily", branch: "feature/*" }, enabled: true, skipSteps: [] }).ok).toBe(false);
    expect(validateJobDraft({ name: "J", trigger: { kind: "manual", branch: "feature/*" }, enabled: true, skipSteps: [] }).ok).toBe(false);
  });

  test("rejects an unknown trigger kind + bad schedule cadence", () => {
    expect(validateJobDraft({ name: "J", trigger: { kind: "bogus" } as unknown as JobTrigger, enabled: true, skipSteps: [] }).ok).toBe(false);
    expect(validateJobDraft({ name: "J", trigger: { kind: "schedule", every: "weekly" as never, branch: "main" }, enabled: true, skipSteps: [] }).ok).toBe(false);
  });
});

describe("diffJob", () => {
  test("reports only changed top-level fields", () => {
    const before = job({ name: "A", enabled: true });
    const after = job({ name: "B", enabled: false });
    const d = diffJob(before, after);
    expect(d.name).toEqual({ from: "A", to: "B" });
    expect(d.enabled).toEqual({ from: true, to: false });
    expect(d.trigger).toBeUndefined();
  });
});

// ── Storage-backed JobStore + default seed ──────────────────────────

describe("createJobStore + loadJobsWithDefault (Storage-backed)", () => {
  beforeEach(() => __resetChannelForTests());
  afterEach(() => __resetChannelForTests());

  function stubStorage(): Map<string, unknown> {
    const mem = new Map<string, unknown>();
    const ch = getChannel() as HostChannel;
    spyOn(ch, "request").mockImplementation((async (_method: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      const key = `${p.scope}:${p.key}`;
      if (p.action === "set") { mem.set(key, p.value); return { ok: true, sizeBytes: 1 }; }
      if (p.action === "delete") { const had = mem.delete(key); return { deleted: had }; }
      if (p.action === "list") {
        const scopePrefix = `${p.scope}:`;
        const listPrefix = scopePrefix + (typeof p.prefix === "string" ? p.prefix : "");
        const keys = [...mem.keys()].filter((k) => k.startsWith(listPrefix)).map((k) => k.slice(scopePrefix.length));
        return { keys };
      }
      return mem.has(key) ? { value: mem.get(key), exists: true } : { value: null, exists: false };
    }) as HostChannel["request"]);
    return mem;
  }

  test("create + get + index round-trip; delete removes from index", async () => {
    stubStorage();
    const store = createJobStore("global");
    await store.createJob(job({ id: "a" }));
    await store.createJob(job({ id: "b" }));
    expect((await store.getJob("a"))!.id).toBe("a");
    expect((await store.listJobs()).map((j) => j.id)).toEqual(["a", "b"]);
    expect(await store.deleteJob("a")).toBe(true);
    expect(await store.getJob("a")).toBeNull();
    expect((await store.listJobs()).map((j) => j.id)).toEqual(["b"]);
    expect(await store.deleteJob("missing")).toBe(false);
  });

  test("updateJob merges + bumps updatedAt; missing → null", async () => {
    stubStorage();
    const store = createJobStore();
    await store.createJob(job({ id: "a", enabled: true }));
    const updated = await store.updateJob("a", { enabled: false });
    expect(updated!.enabled).toBe(false);
    expect(await store.updateJob("missing", { enabled: false })).toBeNull();
  });

  test("buildDefaultJob is a push job matching everything, all steps, enabled, system-owned", () => {
    const def = buildDefaultJob("2026-07-21T00:00:00.000Z");
    expect(def.id).toBe(DEFAULT_JOB_ID);
    expect(def.trigger).toEqual({ kind: "push", branchPattern: "*" });
    expect(def.enabled).toBe(true);
    expect(def.skipSteps).toEqual([]);
    expect(def.createdBy).toBe("system");
  });

  test("loadJobsWithDefault seeds the default job (audited) on first read, idempotent after", async () => {
    stubStorage();
    const store = createJobStore();
    const auditRecords: AuditEntry[] = [];
    const audit = createAuditLog();
    // Spy the audit append to observe the seed audit without a second channel.
    const origAppend = audit.append.bind(audit);
    audit.append = async (e) => { auditRecords.push({ at: e.at ?? "", actor: e.actor, kind: e.kind, ...(e.jobId ? { jobId: e.jobId } : {}) }); return origAppend(e); };

    const first = await loadJobsWithDefault(store, audit);
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toBe(DEFAULT_JOB_ID);
    expect(auditRecords.some((r) => r.kind === "job-seed" && r.actor === "system" && r.jobId === DEFAULT_JOB_ID)).toBe(true);

    // Second read reuses the seeded default — no duplicate + no second seed audit.
    auditRecords.length = 0;
    const second = await loadJobsWithDefault(store, audit);
    expect(second.map((j) => j.id)).toEqual([DEFAULT_JOB_ID]);
    expect(auditRecords).toHaveLength(0);
  });
});

import { test, expect, describe } from "bun:test";
import type { Check, CheckBucket } from "../github";
import { deserializeFindings } from "../runs";
import {
  pollInterval,
  hasPendingChecks,
  hasFailingChecks,
  failingCheckNames,
  failingCheckCompletionTimes,
  failingCheckCompletedAfter,
  pendingCheckMatchesLastFixed,
  encodeLastFixedChecks,
  decodeLastFixedChecks,
  ciFailureOutcome,
  ciMergeabilityOutcome,
  ciMonitoringTimeoutOutcome,
} from "./ci-poll";

const chk = (name: string, bucket: CheckBucket, completedAt = ""): Check => ({ name, bucket, completedAt });

describe("pollInterval", () => {
  test("30s / 60s / 120s schedule", () => {
    expect(pollInterval(0)).toBe(30_000);
    expect(pollInterval(4 * 60_000)).toBe(30_000);
    expect(pollInterval(6 * 60_000)).toBe(60_000);
    expect(pollInterval(20 * 60_000)).toBe(120_000);
  });
});

describe("check predicates", () => {
  test("pending / failing", () => {
    expect(hasPendingChecks([chk("a", "pending"), chk("b", "pass")])).toBe(true);
    expect(hasPendingChecks([chk("a", "pass")])).toBe(false);
    expect(hasFailingChecks([chk("a", "fail")])).toBe(true);
    expect(hasFailingChecks([chk("a", "pass")])).toBe(false);
  });
  test("failingCheckNames sorted", () => {
    expect(failingCheckNames([chk("z", "fail"), chk("a", "fail"), chk("m", "pass")])).toEqual(["a", "z"]);
  });
});

describe("completion times + re-run detection", () => {
  test("failingCheckCompletionTimes keeps the latest per name, skips unknown", () => {
    const times = failingCheckCompletionTimes([
      chk("build", "fail", "2026-07-16T00:00:00Z"),
      chk("build", "fail", "2026-07-16T01:00:00Z"),
      chk("lint", "fail", ""), // unknown → skipped
      chk("test", "fail", "not-a-date"), // NaN → skipped
      chk("ok", "pass", "2026-07-16T00:00:00Z"), // not failing → skipped
    ]);
    expect(times.build).toBe(Date.parse("2026-07-16T01:00:00Z"));
    expect(times.lint).toBeUndefined();
    expect(times.test).toBeUndefined();
    expect(times.ok).toBeUndefined();
  });
  test("empty → {}", () => {
    expect(failingCheckCompletionTimes([chk("a", "pass")])).toEqual({});
  });
  test("failingCheckCompletedAfter", () => {
    const after = { build: Date.parse("2026-07-16T00:00:00Z") };
    expect(failingCheckCompletedAfter([], after)).toBe(false); // empty checks → no match
    expect(failingCheckCompletedAfter([chk("build", "fail", "2026-07-16T02:00:00Z")], after)).toBe(true);
    expect(failingCheckCompletedAfter([chk("build", "fail", "2026-07-15T23:00:00Z")], after)).toBe(false);
    expect(failingCheckCompletedAfter([chk("build", "fail", "")], after)).toBe(false); // unknown time
    expect(failingCheckCompletedAfter([chk("other", "fail", "2026-07-16T02:00:00Z")], after)).toBe(false); // name absent
    expect(failingCheckCompletedAfter([chk("build", "fail", "2026-07-16T02:00:00Z")], {})).toBe(false); // empty after
  });
});

describe("last-fixed key encode/decode + pending match", () => {
  test("encode empty → ''; with issues → JSON", () => {
    expect(encodeLastFixedChecks([], false)).toBe("");
    const key = encodeLastFixedChecks(["build"], true);
    expect(decodeLastFixedChecks(key)).toEqual({ checks: ["build"], mergeConflict: true });
  });
  test("decode rejects empty / malformed / non-object / issue-free", () => {
    expect(decodeLastFixedChecks("")).toBeNull();
    expect(decodeLastFixedChecks("{bad")).toBeNull();
    expect(decodeLastFixedChecks("42")).toBeNull();
    expect(decodeLastFixedChecks(JSON.stringify({ checks: [], mergeConflict: false }))).toBeNull();
  });
  test("pendingCheckMatchesLastFixed", () => {
    // no key → false
    expect(pendingCheckMatchesLastFixed([chk("a", "pending")], "")).toBe(false);
    // merge-conflict-only key → matches when any check pending
    const mcKey = encodeLastFixedChecks([], true);
    expect(pendingCheckMatchesLastFixed([chk("a", "pending")], mcKey)).toBe(true);
    expect(pendingCheckMatchesLastFixed([chk("a", "pass")], mcKey)).toBe(false);
    // named key → matches when a named check is pending
    const key = encodeLastFixedChecks(["build"], false);
    expect(pendingCheckMatchesLastFixed([chk("build", "pending")], key)).toBe(true);
    expect(pendingCheckMatchesLastFixed([chk("build", "pass")], key)).toBe(false);
  });
});

describe("park outcomes", () => {
  test("ciFailureOutcome: failing + merge conflict → blocking ask-user findings", () => {
    const o = ciFailureOutcome(["build", "lint"], true, "still failing");
    expect(o.needsApproval).toBe(true);
    const f = deserializeFindings(JSON.parse(o.findings!));
    expect(f.items.length).toBe(3); // 2 checks + merge conflict
    expect(f.items.every((it) => it.action === "ask-user")).toBe(true); // no action → fail-closed
    expect(f.summary).toBe("still failing");
  });
  test("ciFailureOutcome: failing only", () => {
    const o = ciFailureOutcome(["build"], false, "s");
    const f = deserializeFindings(JSON.parse(o.findings!));
    expect(f.items.length).toBe(1);
  });
  test("ciMergeabilityOutcome", () => {
    const o = ciMergeabilityOutcome("timed out", "still unresolved");
    const f = deserializeFindings(JSON.parse(o.findings!));
    expect(f.items[0]!.description).toBe("still unresolved");
    expect(f.items[0]!.action).toBe("ask-user");
  });
  test("ciMonitoringTimeoutOutcome", () => {
    const o = ciMonitoringTimeoutOutcome();
    const f = deserializeFindings(JSON.parse(o.findings!));
    expect(f.summary).toContain("timed out");
    expect(f.items[0]!.action).toBe("ask-user");
  });
});

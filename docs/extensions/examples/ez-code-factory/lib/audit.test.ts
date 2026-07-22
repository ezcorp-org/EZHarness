import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { __resetChannelForTests, getChannel } from "@ezcorp/sdk/runtime";
import type { HostChannel } from "@ezcorp/sdk/runtime";
import {
  appendWithCap,
  clampAuditDetail,
  auditDayKey,
  auditDaysToPrune,
  isTruncationMarker,
  createAuditLog,
  AUDIT_BUCKET_CAP,
  AUDIT_DETAIL_MAX_BYTES,
  AUDIT_RETENTION_DAYS,
  type AuditEntry,
  type AuditBucket,
} from "./audit";
import { _setLogSinkForTests } from "./log";

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return { at: "2026-07-21T00:00:00.000Z", actor: "system", kind: "test", ...over };
}

// ── Pure cap logic ──────────────────────────────────────────────────

describe("appendWithCap", () => {
  test("appends below the cap with no marker", () => {
    let bucket: AuditBucket = [];
    for (let i = 0; i < 5; i++) bucket = appendWithCap(bucket, entry({ kind: `k${i}` }), 10);
    expect(bucket).toHaveLength(5);
    expect(bucket.some(isTruncationMarker)).toBe(false);
  });

  test("overflow drops oldest and prepends a single truncation marker", () => {
    let bucket: AuditBucket = [];
    for (let i = 0; i < 12; i++) bucket = appendWithCap(bucket, entry({ kind: `k${i}` }), 10);
    // cap real entries (10) + 1 leading marker.
    expect(bucket).toHaveLength(11);
    const marker = bucket[0];
    expect(isTruncationMarker(marker!)).toBe(true);
    if (isTruncationMarker(marker!)) expect(marker.dropped).toBe(2);
    // Oldest kept is k2 (k0, k1 dropped); newest is k11.
    const reals = bucket.filter((e) => !isTruncationMarker(e)) as AuditEntry[];
    expect(reals[0]!.kind).toBe("k2");
    expect(reals[reals.length - 1]!.kind).toBe("k11");
  });

  test("dropped count accumulates across successive overflows (marker coalesced)", () => {
    let bucket: AuditBucket = [];
    for (let i = 0; i < 15; i++) bucket = appendWithCap(bucket, entry({ kind: `k${i}` }), 10);
    const markers = bucket.filter(isTruncationMarker);
    expect(markers).toHaveLength(1);
    expect((markers[0] as { dropped: number }).dropped).toBe(5);
    expect(bucket.filter((e) => !isTruncationMarker(e))).toHaveLength(10);
  });

  test("defaults to the 500-entry cap", () => {
    let bucket: AuditBucket = [];
    for (let i = 0; i < AUDIT_BUCKET_CAP + 3; i++) bucket = appendWithCap(bucket, entry());
    expect(bucket.filter((e) => !isTruncationMarker(e))).toHaveLength(AUDIT_BUCKET_CAP);
    expect((bucket[0] as { dropped: number }).dropped).toBe(3);
  });
});

describe("clampAuditDetail", () => {
  test("small detail passes through untouched", () => {
    expect(clampAuditDetail({ a: 1 })).toEqual({ a: 1 });
    expect(clampAuditDetail(undefined)).toBeUndefined();
  });
  test("over-cap detail is replaced with a truncation preview", () => {
    const big = { blob: "x".repeat(AUDIT_DETAIL_MAX_BYTES + 100) };
    const clamped = clampAuditDetail(big) as { truncated: boolean; preview: string };
    expect(clamped.truncated).toBe(true);
    expect(clamped.preview.length).toBe(AUDIT_DETAIL_MAX_BYTES);
  });
});

describe("auditDayKey", () => {
  test("buckets by UTC day", () => {
    expect(auditDayKey(new Date("2026-07-21T23:59:59.000Z"))).toBe("audit/2026-07-21");
    expect(auditDayKey(new Date("2026-07-22T00:00:00.000Z"))).toBe("audit/2026-07-22");
  });
});

// ── Storage-backed AuditLog ─────────────────────────────────────────

describe("createAuditLog (Storage-backed)", () => {
  let logLines: string[] = [];
  beforeEach(() => {
    __resetChannelForTests();
    logLines = [];
    _setLogSinkForTests((line) => logLines.push(line));
  });
  afterEach(() => {
    __resetChannelForTests();
    _setLogSinkForTests(null);
  });

  function stubStorage(opts: { failSet?: boolean } = {}): Map<string, unknown> {
    const mem = new Map<string, unknown>();
    const ch = getChannel() as HostChannel;
    spyOn(ch, "request").mockImplementation((async (_method: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      const key = `${p.scope}:${p.key}`;
      if (p.action === "set") {
        if (opts.failSet) throw new Error("storage down");
        mem.set(key, p.value);
        return { ok: true, sizeBytes: 1 };
      }
      if (p.action === "delete") {
        return { deleted: mem.delete(key) };
      }
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

  test("append writes to the UTC day bucket; readDay returns entries", async () => {
    stubStorage();
    const audit = createAuditLog("global");
    await audit.append({ at: "2026-07-21T10:00:00.000Z", actor: "user-1", kind: "respond", runId: "r1", detail: { action: "approve" } });
    const day = await audit.readDay("2026-07-21");
    expect(day).toHaveLength(1);
    const e = day[0] as AuditEntry;
    expect(e.actor).toBe("user-1");
    expect(e.kind).toBe("respond");
    expect(e.runId).toBe("r1");
    expect(e.detail).toEqual({ action: "approve" });
  });

  test("append clamps an over-cap detail", async () => {
    stubStorage();
    const audit = createAuditLog();
    await audit.append({ at: "2026-07-21T10:00:00.000Z", actor: "system", kind: "job-save", detail: { blob: "y".repeat(AUDIT_DETAIL_MAX_BYTES + 50) } });
    const [stored] = await audit.readDay("2026-07-21");
    expect((stored as { detail: { truncated?: boolean } }).detail.truncated).toBe(true);
  });

  test("listDays returns YYYY-MM-DD keys newest-first", async () => {
    stubStorage();
    const audit = createAuditLog();
    await audit.append({ at: "2026-07-20T00:00:00.000Z", actor: "system", kind: "a" });
    await audit.append({ at: "2026-07-22T00:00:00.000Z", actor: "system", kind: "b" });
    await audit.append({ at: "2026-07-21T00:00:00.000Z", actor: "system", kind: "c" });
    expect(await audit.listDays()).toEqual(["2026-07-22", "2026-07-21", "2026-07-20"]);
  });

  test("a bucket write failure NEVER throws — it is logged and swallowed", async () => {
    stubStorage({ failSet: true });
    const audit = createAuditLog();
    // Must not reject — the action that produced the entry must not fail.
    await audit.append({ actor: "system", kind: "run-status", runId: "r1" });
    expect(logLines.some((l) => l.includes("[audit]") && l.includes("append failed"))).toBe(true);
  });

  test("pruneRetention removes buckets older than the window + audits a retention entry", async () => {
    const mem = stubStorage();
    const audit = createAuditLog();
    const now = new Date("2026-07-31T00:00:00.000Z");
    // Two OLD buckets (> 30d) + one recent (< 30d).
    await audit.append({ at: "2026-06-01T00:00:00.000Z", actor: "system", kind: "old-a" });
    await audit.append({ at: "2026-06-15T00:00:00.000Z", actor: "system", kind: "old-b" });
    await audit.append({ at: "2026-07-20T00:00:00.000Z", actor: "system", kind: "recent" });

    const pruned = await audit.pruneRetention(now, AUDIT_RETENTION_DAYS);
    expect(pruned.sort()).toEqual(["2026-06-01", "2026-06-15"]);
    // Old buckets gone; recent survives.
    expect(await audit.readDay("2026-06-01")).toEqual([]);
    expect(await audit.readDay("2026-07-20")).toHaveLength(1);
    // The retention action itself is audited on the current day.
    const today = await audit.readDay("2026-07-31");
    const retention = today.find((e) => (e as AuditEntry).kind === "retention") as AuditEntry;
    expect(retention).toBeDefined();
    expect((retention.detail as { prunedDays: number }).prunedDays).toBe(2);
    // Sanity: the recent-day storage key still exists in the backing map.
    expect([...mem.keys()].some((k) => k.endsWith("audit/2026-07-20"))).toBe(true);
  });

  test("pruneRetention with nothing to prune is a no-op (no retention entry)", async () => {
    stubStorage();
    const audit = createAuditLog();
    await audit.append({ at: "2026-07-30T00:00:00.000Z", actor: "system", kind: "recent" });
    const pruned = await audit.pruneRetention(new Date("2026-07-31T00:00:00.000Z"));
    expect(pruned).toEqual([]);
    // No retention entry appended when nothing was pruned.
    expect(await audit.listDays()).toEqual(["2026-07-30"]);
  });
});

describe("auditDaysToPrune (pure)", () => {
  test("returns only days strictly older than now - retentionDays", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const days = ["2026-07-30", "2026-07-01", "2026-06-30", "2026-06-15", "bogus"];
    // Cutoff = 2026-07-01; strictly-older → 2026-06-30, 2026-06-15.
    expect(auditDaysToPrune(days, now, 30).sort()).toEqual(["2026-06-15", "2026-06-30"]);
  });
});

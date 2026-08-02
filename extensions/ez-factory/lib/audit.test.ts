import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { __resetChannelForTests, getChannel } from "@ezcorp/sdk/runtime";
import type { HostChannel } from "@ezcorp/sdk/runtime";

import {
  appendWithCap,
  auditableJobDiff,
  auditDayKey,
  auditDaysToPrune,
  auditStderrSink,
  AUDIT_BUCKET_CAP,
  AUDIT_DETAIL_MAX_BYTES,
  AUDIT_RETENTION_DAYS,
  clampAuditDetail,
  createAuditLog,
  isTruncationMarker,
  SYSTEM_ACTOR,
  type AuditBucket,
  type AuditEntry,
} from "./audit";
import { DIFFABLE_FIELDS, diffJob, type FactoryJob } from "./jobs";

const NOW = "2026-08-01T12:00:00.000Z";

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
    createdAt: NOW,
    updatedBy: "user-1",
    updatedAt: NOW,
    ...over,
  };
}

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return { at: NOW, actor: "user-1", kind: "job-save", ...over };
}

/**
 * In-memory stand-in for the host storage handler, mirroring
 * `jobs.test.ts`'s. `failOn` makes ONE action reject, which is how the
 * "never fails the action it records" property gets exercised against a real
 * throw rather than a mocked-away one.
 */
function stubStorage(opts: { failOn?: "get" | "set" | "delete" | "list" } = {}): {
  mem: Map<string, unknown>;
  calls: string[];
} {
  const mem = new Map<string, unknown>();
  const calls: string[] = [];
  const channel = getChannel() as HostChannel;
  spyOn(channel, "request").mockImplementation((async (_method: string, params: unknown) => {
    const p = params as Record<string, unknown>;
    const action = String(p.action);
    const key = String(p.key ?? "");
    calls.push(`${action}:${key}`);
    if (action === opts.failOn) throw new Error(`storage ${action} exploded`);
    if (action === "set") {
      mem.set(key, JSON.parse(JSON.stringify(p.value)));
      return { ok: true, sizeBytes: 1 };
    }
    if (action === "delete") return { deleted: mem.delete(key) };
    if (action === "list") {
      const prefix = typeof p.prefix === "string" ? p.prefix : "";
      return { keys: [...mem.keys()].filter((k) => k.startsWith(prefix)) };
    }
    return mem.has(key) ? { value: mem.get(key), exists: true } : { value: null, exists: false };
  }) as HostChannel["request"]);
  return { mem, calls };
}

afterEach(() => {
  __resetChannelForTests();
});

// ── Day keys ────────────────────────────────────────────────────────

describe("auditDayKey", () => {
  test("buckets by UTC day, not local day", () => {
    expect(auditDayKey(new Date("2026-08-01T23:59:59.999Z"))).toBe("audit/2026-08-01");
    expect(auditDayKey(new Date("2026-08-02T00:00:00.000Z"))).toBe("audit/2026-08-02");
  });
});

describe("isTruncationMarker", () => {
  test("separates the marker from a real entry", () => {
    expect(isTruncationMarker({ kind: "truncated", dropped: 3, at: NOW })).toBe(true);
    expect(isTruncationMarker(entry())).toBe(false);
    // A real entry whose `kind` happens to be the word is still not a marker —
    // the numeric `dropped` is what distinguishes them.
    expect(isTruncationMarker(entry({ kind: "truncated" }))).toBe(false);
  });
});

// ── Invariant I, the risky field: job-save diffs ────────────────────
//
// `auditableJobDiff` is the ONE place a job's content could leak into a
// 30-day durable bucket. Each test below is paired with the value it must
// NOT have carried, so "reports the change" and "reports only the name" are
// asserted separately rather than being one hopeful expectation.

describe("invariant I — a job-save audit records field NAMES, never values", () => {
  test("PROOF THE CONTROL IS LIVE: a real edit does produce a non-empty change list", () => {
    // Guards the vacuous pass. If `auditableJobDiff` returned `[]` for
    // everything, every "does not contain the value" test below would pass
    // for entirely the wrong reason. This fails first.
    const before = job();
    const after = job({ name: "Renamed" });
    expect(auditableJobDiff(before, after)).toEqual(["name"]);
  });

  test("a whole document in `input.draft` is reported as the word 'input' and nothing more", () => {
    const secret = "PATIENT NAME: Jane Doe — internal draft, do not publish";
    const before = job({ workflow: "draft-and-verify", input: {} });
    const after = job({ workflow: "draft-and-verify", input: { draft: secret } });

    const changed = auditableJobDiff(before, after);
    expect(changed).toEqual(["input"]);
    // The load-bearing assertion: the CONTENT is nowhere in the audit shape.
    expect(JSON.stringify(changed)).not.toContain(secret);
    expect(JSON.stringify(changed)).not.toContain("Jane Doe");
  });

  test("`diffJob` — the sibling this deliberately does NOT use — DOES carry the value", () => {
    // The contrast is the point. `diffJob` exists for showing an operator
    // what they are about to change; routing it into the trail is the exact
    // mistake this port was written to avoid. If someone ever swaps the two,
    // this test documents what changes.
    const secret = "PATIENT NAME: Jane Doe";
    const before = job({ workflow: "draft-and-verify", input: {} });
    const after = job({ workflow: "draft-and-verify", input: { draft: secret } });
    expect(JSON.stringify(diffJob(before, after))).toContain(secret);
  });

  test("a filesystem path in `input.outPath` never lands in the trail either", () => {
    const path = "/home/someone/private-clients/acme/report.md";
    const before = job({ input: { globs: "src/**" } });
    const after = job({ input: { globs: "src/**", outPath: path } });
    expect(auditableJobDiff(before, after)).toEqual(["input"]);
    expect(JSON.stringify(auditableJobDiff(before, after))).not.toContain(path);
  });

  test("reports every editable field that moved, sorted, and nothing that did not", () => {
    const before = job();
    const after = job({
      name: "New",
      description: "Now described",
      workflow: "etl-factory",
      input: { globs: "a/**" },
      trigger: { kind: "manual" },
      enabled: false,
      // Store-owned fields moved too — they must NOT be reported, because
      // they are not what an operator edited.
      updatedAt: "2026-09-09T00:00:00.000Z",
      updatedBy: "user-9",
      lastRunAt: "2026-09-09T00:00:00.000Z",
    });
    expect(auditableJobDiff(before, after)).toEqual([
      "description",
      "enabled",
      "input",
      "name",
      "workflow",
    ]);
  });

  test("an unchanged job reports no fields at all", () => {
    expect(auditableJobDiff(job(), job())).toEqual([]);
  });

  test("the field list it walks is the store's own, not a second copy", () => {
    // Every diffable field must be individually detectable, or a rename could
    // silently stop being audited.
    for (const field of DIFFABLE_FIELDS) {
      const before = job();
      const after = job({ [field]: field === "enabled" ? false : "changed" } as Partial<FactoryJob>);
      expect(auditableJobDiff(before, after)).toEqual([field as string]);
    }
  });
});

// ── Clamping ────────────────────────────────────────────────────────

describe("clampAuditDetail", () => {
  test("passes an under-cap value through unchanged (identity, not a copy)", () => {
    const detail = { changed: ["name"] };
    expect(clampAuditDetail(detail)).toBe(detail);
  });

  test("undefined stays undefined so the entry can omit the key", () => {
    expect(clampAuditDetail(undefined)).toBeUndefined();
  });

  test("an over-cap value is REPLACED with a bounded preview, never stored whole", () => {
    const huge = { reason: "x".repeat(AUDIT_DETAIL_MAX_BYTES * 2) };
    const clamped = clampAuditDetail(huge) as { truncated: boolean; preview: string };
    expect(clamped.truncated).toBe(true);
    expect(clamped.preview.length).toBe(AUDIT_DETAIL_MAX_BYTES);
    // Discrimination: the untouched value really is over the cap, so the
    // branch above was reached rather than skipped.
    expect(JSON.stringify(huge).length).toBeGreaterThan(AUDIT_DETAIL_MAX_BYTES);
  });

  test("exactly at the cap is kept whole (the boundary is inclusive)", () => {
    // `{"r":"…"}` is 8 chars of envelope around the padding.
    const detail = { r: "y".repeat(AUDIT_DETAIL_MAX_BYTES - 8) };
    expect(JSON.stringify(detail).length).toBe(AUDIT_DETAIL_MAX_BYTES);
    expect(clampAuditDetail(detail)).toBe(detail);
  });

  test("an unserializable value degrades to a marker instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(clampAuditDetail(cyclic)).toEqual({
      truncated: true,
      preview: "[unserializable detail]",
    });
  });

  test("a value that serializes to `undefined` passes through rather than crashing", () => {
    // `JSON.stringify(() => {})` is `undefined` — neither over-cap nor a throw.
    const fn = () => {};
    expect(clampAuditDetail(fn)).toBe(fn);
  });
});

// ── Drop-oldest with a visible marker ───────────────────────────────

describe("appendWithCap", () => {
  test("under the cap: appends, no marker invented", () => {
    const out = appendWithCap([entry({ kind: "a" })], entry({ kind: "b" }), 5);
    expect(out.map((e) => (e as AuditEntry).kind)).toEqual(["a", "b"]);
    expect(out.some(isTruncationMarker)).toBe(false);
  });

  test("over the cap: drops the OLDEST and says so in a leading marker", () => {
    const bucket: AuditBucket = [
      entry({ kind: "oldest" }),
      entry({ kind: "middle" }),
    ];
    const out = appendWithCap(bucket, entry({ kind: "newest" }), 2);
    expect(isTruncationMarker(out[0]!)).toBe(true);
    expect((out[0] as { dropped: number }).dropped).toBe(1);
    // The oldest is gone, the newest survived — drop-OLDEST, not drop-newest.
    expect(out.slice(1).map((e) => (e as AuditEntry).kind)).toEqual(["middle", "newest"]);
  });

  test("truncation is never silent — a full bucket always carries the marker", () => {
    let bucket: AuditBucket = [];
    for (let i = 0; i < 12; i++) bucket = appendWithCap(bucket, entry({ kind: `e${i}` }), 5);
    expect(isTruncationMarker(bucket[0]!)).toBe(true);
    expect((bucket[0] as { dropped: number }).dropped).toBe(7);
    // The cap counts REAL entries; the marker rides on top of them.
    expect(bucket.filter((e) => !isTruncationMarker(e))).toHaveLength(5);
    expect(bucket).toHaveLength(6);
  });

  test("a prior day's marker is coalesced, never dropped or double-counted", () => {
    const bucket: AuditBucket = [
      { kind: "truncated", dropped: 40, at: NOW },
      entry({ kind: "a" }),
      entry({ kind: "b" }),
    ];
    const out = appendWithCap(bucket, entry({ kind: "c" }), 2);
    expect(out.filter(isTruncationMarker)).toHaveLength(1);
    expect((out[0] as { dropped: number }).dropped).toBe(41);
  });

  test("an existing marker survives an append that does NOT overflow", () => {
    const bucket: AuditBucket = [
      { kind: "truncated", dropped: 9, at: NOW },
      entry({ kind: "a" }),
    ];
    const out = appendWithCap(bucket, entry({ kind: "b" }), 10);
    expect((out[0] as { dropped: number }).dropped).toBe(9);
    expect(out).toHaveLength(3);
  });

  test("defaults to the module cap", () => {
    let bucket: AuditBucket = [];
    for (let i = 0; i <= AUDIT_BUCKET_CAP; i++) bucket = appendWithCap(bucket, entry());
    expect(bucket.filter((e) => !isTruncationMarker(e))).toHaveLength(AUDIT_BUCKET_CAP);
    expect((bucket[0] as { dropped: number }).dropped).toBe(1);
  });
});

// ── Retention ───────────────────────────────────────────────────────

describe("auditDaysToPrune", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");

  test("prunes strictly older than the window and keeps the boundary day", () => {
    // 30 days before 2026-08-01 is 2026-07-02.
    expect(
      auditDaysToPrune(["2026-07-01", "2026-07-02", "2026-07-03"], now, AUDIT_RETENTION_DAYS),
    ).toEqual(["2026-07-01"]);
  });

  test("ignores keys that are not day-shaped rather than pruning them", () => {
    expect(auditDaysToPrune(["nonsense", "2020-01-01", ""], now, 30)).toEqual(["2020-01-01"]);
  });

  test("an empty window prunes everything before today", () => {
    expect(auditDaysToPrune(["2026-07-31", "2026-08-01"], now, 0)).toEqual(["2026-07-31"]);
  });
});

// ── The storage-backed log ──────────────────────────────────────────

describe("createAuditLog", () => {
  test("append stores an id-only entry in today's bucket and reads back", async () => {
    stubStorage();
    const log = createAuditLog();
    await log.append({ at: NOW, actor: "user-1", kind: "job-save", jobId: "j1", detail: { changed: ["name"] } });

    const bucket = await log.readDay("2026-08-01");
    expect(bucket).toHaveLength(1);
    expect(bucket[0]).toEqual({
      at: NOW,
      actor: "user-1",
      kind: "job-save",
      jobId: "j1",
      detail: { changed: ["name"] },
    });
  });

  test("optional keys are OMITTED, not written as undefined", async () => {
    stubStorage();
    const log = createAuditLog();
    await log.append({ at: NOW, actor: SYSTEM_ACTOR, kind: "retention" });
    const [stored] = await log.readDay("2026-08-01");
    expect(Object.keys(stored!).sort()).toEqual(["actor", "at", "kind"]);
  });

  test("`at` defaults to now when the caller does not supply one", async () => {
    stubStorage();
    const before = Date.now();
    const log = createAuditLog();
    await log.append({ actor: "user-1", kind: "job-create" });
    const day = new Date().toISOString().slice(0, 10);
    const [stored] = await log.readDay(day);
    expect(Date.parse((stored as AuditEntry).at)).toBeGreaterThanOrEqual(before);
  });

  test("an over-cap detail is clamped on the way IN, not merely on the way out", async () => {
    stubStorage();
    const log = createAuditLog();
    await log.append({ at: NOW, actor: "u", kind: "job-rejected", detail: "z".repeat(9999) });
    const [stored] = await log.readDay("2026-08-01");
    expect((stored as AuditEntry).detail).toMatchObject({ truncated: true });
    expect(JSON.stringify(stored).length).toBeLessThan(AUDIT_DETAIL_MAX_BYTES + 300);
  });

  test("a missing bucket reads as empty, not a throw", async () => {
    stubStorage();
    expect(await createAuditLog().readDay("1999-01-01")).toEqual([]);
  });

  test("listDays returns day-shaped keys only, newest first", async () => {
    stubStorage();
    const log = createAuditLog();
    for (const at of ["2026-07-30", "2026-08-01", "2026-07-31"]) {
      await log.append({ at: `${at}T01:00:00.000Z`, actor: "u", kind: "k" });
    }
    expect(await log.listDays()).toEqual(["2026-08-01", "2026-07-31", "2026-07-30"]);
  });

  test("INVARIANT I: a bucket write failure NEVER fails the action it records", async () => {
    stubStorage({ failOn: "set" });
    const seen: string[] = [];
    const log = createAuditLog("global", (m) => seen.push(m));

    // The assertion is that this resolves rather than rejects. `.append` is
    // called from a page-action handler AFTER the job has already been
    // written — a throw here would fail a save that already happened.
    await expect(log.append({ at: NOW, actor: "u", kind: "job-save" })).resolves.toBeUndefined();

    // Record-and-continue: swallowed, but not hidden.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("append failed (job-save)");
    expect(seen[0]).toContain("storage set exploded");
  });

  test("the swallow is specific to the write — a healthy log reports nothing", async () => {
    // Discrimination for the test above: with no injected failure the same
    // call produces an empty sink, so `seen.length === 1` there was caused by
    // the failure and not by the sink being chatty.
    stubStorage();
    const seen: string[] = [];
    await createAuditLog("global", (m) => seen.push(m)).append({
      at: NOW,
      actor: "u",
      kind: "job-save",
    });
    expect(seen).toEqual([]);
  });

  test("pruneRetention deletes stale buckets and audits the prune itself", async () => {
    const { mem } = stubStorage();
    const log = createAuditLog();
    await log.append({ at: "2026-01-01T00:00:00.000Z", actor: "u", kind: "old" });
    await log.append({ at: NOW, actor: "u", kind: "recent" });

    const pruned = await log.pruneRetention(new Date(NOW));
    expect(pruned).toEqual(["2026-01-01"]);
    expect(mem.has("audit/2026-01-01")).toBe(false);
    expect(mem.has("audit/2026-08-01")).toBe(true);

    const today = await log.readDay("2026-08-01");
    expect(today.map((e) => (e as AuditEntry).kind)).toEqual(["recent", "retention"]);
    expect((today[1] as AuditEntry).detail).toEqual({ prunedDays: 1, retentionDays: 30 });
    expect((today[1] as AuditEntry).actor).toBe(SYSTEM_ACTOR);
  });

  test("pruneRetention with nothing stale writes no entry at all", async () => {
    stubStorage();
    const log = createAuditLog();
    await log.append({ at: NOW, actor: "u", kind: "recent" });
    expect(await log.pruneRetention(new Date(NOW))).toEqual([]);
    expect(await log.readDay("2026-08-01")).toHaveLength(1);
  });

  test("pruneRetention honours a caller-supplied window", async () => {
    const { mem } = stubStorage();
    const log = createAuditLog();
    await log.append({ at: "2026-07-30T00:00:00.000Z", actor: "u", kind: "k" });
    expect(await log.pruneRetention(new Date(NOW), 1)).toEqual(["2026-07-30"]);
    expect(mem.has("audit/2026-07-30")).toBe(false);
  });

  test("a prune failure is swallowed and reported, never thrown", async () => {
    stubStorage({ failOn: "list" });
    const seen: string[] = [];
    const log = createAuditLog("global", (m) => seen.push(m));
    await expect(log.pruneRetention(new Date(NOW))).resolves.toEqual([]);
    expect(seen[0]).toContain("retention prune failed");
  });
});

describe("auditStderrSink", () => {
  test("writes the line to Bun.stderr, never process.stderr", () => {
    // `process.stderr.write` lazily constructs a `node:fs` WriteStream, which
    // the sandbox preload poisons — the first call would take the subprocess
    // down. Assert the sink reaches for the Bun primitive instead.
    const written: string[] = [];
    const writer = { write: (s: string) => written.push(s), flush: () => Promise.resolve(0) };
    const spy = spyOn(Bun.stderr, "writer").mockImplementation(
      () => writer as unknown as ReturnType<typeof Bun.stderr.writer>,
    );
    try {
      auditStderrSink("ez-factory[audit]: something");
      expect(written).toEqual(["ez-factory[audit]: something\n"]);
    } finally {
      spy.mockRestore();
    }
  });
});

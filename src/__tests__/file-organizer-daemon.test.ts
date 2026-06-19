import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileOrganizerDaemon,
  DEFAULT_SETTINGS,
  mergeFileOrganizerSettings,
  _fileOrganizerDaemonInternals,
  type FileOrganizerSettings,
} from "../extensions/file-organizer-daemon";
import { readProcStartTime } from "../startup/process-lockfile";
import type { PermissionEngine } from "../extensions/permission-engine";
import type { ProposalsFile } from "../../docs/extensions/examples/file-organizer/lib/proposals";

// ── Fixtures ────────────────────────────────────────────────────────

function fakeEngine(decision: "allow" | "deny" = "allow"): PermissionEngine {
  return {
    authorize: async () =>
      decision === "allow"
        ? { decision: "allow", auditId: "a1" }
        : { decision: "deny", reason: "deny", auditId: "ad" },
  } as unknown as PermissionEngine;
}

let root: string;
let dataDir: string;
let watched: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fo-daemon-"));
  dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
  watched = join(root, "watched");
  await mkdir(join(dataDir, ".trash"), { recursive: true });
  await mkdir(watched, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface ConfigInput {
  mode?: FileOrganizerSettings["defaultMode"];
  presets?: string[];
  customRules?: unknown[];
  backlogPolicy?: "new-only" | "include-existing";
  epochMs?: number;
}

async function writeConfig(input: ConfigInput = {}): Promise<void> {
  await writeFile(
    join(dataDir, "config.json"),
    JSON.stringify({
      folders: [
        {
          id: "f1",
          path: watched,
          ...(input.mode ? { mode: input.mode } : {}),
          presets: input.presets ?? [],
          customRules: input.customRules ?? [],
          ignore: [],
          backlogPolicy: input.backlogPolicy ?? "include-existing",
          ...(input.epochMs !== undefined ? { epochMs: input.epochMs } : {}),
        },
      ],
      globalIgnore: [".ezcorp/data", ".git", "node_modules"],
      schemaVersion: 1,
    }),
  );
}

// The junk-tmp preset now carries a ~10-minute dwell guard (atomic-writer
// safety, see lib/rules.ts JUNK_TMP_MIN_AGE_MS). Freshly-written `.tmp`
// fixtures have an mtime of ~real-now, so by default we advance the
// daemon's injected clock past the dwell window — that keeps the existing
// "a fresh junk fixture gets proposed" assertions meaningful (they test
// the sweep pipeline, NOT the dwell guard, which has its own unit test in
// lib/rules.test.ts). Tests that care about the real clock pass `now`
// explicitly to override this.
const PAST_TMP_DWELL = () => Date.now() + 60 * 60 * 1000;

function makeDaemon(opts: { settings?: Partial<FileOrganizerSettings>; engine?: PermissionEngine; now?: () => number; invalidations?: string[] } = {}): FileOrganizerDaemon {
  const settings: FileOrganizerSettings = { ...DEFAULT_SETTINGS, scanIntervalSec: 5, stabilityTicks: 1, ...opts.settings };
  return new FileOrganizerDaemon({
    dataDir,
    engine: opts.engine ?? fakeEngine("allow"),
    extensionId: "ext-fo",
    getSettings: async () => settings,
    invalidatePage: opts.invalidations ? (p) => opts.invalidations!.push(p) : undefined,
    now: opts.now ?? PAST_TMP_DWELL,
    skipLockfile: true,
  });
}

async function readProposals(): Promise<ProposalsFile> {
  const text = await readFile(join(dataDir, "proposals.json"), "utf8");
  return JSON.parse(text) as ProposalsFile;
}

/** Drive the stability gate: tick `n` times so a quiescent file becomes stable. */
async function tickN(d: FileOrganizerDaemon, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await d.tick();
}

describe("daemon — ask-everything mode", () => {
  test("queues a junk proposal (pending, not applied) once stable", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    await writeFile(join(watched, "trash.tmp"), "junk");
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "ask-everything" } });
    await tickN(d, 2); // tick 1: record stability; tick 2: stable → propose
    const file = await readProposals();
    expect(file.proposals).toHaveLength(1);
    expect(file.proposals[0]!.kind).toBe("delete-quarantine");
    expect(file.proposals[0]!.status).toBe("pending");
    // The file is NOT touched in ask-everything mode.
    expect(await Bun.file(join(watched, "trash.tmp")).exists()).toBe(true);
  });

  test("stability gate: a file changing every tick is never proposed", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    const f = join(watched, "growing.tmp");
    const d = makeDaemon({ settings: { stabilityTicks: 2 } });
    await writeFile(f, "a");
    await d.tick();
    await writeFile(f, "ab"); // size changed → resets
    await d.tick();
    await writeFile(f, "abc");
    await d.tick();
    const file = await readProposals();
    expect(file.proposals).toHaveLength(0);
  });

  test("partial-download extensions are skipped", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    await writeFile(join(watched, "download.crdownload"), "x");
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    expect((await readProposals()).proposals).toHaveLength(0);
  });

  test("dedupe: a second tick does not duplicate a pending proposal", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    await writeFile(join(watched, "j.tmp"), "x");
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 3);
    expect((await readProposals()).proposals).toHaveLength(1);
  });
});

describe("daemon — approve-non-destructive-only mode", () => {
  test("auto-applies a route (move) but leaves a delete pending", async () => {
    await writeConfig({ mode: "approve-non-destructive-only", presets: ["downloads-router", "junk-sweep"] });
    await writeFile(join(watched, "photo.png"), "img");
    await writeFile(join(watched, "junk.tmp"), "j");
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "ask-everything" } });
    await tickN(d, 2);
    const file = await readProposals();
    const move = file.proposals.find((p) => p.kind === "move")!;
    const del = file.proposals.find((p) => p.kind === "delete-quarantine")!;
    expect(move.status).toBe("applied");
    expect(del.status).toBe("pending"); // destructive held
    // The image was moved to Images/.
    expect(await Bun.file(join(watched, "Images", "photo.png")).exists()).toBe(true);
    expect(await Bun.file(join(watched, "photo.png")).exists()).toBe(false);
    // The junk file is untouched.
    expect(await Bun.file(join(watched, "junk.tmp")).exists()).toBe(true);
  });
});

describe("daemon — fully-auto mode", () => {
  test("a pending symlink proposal yields a 'skipped' apply ⇒ left pending (no crash)", async () => {
    // autoApply iterates ALL pending proposals for the folder, including a
    // pre-existing one. A proposal whose snapshot is a symlink makes
    // applyProposal return "skipped" → applyOutcomeToProposal's default
    // (return null) → the row is left pending rather than mutated.
    await writeConfig({ mode: "fully-auto" });
    const link = join(watched, "link.txt");
    const target = join(watched, "target.txt");
    const { symlink } = await import("node:fs/promises");
    await writeFile(target, "x");
    await symlink(target, link);
    await writeFile(
      join(dataDir, "proposals.json"),
      JSON.stringify({
        proposals: [{
          id: "sl", kind: "move", src: link, dst: join(watched, "sub", "link.txt"),
          reason: "r", ruleId: "r1", ruleLabel: "R", folderId: "f1",
          snapshot: { size: 0, mtimeMs: 0, isSymlink: true, dev: 0, ino: 0, nlink: 1 },
          status: "pending", dedupeKey: "k", createdAt: "2026-06-17T00:00:00Z", version: 0,
        }],
        suppressed: [],
        schemaVersion: 1,
      }),
    );
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "fully-auto" } });
    await d.tick();
    const file = await readProposals();
    const sl = file.proposals.find((p) => p.id === "sl")!;
    expect(sl.status).toBe("pending"); // skipped outcome → left untouched
  });

  test("auto-applies everything as a batch + quarantines + records manifest", async () => {
    await writeConfig({ mode: "fully-auto", presets: ["junk-sweep"] });
    await writeFile(join(watched, "junk.tmp"), "junk");
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    const file = await readProposals();
    const del = file.proposals.find((p) => p.kind === "delete-quarantine")!;
    expect(del.status).toBe("applied");
    expect(del.batchId).toBeDefined();
    expect(del.quarantineId).toBeDefined();
    // Original removed; quarantine manifest has an entry.
    expect(await Bun.file(join(watched, "junk.tmp")).exists()).toBe(false);
    const manifest = JSON.parse(await readFile(join(dataDir, ".trash", "manifest.json"), "utf8"));
    expect(manifest.entries.length).toBe(1);
    expect(manifest.entries[0].batchId).toBe(del.batchId);
  });
});

describe("daemon — backlog policy", () => {
  test("new-only skips files older than epochMs", async () => {
    const epoch = Date.now();
    await writeConfig({ presets: ["junk-sweep"], backlogPolicy: "new-only", epochMs: epoch });
    const old = join(watched, "old.tmp");
    await writeFile(old, "old");
    // Backdate the file to before the epoch.
    const past = new Date(epoch - 60_000);
    await utimes(old, past, past);
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    expect((await readProposals()).proposals).toHaveLength(0);
  });

  test("include-existing sweeps pre-existing files", async () => {
    await writeConfig({ presets: ["junk-sweep"], backlogPolicy: "include-existing" });
    await writeFile(join(watched, "pre.tmp"), "x");
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    expect((await readProposals()).proposals).toHaveLength(1);
  });
});

describe("daemon — duplicate-killer keeps one canonical", () => {
  test("two identical files → EXACTLY one delete-quarantine, on the NON-canonical (newer) copy", async () => {
    await writeConfig({ presets: ["duplicate-killer"] });
    const oldF = join(watched, "a-canonical.bin");
    const newF = join(watched, "b-copy.bin");
    await writeFile(oldF, "identical-bytes");
    await writeFile(newF, "identical-bytes");
    // Backdate the canonical copy so it has the smaller mtime.
    const past = new Date(Date.now() - 120_000);
    await utimes(oldF, past, past);
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "ask-everything" } });
    // `dupesToRemove` is built from the START-of-tick hashcache, and files
    // are hashed only once stable. tick 1 records stability; tick 2 (stable)
    // hashes both into the cache; tick 3 reads that cache → the dupe is seen
    // and the newer copy is flagged.
    await tickN(d, 3);
    const file = await readProposals();
    const dels = file.proposals.filter((p) => p.kind === "delete-quarantine");
    expect(dels).toHaveLength(1);
    expect(dels[0]!.src).toBe(newF); // the non-canonical (newer) copy
    // The canonical (oldest) copy is NEVER proposed for removal.
    expect(file.proposals.some((p) => p.src === oldF && p.kind === "delete-quarantine")).toBe(false);
  });

  test("fully-auto: the canonical copy survives on disk; only the duplicate is quarantined", async () => {
    await writeConfig({ mode: "fully-auto", presets: ["duplicate-killer"] });
    const oldF = join(watched, "keep.bin");
    const newF = join(watched, "remove.bin");
    await writeFile(oldF, "same-content");
    await writeFile(newF, "same-content");
    const past = new Date(Date.now() - 120_000);
    await utimes(oldF, past, past);
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "fully-auto" } });
    await tickN(d, 3); // see canonical-detection note above
    // Canonical kept; only the duplicate removed (data-safety: never both).
    expect(await Bun.file(oldF).exists()).toBe(true);
    expect(await Bun.file(newF).exists()).toBe(false);
  });
});

describe("daemon — unclassified alert for new unmatched files", () => {
  const EPOCH = 1_000_000;

  test("a NEW (mtime ≥ epoch) unmatched file → exactly one unclassified pending proposal", async () => {
    await writeConfig({ presets: ["junk-sweep"], backlogPolicy: "include-existing", epochMs: EPOCH });
    const f = join(watched, "mystery.xyz"); // matches no rule
    await writeFile(f, "data");
    const future = new Date(EPOCH + 60_000);
    await utimes(f, future, future);
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    // 3 ticks: stable (t1) → hashed into cache (t2) → unclassified emitted
    // once the hash is cached so dup membership is authoritative (t3).
    await tickN(d, 3);
    const file = await readProposals();
    const unc = file.proposals.filter((p) => p.kind === "unclassified");
    expect(unc).toHaveLength(1);
    expect(unc[0]!.status).toBe("pending");
    expect(unc[0]!.src).toBe(f);
    expect(unc[0]!.dst).toBeNull();
    expect(unc[0]!.reason).toContain("No rule matched");
  });

  test("a rule-matching file is NOT flagged unclassified", async () => {
    await writeConfig({ presets: ["junk-sweep"], backlogPolicy: "include-existing", epochMs: EPOCH });
    const f = join(watched, "junk.tmp"); // junk-sweep matches
    await writeFile(f, "j");
    const future = new Date(EPOCH + 60_000);
    await utimes(f, future, future);
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    const file = await readProposals();
    expect(file.proposals.some((p) => p.kind === "unclassified")).toBe(false);
  });

  test("an OLD (mtime < epoch) unmatched file is NOT flagged (no backlog spam)", async () => {
    await writeConfig({ presets: ["junk-sweep"], backlogPolicy: "include-existing", epochMs: EPOCH });
    const f = join(watched, "ancient.xyz");
    await writeFile(f, "data");
    const past = new Date(EPOCH - 60_000);
    await utimes(f, past, past);
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    expect((await readProposals()).proposals).toHaveLength(0);
  });

  test("a folder without epochMs never flags unclassified", async () => {
    // No epochMs ⇒ no "watch start" defined ⇒ the new-file guard is closed.
    await writeConfig({ presets: ["junk-sweep"], backlogPolicy: "include-existing" });
    await writeFile(join(watched, "loose.xyz"), "data");
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    expect((await readProposals()).proposals).toHaveLength(0);
  });

  test("re-ticking does not re-propose the same unclassified file (deduped)", async () => {
    await writeConfig({ presets: ["junk-sweep"], backlogPolicy: "include-existing", epochMs: EPOCH });
    const f = join(watched, "again.xyz");
    await writeFile(f, "data");
    const future = new Date(EPOCH + 60_000);
    await utimes(f, future, future);
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 4); // extra ticks must not duplicate
    expect((await readProposals()).proposals.filter((p) => p.kind === "unclassified")).toHaveLength(1);
  });

  test("unclassified is never auto-applied, even in fully-auto (no dst)", async () => {
    await writeConfig({ mode: "fully-auto", presets: ["junk-sweep"], backlogPolicy: "include-existing", epochMs: EPOCH });
    const f = join(watched, "untouched.xyz");
    await writeFile(f, "data");
    const future = new Date(EPOCH + 60_000);
    await utimes(f, future, future);
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "fully-auto" } });
    await tickN(d, 3); // hash-cached before flag (see note above)
    const file = await readProposals();
    const unc = file.proposals.find((p) => p.kind === "unclassified")!;
    expect(unc.status).toBe("pending"); // not applied
    expect(await Bun.file(f).exists()).toBe(true); // file left in place
    // The badge surfaces it in the unclassified count.
    const badge = JSON.parse(await readFile(join(dataDir, "badge.json"), "utf8"));
    expect(badge.unclassified).toBe(1);
  });

  test("a dwell-DEFERRED fresh *.tmp (pattern-matches junk-tmp, too new) is NOT unclassified", async () => {
    // junk-tmp's 10-min `olderThanMs` defers a fresh `*.tmp` → firstMatch is
    // null, but the file's TYPE is recognized (the glob pattern-matches), so
    // it must NOT become an unclassified "unknown file". Use a clock just
    // past epoch so the tmp is new-since-watch yet still inside the dwell.
    await writeConfig({ presets: ["junk-sweep"], backlogPolicy: "include-existing", epochMs: EPOCH });
    const tmp = join(watched, "fresh-save.tmp"); // matches *.tmp, too new
    await writeFile(tmp, "writing");
    const fresh = new Date(EPOCH + 500);
    await utimes(tmp, fresh, fresh);
    const d = makeDaemon({ settings: { stabilityTicks: 1 }, now: () => EPOCH + 1000 });
    await tickN(d, 2);
    const file = await readProposals();
    // Neither a junk proposal (deferred) NOR an unclassified one is emitted.
    expect(file.proposals).toHaveLength(0);
  });

  test("a duplicate-group member (kept or removed) is NOT unclassified", async () => {
    // Two identical files matching no rule pattern. They ARE a recognized
    // duplicate group, so NEITHER copy is flagged unclassified — even though
    // firstMatch is null for both (no duplicate-killer preset here).
    await writeConfig({ presets: ["junk-sweep"], backlogPolicy: "include-existing", epochMs: EPOCH });
    const a = join(watched, "data-a.dat");
    const b = join(watched, "data-b.dat");
    await writeFile(a, "identical-payload");
    await writeFile(b, "identical-payload");
    const t = new Date(EPOCH + 60_000);
    await utimes(a, t, t);
    await utimes(b, t, t);
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    // 3 ticks: stable (t1) → hashed into cache (t2) → dupeHashes populated (t3).
    await tickN(d, 3);
    const file = await readProposals();
    expect(file.proposals.some((p) => p.kind === "unclassified")).toBe(false);
  });

  test("junk + duplicate + unknown folder: ONLY the unknown file is unclassified", async () => {
    // The end-to-end seed scenario. junk-tmp (deferred-fresh), a dup pair,
    // and a genuinely-unrecognized file all live together. Exactly one
    // unclassified proposal — for `mystery.xyz` — must result.
    await writeConfig({ presets: ["junk-sweep"], backlogPolicy: "include-existing", epochMs: EPOCH });
    const tmp = join(watched, "fresh-save.tmp");
    const dupA = join(watched, "data-copy-a.txt");
    const dupB = join(watched, "data-copy-b.txt");
    const unknown = join(watched, "mystery.xyz");
    await writeFile(tmp, "writing");
    await writeFile(dupA, "same-bytes");
    await writeFile(dupB, "same-bytes");
    await writeFile(unknown, "who-am-i");
    const fresh = new Date(EPOCH + 500); // tmp inside the dwell window
    await utimes(tmp, fresh, fresh);
    const newer = new Date(EPOCH + 60_000);
    for (const f of [dupA, dupB, unknown]) await utimes(f, newer, newer);
    const d = makeDaemon({ settings: { stabilityTicks: 1 }, now: () => EPOCH + 1000 });
    await tickN(d, 3); // 3 ticks so the dup hashes are in the cache
    const file = await readProposals();
    const unc = file.proposals.filter((p) => p.kind === "unclassified");
    expect(unc).toHaveLength(1);
    expect(unc[0]!.src).toBe(unknown);
  });
});

describe("daemon — safety", () => {
  test("NEVER descends into .ezcorp/data", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    // Put a junk file inside a nested .ezcorp/data under the watched root.
    const evil = join(watched, ".ezcorp", "data");
    await mkdir(evil, { recursive: true });
    await writeFile(join(evil, "secret.tmp"), "secret");
    await writeFile(join(watched, "ok.tmp"), "ok");
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    const file = await readProposals();
    expect(file.proposals.every((p) => !p.src.includes(".ezcorp"))).toBe(true);
    expect(file.proposals).toHaveLength(1);
  });

  test("unreachable watch root holds the folder (fail-closed)", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    await rm(watched, { recursive: true, force: true }); // mount vanished
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    // No proposals generated; nothing mass-quarantined.
    expect((await readProposals()).proposals).toHaveLength(0);
  });

  test("corrupt proposals.json recovers to empty + sidecars the original", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    await writeFile(join(dataDir, "proposals.json"), "{ not json");
    await writeFile(join(watched, "j.tmp"), "x");
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    const file = await readProposals();
    // Recovered + generated a fresh proposal.
    expect(file.proposals).toHaveLength(1);
    // A sidecar of the corrupt original exists.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dataDir);
    expect(entries.some((e) => e.startsWith("proposals.json.corrupt-"))).toBe(true);
  });

  test("non-reentrant tick: a concurrent tick is a no-op", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    await writeFile(join(watched, "j.tmp"), "x");
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await d.tick();
    // Fire two ticks concurrently — the second should short-circuit.
    const [a, b] = await Promise.all([d.tick(), d.tick()]);
    const generated = a.generated + b.generated;
    expect(generated).toBeLessThanOrEqual(1); // never double-generates
  });

  test("engine deny ⇒ proposal blocked in auto mode (file intact)", async () => {
    await writeConfig({ mode: "fully-auto", presets: ["junk-sweep"] });
    await writeFile(join(watched, "j.tmp"), "x");
    const d = makeDaemon({ engine: fakeEngine("deny"), settings: { stabilityTicks: 1, defaultMode: "ask-everything" } });
    await tickN(d, 2);
    const file = await readProposals();
    expect(file.proposals[0]!.status).toBe("blocked");
    expect(await Bun.file(join(watched, "j.tmp")).exists()).toBe(true);
  });

  test("invalidates all 3 pages each tick", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    const invalidations: string[] = [];
    const d = makeDaemon({ settings: { stabilityTicks: 1 }, invalidations });
    await d.tick();
    expect(new Set(invalidations)).toEqual(new Set(["overview", "review", "folders"]));
  });

  test("writes a badge with the pending count", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    await writeFile(join(watched, "j.tmp"), "x");
    const d = makeDaemon({ settings: { stabilityTicks: 1 } });
    await tickN(d, 2);
    const badge = JSON.parse(await readFile(join(dataDir, "badge.json"), "utf8"));
    expect(badge.pending).toBe(1);
    expect(badge.lastScanAt).toBeTruthy();
  });
});

describe("daemon — lifecycle", () => {
  test("start() respects the kill-switch", async () => {
    const prev = process.env.EZCORP_DISABLE_FILE_ORGANIZER_DAEMON;
    process.env.EZCORP_DISABLE_FILE_ORGANIZER_DAEMON = "1";
    try {
      const d = makeDaemon();
      expect(await d.start({ ...DEFAULT_SETTINGS })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.EZCORP_DISABLE_FILE_ORGANIZER_DAEMON;
      else process.env.EZCORP_DISABLE_FILE_ORGANIZER_DAEMON = prev;
    }
  });

  test("start() refuses when daemon_enabled is false", async () => {
    const d = makeDaemon();
    expect(await d.start({ ...DEFAULT_SETTINGS, daemonEnabled: false })).toBe(false);
  });

  test("start()/stop() arm + clear the interval", async () => {
    await writeConfig();
    const d = makeDaemon();
    const ok = await d.start({ ...DEFAULT_SETTINGS, scanIntervalSec: 5 });
    expect(ok).toBe(true);
    d.stop();
  });

  test("start() acquires + releases the real PID lockfile (skipLockfile off)", async () => {
    await writeConfig();
    // skipLockfile defaults to false here → start() exercises the
    // lockfilePath getter + acquireLockfile + the on-stop release.
    const d = new FileOrganizerDaemon({
      dataDir,
      engine: fakeEngine("allow"),
      extensionId: "ext-fo",
      getSettings: async () => ({ ...DEFAULT_SETTINGS }),
      wakeIntervalMsOverride: 50_000,
    });
    const ok = await d.start({ ...DEFAULT_SETTINGS, scanIntervalSec: 5 });
    expect(ok).toBe(true);
    expect(await Bun.file(join(dataDir, ".daemon.pid")).exists()).toBe(true);
    d.stop();
    // stop() releases the lockfile fire-and-forget (void releaseLockfile);
    // let the microtask + unlink settle before asserting removal.
    await new Promise((r) => setTimeout(r, 30));
    expect(await Bun.file(join(dataDir, ".daemon.pid")).exists()).toBe(false);
  });

  test("the armed interval actually fires a tick", async () => {
    await writeConfig({ presets: ["junk-sweep"] });
    await writeFile(join(watched, "j.tmp"), "x");
    // A tiny wake interval + a clock past the dwell window so the timer
    // callback (setInterval body) runs a real tick and proposes the junk.
    const d = new FileOrganizerDaemon({
      dataDir,
      engine: fakeEngine("allow"),
      extensionId: "ext-fo",
      getSettings: async () => ({ ...DEFAULT_SETTINGS, stabilityTicks: 1 }),
      now: () => Date.now() + 60 * 60 * 1000,
      skipLockfile: true,
      wakeIntervalMsOverride: 10,
    });
    await d.start({ ...DEFAULT_SETTINGS, stabilityTicks: 1 });
    // Two wake cycles: the first records stability, the second proposes.
    await new Promise((r) => setTimeout(r, 60));
    d.stop();
    const file = await readProposals();
    expect(file.proposals.length).toBeGreaterThan(0);
  });

  test("constructed without `now` defaults to Date.now (no crash on tick)", async () => {
    await writeConfig();
    // No `now` injected → the `opts.now ?? Date.now` fallback is taken.
    const d = new FileOrganizerDaemon({
      dataDir,
      engine: fakeEngine("allow"),
      extensionId: "ext-fo",
      getSettings: async () => ({ ...DEFAULT_SETTINGS, stabilityTicks: 1 }),
      skipLockfile: true,
    });
    const res = await d.tick();
    expect(res).toEqual({ generated: 0, applied: 0, pruned: 0 });
  });

  test("_readlinkSafe returns the target for a symlink, null otherwise", async () => {
    const { symlink } = await import("node:fs/promises");
    const target = join(watched, "target.txt");
    await writeFile(target, "x");
    const link = join(watched, "link.txt");
    await symlink(target, link);
    const d = makeDaemon();
    expect(await d._readlinkSafe(link)).toBe(target);
    expect(await d._readlinkSafe(join(watched, "not-a-link.txt"))).toBeNull();
  });

  test("clampInterval clamps to [5, 3600]", () => {
    expect(_fileOrganizerDaemonInternals.clampInterval(1)).toBe(5);
    expect(_fileOrganizerDaemonInternals.clampInterval(99999)).toBe(3600);
    expect(_fileOrganizerDaemonInternals.clampInterval(45)).toBe(45);
    expect(_fileOrganizerDaemonInternals.clampInterval(NaN)).toBe(DEFAULT_SETTINGS.scanIntervalSec);
  });
});

// ── PID lockfile lifecycle (the sibling-prevention primitive) ───────
//
// Every other test runs with `skipLockfile:true`, so the acquire/stale-
// overwrite/release path was 0% covered. Exercise it directly against a
// real lockfile + real PIDs. The stale-overwrite case is the safety-
// critical one: a daemon that crashed (or a garbage PID) must NOT
// permanently wedge the watcher.
describe("PID lockfile lifecycle", () => {
  const { acquireLockfile, isProcessAlive, releaseLockfile } = _fileOrganizerDaemonInternals;

  /** Stored-PID of a lockfile body in the new `<pid> <token>` format. */
  const storedPid = (body: string): number => parseInt(body.trim().split(/\s+/)[0]!, 10);

  test("isProcessAlive: live PID true, garbage/dead PID false", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(NaN)).toBe(false);
    // A PID that is exceedingly unlikely to be live (max pid + slack).
    expect(isProcessAlive(2 ** 31 - 1)).toBe(false);
  });

  test("a genuine live-sibling lockfile (foreign PID + matching token) is NOT acquired", async () => {
    // PID-reuse-safe: a sibling is a live FOREIGN process whose stored
    // identity token still matches. PID 1 is always alive on Linux; stamp
    // its real /proc start-time so the recompute matches → refuse.
    const lock = join(dataDir, ".daemon.pid");
    const token = readProcStartTime(1);
    await writeFile(lock, `1 ${token}`);
    expect(await acquireLockfile(lock)).toBe(false);
    // The live lock is left untouched.
    expect((await readFile(lock, "utf8")).trim()).toBe(`1 ${token}`);
  });

  test("a stale lockfile holding OUR OWN reused PID is reclaimed (cross-restart fix)", async () => {
    // The bug: a `.pid` left by a prior boot whose PID got reused as ours
    // used to wedge start forever. It must now be reclaimed.
    const lock = join(dataDir, ".daemon.pid");
    await writeFile(lock, `${process.pid} prior-boot-token`);
    expect(await acquireLockfile(lock)).toBe(true);
    expect(storedPid(await readFile(lock, "utf8"))).toBe(process.pid);
  });

  test("a stale (dead) PID lockfile is overwritten + acquired", async () => {
    const lock = join(dataDir, ".daemon.pid");
    await writeFile(lock, "2147483646 some-token"); // an effectively-dead PID
    expect(await acquireLockfile(lock)).toBe(true);
    expect(storedPid(await readFile(lock, "utf8"))).toBe(process.pid);
  });

  test("a garbage (non-numeric) PID lockfile is overwritten + acquired", async () => {
    const lock = join(dataDir, ".daemon.pid");
    await writeFile(lock, "not-a-pid");
    expect(await acquireLockfile(lock)).toBe(true);
    expect(storedPid(await readFile(lock, "utf8"))).toBe(process.pid);
  });

  test("acquiring a fresh lockfile (none present) succeeds + stamps our PID", async () => {
    const lock = join(dataDir, "fresh.pid");
    expect(await acquireLockfile(lock)).toBe(true);
    expect(storedPid(await readFile(lock, "utf8"))).toBe(process.pid);
  });

  test("releaseLockfile removes the file (and is a no-op when already gone)", async () => {
    const lock = join(dataDir, ".daemon.pid");
    await writeFile(lock, String(process.pid));
    await releaseLockfile(lock);
    expect(await Bun.file(lock).exists()).toBe(false);
    // Idempotent — releasing an already-gone lock never throws.
    await releaseLockfile(lock);
    expect(await Bun.file(lock).exists()).toBe(false);
  });
});

describe("daemon — idempotent routing (no re-route churn)", () => {
  // A `route` rule moves a file INTO a destination subfolder inside the
  // watched root. On a later tick the walker descends into that subfolder;
  // without the idempotency guard the same rule re-matches the already-routed
  // file and the non-overwrite resolver re-moves it to `… (2).png`, then
  // `… (2) (2).png`… forever. These assert the fixed-point behavior.

  /** Recursively collect basenames under `dir`. */
  async function allNames(dir: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const out: string[] = [];
    const ents = await readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      if (e.isDirectory()) out.push(...(await allNames(join(dir, e.name))));
      else out.push(e.name);
    }
    return out;
  }

  test("fully-auto: a routed file reaches a fixed point — moved EXACTLY once, never re-suffixed across many ticks", async () => {
    await writeConfig({ mode: "fully-auto", presets: ["downloads-router"] });
    await writeFile(join(watched, "screenshot.png"), "img");
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "fully-auto" } });
    // Many ticks: tick 1 records stability, tick 2 routes it; remaining ticks
    // re-scan Images/ and must NOT re-route (idempotent fixed point).
    await tickN(d, 6);
    // The file lives at its destination, ONCE.
    expect(await Bun.file(join(watched, "Images", "screenshot.png")).exists()).toBe(true);
    expect(await Bun.file(join(watched, "screenshot.png")).exists()).toBe(false);
    // No churn artifact ever appeared anywhere under the watched root.
    const names = await allNames(watched);
    expect(names).toContain("screenshot.png");
    expect(names.filter((n) => n === "screenshot.png")).toHaveLength(1);
    expect(names.some((n) => /\(\d+\)/.test(n))).toBe(false);
    // Exactly one move proposal was ever generated for this file.
    const moves = (await readProposals()).proposals.filter((p) => p.kind === "move");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.status).toBe("applied");
  });

  test("approve-non-destructive-only: routed file also reaches a fixed point (no growing suffix)", async () => {
    await writeConfig({ mode: "approve-non-destructive-only", presets: ["downloads-router"] });
    await writeFile(join(watched, "doc.pdf"), "pdf");
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "ask-everything" } });
    await tickN(d, 6);
    expect(await Bun.file(join(watched, "Documents", "doc.pdf")).exists()).toBe(true);
    const names = await allNames(watched);
    expect(names.filter((n) => n === "doc.pdf")).toHaveLength(1);
    expect(names.some((n) => /\(\d+\)/.test(n))).toBe(false);
    const moves = (await readProposals()).proposals.filter((p) => p.kind === "move");
    expect(moves).toHaveLength(1);
  });

  test("a file PRE-PLACED in its destination dir is never proposed for routing", async () => {
    await writeConfig({ presets: ["downloads-router"], backlogPolicy: "include-existing" });
    // Already sitting in Images/ — must not be re-routed even once.
    await mkdir(join(watched, "Images"), { recursive: true });
    await writeFile(join(watched, "Images", "already.png"), "img");
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "ask-everything" } });
    await tickN(d, 3);
    const moves = (await readProposals()).proposals.filter((p) => p.kind === "move");
    expect(moves).toHaveLength(0);
    // File untouched, no suffix sibling created.
    expect(await Bun.file(join(watched, "Images", "already.png")).exists()).toBe(true);
    const names = await allNames(watched);
    expect(names.some((n) => /\(\d+\)/.test(n))).toBe(false);
  });

  test("ask-everything: a file already at its destination produces no redundant move proposal", async () => {
    await writeConfig({ presets: ["downloads-router"], backlogPolicy: "include-existing" });
    await mkdir(join(watched, "Archives"), { recursive: true });
    await writeFile(join(watched, "Archives", "bundle.zip"), "zip");
    // A second zip NOT yet routed — control: it SHOULD propose a move.
    await writeFile(join(watched, "loose.zip"), "zip2");
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "ask-everything" } });
    await tickN(d, 2);
    const moves = (await readProposals()).proposals.filter((p) => p.kind === "move");
    // Only the loose zip proposes a move; the already-routed one does not.
    expect(moves).toHaveLength(1);
    expect(moves[0]!.src).toBe(join(watched, "loose.zip"));
    expect(moves[0]!.dst).toBe(join(watched, "Archives", "loose.zip"));
  });
});

describe("daemon — circuit breaker pauses a runaway destructive rule", () => {
  /** A broad mini-DSL-style custom rule: `* -> quarantine`. */
  const broadQuarantineRule = {
    id: "dsl-broadq",
    label: "* -> quarantine",
    action: "quarantine",
    predicate: { glob: "*" },
    destructive: true,
  };

  test("fully-auto: a `* -> quarantine` rule over many files trips the breaker → ZERO quarantined, folder intact", async () => {
    await writeConfig({ mode: "fully-auto", customRules: [broadQuarantineRule], backlogPolicy: "include-existing" });
    const names = ["a.dat", "b.dat", "c.dat", "d.dat", "e.dat"];
    for (const n of names) await writeFile(join(watched, n), n);
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "fully-auto" } });
    await tickN(d, 2); // tick 1 stability, tick 2 would mass-quarantine without the brake
    // Breaker tripped: no proposals queued, nothing applied.
    const props = await readProposals();
    expect(props.proposals.filter((p) => p.kind === "delete-quarantine")).toHaveLength(0);
    // Every file is still on disk (folder fully intact).
    for (const n of names) {
      expect(await Bun.file(join(watched, n)).exists()).toBe(true);
    }
    // Nothing was quarantined.
    const manifestPath = join(dataDir, ".trash", "manifest.json");
    if (await Bun.file(manifestPath).exists()) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.entries.length).toBe(0);
    }
  });

  test("a narrow destructive rule matching a small fraction is UNAFFECTED (still proposes/applies)", async () => {
    // junk-sweep's *.bak over a folder where only 1 of 5 files is a .bak:
    // 1/5 = 0.2 ≤ 0.5 and matched < 2 → breaker does not trip.
    await writeConfig({ mode: "fully-auto", presets: ["junk-sweep"], backlogPolicy: "include-existing" });
    await writeFile(join(watched, "keep1.txt"), "x");
    await writeFile(join(watched, "keep2.txt"), "x");
    await writeFile(join(watched, "keep3.txt"), "x");
    await writeFile(join(watched, "keep4.txt"), "x");
    await writeFile(join(watched, "old.bak"), "junk");
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "fully-auto" } });
    await tickN(d, 2);
    // The single .bak WAS quarantined; the others are untouched.
    expect(await Bun.file(join(watched, "old.bak")).exists()).toBe(false);
    expect(await Bun.file(join(watched, "keep1.txt")).exists()).toBe(true);
    const dels = (await readProposals()).proposals.filter((p) => p.kind === "delete-quarantine");
    expect(dels).toHaveLength(1);
    expect(dels[0]!.status).toBe("applied");
  });

  test("non-destructive routes are NEVER throttled by the breaker even over a whole folder", async () => {
    // downloads-router moving ALL 4 pngs (4/4 = 1.0 > 0.5) must still run —
    // the breaker only guards DESTRUCTIVE rules.
    await writeConfig({ mode: "fully-auto", presets: ["downloads-router"], backlogPolicy: "include-existing" });
    const pngs = ["p1.png", "p2.png", "p3.png", "p4.png"];
    for (const n of pngs) await writeFile(join(watched, n), n);
    const d = makeDaemon({ settings: { stabilityTicks: 1, defaultMode: "fully-auto" } });
    await tickN(d, 2);
    for (const n of pngs) {
      expect(await Bun.file(join(watched, "Images", n)).exists()).toBe(true);
      expect(await Bun.file(join(watched, n)).exists()).toBe(false);
    }
  });
});

describe("mergeFileOrganizerSettings", () => {
  test("manifest defaults resolve with no stored values", () => {
    const declared = {
      daemon_enabled: true,
      default_mode: "ask-everything",
      quarantine_ttl_days: 30,
      quarantine_cap_gb: 5,
      scan_interval_sec: 45,
      stability_ticks: 2,
    };
    expect(mergeFileOrganizerSettings(declared, {})).toEqual(DEFAULT_SETTINGS);
  });

  test("stored values override declared defaults", () => {
    const declared = { default_mode: "ask-everything", scan_interval_sec: 45 };
    const merged = mergeFileOrganizerSettings(declared, { default_mode: "fully-auto", scan_interval_sec: 10 });
    expect(merged.defaultMode).toBe("fully-auto");
    expect(merged.scanIntervalSec).toBe(10);
  });

  test("garbage values fall back to DEFAULT_SETTINGS per-field", () => {
    const merged = mergeFileOrganizerSettings(
      {},
      { default_mode: "bogus", scan_interval_sec: "not a number", daemon_enabled: "yes", quarantine_ttl_days: NaN },
    );
    expect(merged.defaultMode).toBe(DEFAULT_SETTINGS.defaultMode);
    expect(merged.scanIntervalSec).toBe(DEFAULT_SETTINGS.scanIntervalSec);
    expect(merged.daemonEnabled).toBe(DEFAULT_SETTINGS.daemonEnabled);
    expect(merged.quarantineTtlDays).toBe(DEFAULT_SETTINGS.quarantineTtlDays);
  });

  test("empty inputs yield the hardcoded defaults", () => {
    expect(mergeFileOrganizerSettings({}, {})).toEqual(DEFAULT_SETTINGS);
  });
});

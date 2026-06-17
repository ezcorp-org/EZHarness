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

function makeDaemon(opts: { settings?: Partial<FileOrganizerSettings>; engine?: PermissionEngine; now?: () => number; invalidations?: string[] } = {}): FileOrganizerDaemon {
  const settings: FileOrganizerSettings = { ...DEFAULT_SETTINGS, scanIntervalSec: 5, stabilityTicks: 1, ...opts.settings };
  return new FileOrganizerDaemon({
    dataDir,
    engine: opts.engine ?? fakeEngine("allow"),
    extensionId: "ext-fo",
    getSettings: async () => settings,
    invalidatePage: opts.invalidations ? (p) => opts.invalidations!.push(p) : undefined,
    now: opts.now,
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

  test("clampInterval clamps to [5, 3600]", () => {
    expect(_fileOrganizerDaemonInternals.clampInterval(1)).toBe(5);
    expect(_fileOrganizerDaemonInternals.clampInterval(99999)).toBe(3600);
    expect(_fileOrganizerDaemonInternals.clampInterval(45)).toBe(45);
    expect(_fileOrganizerDaemonInternals.clampInterval(NaN)).toBe(DEFAULT_SETTINGS.scanIntervalSec);
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

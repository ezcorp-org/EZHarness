// Security guarantees for the file-organizer bundled extension.
//
//   1. NO CALLS HOME — the subprocess has no `network` grant, so the
//      sandbox-preload blocks fetch/http even though the extension's job
//      is filesystem organization. (sb2-network-egress pattern.)
//   2. SUBPROCESS fs is `$CWD`-only — a host folder OUTSIDE the grant is
//      denied by the host fs-handler, proving only the HOST daemon/applier
//      (raw node:fs) ever touch Desktop/Downloads.
//   3. FAIL-CLOSED on a missing watch root / degraded mount — the daemon
//      never reads a disconnected mount as "all files deleted" and never
//      mass-quarantines.
//   4. HOST-APPLIER PATH CONTAINMENT — the applier is the one place that
//      touches host folders with raw `node:fs`, so every path it acts on
//      (proposal SOURCE, destination, journal entry, quarantine id,
//      restore source) is canonicalized and contained before the op. The
//      suites at the bottom of this file are the exploit set that proved
//      those gaps; each one moved/read/deleted a host file it was never
//      granted before the guards landed.
//
// Tests for the file-organizer architecture spine (see
// tasks/file-organizer-plan.md § "two architecture-defining constraints").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, symlink, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileOrganizerDaemon, DEFAULT_SETTINGS } from "../../extensions/file-organizer-daemon";
import {
  applyProposal,
  replayJournal,
  restoreFromQuarantine,
  hardDeleteTrash,
  _applierInternals,
  type ApplierContext,
  type ApplierProposal,
} from "../../extensions/file-organizer-applier";
import type { PermissionEngine } from "../../extensions/permission-engine";

const SANDBOX_PRELOAD_PATH = resolve(import.meta.dir, "../../extensions/runtime/sandbox-preload.ts");
const NETWORK_DENY = /requires 'network' permission/;

function fakeEngine(decision: "allow" | "deny" = "allow"): PermissionEngine {
  return {
    authorize: async () =>
      decision === "allow" ? { decision: "allow", auditId: "a" } : { decision: "deny", reason: "deny", auditId: "ad" },
  } as unknown as PermissionEngine;
}

// ── 1. No calls home (no network grant) ─────────────────────────────

async function runUnderPreload(code: string, networkAllowed = false): Promise<{ stdout: string; exitCode: number }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  if (networkAllowed) env.EZCORP_NETWORK_ALLOWED = "1";
  const proc = Bun.spawn(["bun", "--preload", SANDBOX_PRELOAD_PATH, "-e", code], { stdout: "pipe", stderr: "pipe", env });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

const probe = (expr: string) =>
  `try { ${expr}; console.log("OK"); } catch (e) { console.log("ERR:" + (e?.message ?? String(e))); }`;

describe("file-organizer: no calls home (no network grant)", () => {
  test("fetch() is denied in the sandbox (the extension declares no network)", async () => {
    const out = await runUnderPreload(probe(`fetch('http://example.com/')`), false);
    expect(out.stdout).toMatch(NETWORK_DENY);
    expect(out.stdout).not.toMatch(/^OK$/m);
  });

  test("require('http') is denied in the sandbox", async () => {
    const out = await runUnderPreload(probe(`require('http').request`), false);
    expect(out.stdout).toMatch(NETWORK_DENY);
  });

  test("require('dns') is denied (no DNS lookups either)", async () => {
    const out = await runUnderPreload(probe(`require('dns').lookup`), false);
    expect(out.stdout).toMatch(NETWORK_DENY);
  });
});

// ── 2 + 3. Host-side fs containment + fail-closed ───────────────────

let root: string;
let dataDir: string;
let watched: string;

beforeEach(async () => {
  // realpath the fixture root: the containment guards canonicalize every
  // path they check, so a symlinked `$TMPDIR` would otherwise make an
  // in-root fixture look out-of-root.
  root = await realpath(await mkdtemp(join(tmpdir(), "fo-sec-")));
  dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
  watched = join(root, "watched");
  await mkdir(join(dataDir, ".trash"), { recursive: true });
  await mkdir(watched, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctx(watchedRoot: string, engine?: PermissionEngine): ApplierContext {
  return {
    extensionId: "ext-fo",
    userId: "u1",
    conversationId: null,
    engine: engine ?? fakeEngine("allow"),
    trashRoot: join(dataDir, ".trash"),
    journalPath: join(dataDir, "journal.json"),
    watchedRoot,
    dataDirRoot: dataDir,
  };
}

describe("host applier: destination containment (only the host touches host folders)", () => {
  test("a move whose destination escapes the watched root is BLOCKED", async () => {
    const src = join(watched, "a.txt");
    await writeFile(src, "x");
    // dst is OUTSIDE the watched root — an attempt to write a host folder
    // the extension was never granted.
    const p: ApplierProposal = { id: "p", kind: "move", src, dst: join(root, "escape", "a.txt"), snapshot: { size: 1, mtimeMs: 0, isSymlink: false, nlink: 1 } };
    const outcome = await applyProposal(p, ctx(watched));
    expect(outcome.status).toBe("blocked");
    expect(await Bun.file(src).exists()).toBe(true); // original intact
  });

  test("a move targeting .ezcorp/data is BLOCKED (never write the DB/JWT dir)", async () => {
    const src = join(watched, "a.txt");
    await writeFile(src, "x");
    const p: ApplierProposal = { id: "p", kind: "move", src, dst: join(watched, ".ezcorp", "data", "a.txt"), snapshot: { size: 1, mtimeMs: 0, isSymlink: false, nlink: 1 } };
    const outcome = await applyProposal(p, ctx(watched));
    expect(outcome.status).toBe("blocked");
  });

  test("engine deny ⇒ blocked (every apply re-authorizes; no stale-auth write)", async () => {
    const src = join(watched, "a.txt");
    await writeFile(src, "x");
    const p: ApplierProposal = { id: "p", kind: "move", src, dst: join(watched, "sub", "a.txt"), snapshot: { size: 1, mtimeMs: 0, isSymlink: false, nlink: 1 } };
    const outcome = await applyProposal(p, ctx(watched, fakeEngine("deny")));
    expect(outcome.status).toBe("blocked");
    expect(await Bun.file(src).exists()).toBe(true);
  });
});

describe("daemon: fail-closed (degraded mount never mass-quarantines)", () => {
  async function writeConfig(): Promise<void> {
    await writeFile(
      join(dataDir, "config.json"),
      JSON.stringify({
        folders: [{ id: "f1", path: watched, presets: ["junk-sweep"], customRules: [], ignore: [], backlogPolicy: "include-existing" }],
        globalIgnore: [".ezcorp/data", ".git", "node_modules"],
        schemaVersion: 1,
      }),
    );
  }

  function daemon(): FileOrganizerDaemon {
    return new FileOrganizerDaemon({
      dataDir,
      engine: fakeEngine("allow"),
      extensionId: "ext-fo",
      getSettings: async () => ({ ...DEFAULT_SETTINGS, stabilityTicks: 1 }),
      skipLockfile: true,
      // The junk-tmp preset carries a ~10m dwell guard (atomic-writer
      // safety). The fixture `.tmp` is freshly written, so advance the
      // clock past the dwell window to keep the "a normal tick WOULD
      // propose it" baseline meaningful for the fail-closed assertion.
      now: () => Date.now() + 60 * 60 * 1000,
    });
  }

  test("a vanished watch root yields ZERO proposals (not a mass-delete)", async () => {
    await writeConfig();
    // Seed a junk file, prove a normal tick WOULD propose it.
    await writeFile(join(watched, "junk.tmp"), "j");
    const d = daemon();
    await d.tick();
    await d.tick();
    const before = JSON.parse(await readFile(join(dataDir, "proposals.json"), "utf8"));
    expect(before.proposals.length).toBeGreaterThan(0);

    // Now the mount disappears (degraded/disconnected). The daemon must
    // NOT read this as "every watched file is gone" and quarantine them.
    await rm(watched, { recursive: true, force: true });
    const d2 = daemon();
    const result = await d2.tick();
    expect(result.generated).toBe(0);
    // No NEW destructive proposals were generated from the disconnect.
    const after = JSON.parse(await readFile(join(dataDir, "proposals.json"), "utf8"));
    expect(after.proposals.length).toBe(before.proposals.length);
  });

  test("an unwritable / missing trash root holds the delete (engine deny ⇒ blocked, file kept)", async () => {
    // Simulate the quarantine being unreachable by denying the write.
    const src = join(watched, "junk.tmp");
    await writeFile(src, "j");
    const p: ApplierProposal = { id: "p", kind: "delete-quarantine", src, dst: null, snapshot: { size: 1, mtimeMs: 0, isSymlink: false, nlink: 1 } };
    const outcome = await applyProposal(p, ctx(watched, fakeEngine("deny")));
    expect(outcome.status).toBe("blocked");
    expect(await Bun.file(src).exists()).toBe(true);
  });
});

// ── 4. Host-applier path containment (the exploit set) ──────────────
//
// Every test below is a reproduced attack. The shape they share: the
// applier used to containment-check the DESTINATION only, so a proposal
// (or a journal entry, or a manifest row) that named a SOURCE outside the
// watched root got an arbitrary host-file read AND delete for free.

/** A junk-quarantine proposal whose src the caller chooses. */
function quarantineOf(src: string, quarantineId?: string): ApplierProposal {
  return {
    id: "p-exploit",
    kind: "delete-quarantine",
    src,
    dst: null,
    ...(quarantineId === undefined ? {} : { quarantineId }),
    snapshot: { size: 1, mtimeMs: 0, isSymlink: false, nlink: 1 },
  };
}

/** Everything currently sitting in `.trash/` (minus the manifest). */
async function trashEntries(trashRoot: string): Promise<string[]> {
  return (await readdir(trashRoot)).filter((n) => n !== "manifest.json");
}

describe("host applier: SOURCE containment (a proposal's src is not a free read/delete)", () => {
  test("a delete-quarantine whose src is inside .ezcorp/data is BLOCKED", async () => {
    // The watched root is the project root itself, so the DB dir is
    // "inside" the watched root — only the protected-dir deny stops this.
    const dbFile = join(root, ".ezcorp", "data", "ez-corp-db");
    await mkdir(join(root, ".ezcorp", "data"), { recursive: true });
    await writeFile(dbFile, "PGDATA+jwt-secret");
    const outcome = await applyProposal(quarantineOf(dbFile), ctx(root));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("protected");
    // The database is still on disk and nothing was staged into the
    // extension's own (extension-readable) trash.
    expect(await readFile(dbFile, "utf8")).toBe("PGDATA+jwt-secret");
    expect(await trashEntries(join(dataDir, ".trash"))).toEqual([]);
  });

  test("a delete-quarantine whose src is OUTSIDE the watched root is BLOCKED", async () => {
    const secret = join(root, "outside", "id_ed25519");
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(secret, "PRIVATE KEY");
    const outcome = await applyProposal(quarantineOf(secret), ctx(watched));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("escapes the watched root");
    expect(await readFile(secret, "utf8")).toBe("PRIVATE KEY");
    expect(await trashEntries(join(dataDir, ".trash"))).toEqual([]);
  });

  test("a move whose src climbs out with `..` is BLOCKED (no exfil into the watched root)", async () => {
    const secret = join(root, "secret.txt");
    await writeFile(secret, "sekrit");
    const p: ApplierProposal = {
      id: "p",
      kind: "move",
      // Escapes upward; the destination stays legitimately in-root, which
      // is exactly what the destination-only check could not see.
      src: join(watched, "..", "secret.txt"),
      dst: join(watched, "stolen.txt"),
      snapshot: { size: 6, mtimeMs: 0, isSymlink: false, nlink: 1 },
    };
    const outcome = await applyProposal(p, ctx(watched));
    expect(outcome.status).toBe("blocked");
    expect(await readFile(secret, "utf8")).toBe("sekrit");
    expect(await Bun.file(join(watched, "stolen.txt")).exists()).toBe(false);
  });

  test("a move whose src traverses a SYMLINKED ancestor is BLOCKED", async () => {
    // No `..` anywhere in this path — only a realpath of the PARENT can
    // see that `watched/hop/` leaves the watched root.
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "sekrit");
    await symlink(outside, join(watched, "hop"));
    const p: ApplierProposal = {
      id: "p",
      kind: "move",
      src: join(watched, "hop", "secret.txt"),
      dst: join(watched, "stolen.txt"),
      snapshot: { size: 6, mtimeMs: 0, isSymlink: false, nlink: 1 },
    };
    const outcome = await applyProposal(p, ctx(watched));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("escapes the watched root");
    expect(await readFile(secret, "utf8")).toBe("sekrit");
    expect(await Bun.file(join(watched, "stolen.txt")).exists()).toBe(false);
  });

  test("a lying snapshot (isSymlink:false on a real link) is still SKIPPED", async () => {
    // `snapshot` is caller-supplied; the live lstat is what decides.
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const target = join(outside, "secret.txt");
    await writeFile(target, "sekrit");
    const link = join(watched, "link.txt");
    await symlink(target, link);
    const p: ApplierProposal = {
      id: "p",
      kind: "move",
      src: link,
      dst: join(watched, "sub", "copy.txt"),
      snapshot: { size: 6, mtimeMs: 0, isSymlink: false, nlink: 1 },
    };
    const outcome = await applyProposal(p, ctx(watched));
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("symlink skipped");
    // Link intact, target intact, nothing copied out.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("sekrit");
    expect(await Bun.file(join(watched, "sub", "copy.txt")).exists()).toBe(false);
  });

  test("an in-root move and an in-root quarantine still APPLY (guard is not a wall)", async () => {
    const moving = join(watched, "a.txt");
    await writeFile(moving, "hello");
    const moved = await applyProposal(
      { id: "m", kind: "move", src: moving, dst: join(watched, "sub", "a.txt"), snapshot: { size: 5, mtimeMs: 0, isSymlink: false, nlink: 1 } },
      ctx(watched),
    );
    expect(moved.status).toBe("applied");
    expect(await readFile(moved.resolvedPath!, "utf8")).toBe("hello");

    const junk = join(watched, "junk.tmp");
    await writeFile(junk, "j");
    const quarantined = await applyProposal(quarantineOf(junk, "q-ok"), ctx(watched));
    expect(quarantined.status).toBe("applied");
    expect(await readFile(quarantined.resolvedPath!, "utf8")).toBe("j");
  });

  test("a SYMLINKED watched root still applies an in-root move (canonical anchor)", async () => {
    // Desktop → /mnt/data/Desktop is an ordinary layout. Anchoring the
    // prefix compare on the RAW root made every canonicalized in-root
    // destination look like an escape.
    const real = join(root, "real-watched");
    await mkdir(join(real, "sub"), { recursive: true });
    const link = join(root, "linked-watched");
    await symlink(real, link);
    const src = join(link, "a.txt");
    await writeFile(src, "hello");
    const outcome = await applyProposal(
      { id: "m", kind: "move", src, dst: join(link, "sub", "a.txt"), snapshot: { size: 5, mtimeMs: 0, isSymlink: false, nlink: 1 } },
      ctx(link),
    );
    expect(outcome.status).toBe("applied");
    expect(await readFile(join(real, "sub", "a.txt"), "utf8")).toBe("hello");
  });

  test("a symlinked watched root also applies into a not-yet-created subdir", async () => {
    const real = join(root, "real-watched-2");
    await mkdir(real, { recursive: true });
    const link = join(root, "linked-watched-2");
    await symlink(real, link);
    const src = join(link, "b.txt");
    await writeFile(src, "bee");
    const outcome = await applyProposal(
      { id: "m", kind: "move", src, dst: join(link, "fresh", "b.txt"), snapshot: { size: 3, mtimeMs: 0, isSymlink: false, nlink: 1 } },
      ctx(link),
    );
    expect(outcome.status).toBe("applied");
    expect(await readFile(join(real, "fresh", "b.txt"), "utf8")).toBe("bee");
  });

  test("an unresolvable watched root refuses the apply (fail-closed anchor)", async () => {
    const src = join(watched, "a.txt");
    await writeFile(src, "x");
    const outcome = await applyProposal(
      { id: "m", kind: "move", src, dst: join(watched, "sub", "a.txt"), snapshot: { size: 1, mtimeMs: 0, isSymlink: false, nlink: 1 } },
      ctx(join(root, "no-such-root")),
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("no containment anchor");
    expect(await Bun.file(src).exists()).toBe(true);
  });

  test("a src whose PARENT is gone is stale-source, not a crash", async () => {
    const outcome = await applyProposal(
      quarantineOf(join(watched, "vanished-dir", "a.txt")),
      ctx(watched),
    );
    expect(outcome.status).toBe("stale-source");
  });
});

describe("host applier: quarantine id containment (nothing escaping reaches the manifest)", () => {
  test("a traversing quarantineId is BLOCKED before it can be recorded", async () => {
    const junk = join(watched, "junk.tmp");
    await writeFile(junk, "j");
    const outcome = await applyProposal(quarantineOf(junk, "../../../.."), ctx(watched));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("invalid quarantine id");
    // Nothing moved, and the escaping id never made it into a manifest row
    // for the pruner to read back.
    expect(await readFile(junk, "utf8")).toBe("j");
    expect(await trashEntries(join(dataDir, ".trash"))).toEqual([]);
  });

  test("an unresolvable trash root fails the quarantine (no anchor, no write)", async () => {
    const junk = join(watched, "junk.tmp");
    await writeFile(junk, "j");
    const c = { ...ctx(watched), trashRoot: join(root, "no-such-trash") };
    const outcome = await applyProposal(quarantineOf(junk, "q1"), c);
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("trash root unresolvable");
    expect(await readFile(junk, "utf8")).toBe("j");
  });
});

describe("host applier: hardDeleteTrash (the one recursive rm)", () => {
  test("a traversing id does NOT recursively delete the project root", async () => {
    const trashRoot = join(dataDir, ".trash");
    // `.trash` sits four levels under the fixture "project root", so this
    // id is the exact escape the Hub's "Empty quarantine" button used to
    // hand it.
    expect(await hardDeleteTrash(trashRoot, "../../../..")).toBe(false);
    expect(await _applierInternals.pathExists(root)).toBe(true);
    expect(await _applierInternals.pathExists(watched)).toBe(true);
    expect(await _applierInternals.pathExists(trashRoot)).toBe(true);
  });

  test("a `..`-free id that escapes through a planted symlink is REFUSED", async () => {
    const trashRoot = join(dataDir, ".trash");
    const victim = join(root, "outside", "victimdir");
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "keepme"), "keepme");
    await symlink(join(root, "outside"), join(trashRoot, "hop"));
    expect(await hardDeleteTrash(trashRoot, "hop/victimdir")).toBe(false);
    expect(await readFile(join(victim, "keepme"), "utf8")).toBe("keepme");
  });

  test("a trash entry that IS a symlink unlinks the LINK, never its target", async () => {
    const trashRoot = join(dataDir, ".trash");
    const outsideDir = join(root, "outside-target");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "keepme"), "keepme");
    const id = crypto.randomUUID();
    await symlink(outsideDir, join(trashRoot, id));
    expect(await hardDeleteTrash(trashRoot, id)).toBe(true);
    expect(await _applierInternals.pathExists(join(trashRoot, id))).toBe(false);
    expect(await readFile(join(outsideDir, "keepme"), "utf8")).toBe("keepme");
  });

  test("an unresolvable trash root refuses the prune", async () => {
    expect(await hardDeleteTrash(join(root, "no-such-trash"), "q1")).toBe(false);
  });

  test("a real quarantine dir is still removed, and an absent one is idempotent", async () => {
    const trashRoot = join(dataDir, ".trash");
    const id = crypto.randomUUID();
    await mkdir(join(trashRoot, id), { recursive: true });
    await writeFile(join(trashRoot, id, "a.txt"), "a");
    expect(await hardDeleteTrash(trashRoot, id)).toBe(true);
    expect(await _applierInternals.pathExists(join(trashRoot, id))).toBe(false);
    // Already gone ⇒ still true: the manifest row must drop either way.
    expect(await hardDeleteTrash(trashRoot, id)).toBe(true);
  });
});

describe("host applier: restore containment (the manifest is a file, not a trust root)", () => {
  test("a trashPath outside the trash root is BLOCKED", async () => {
    const loot = join(root, "outside", "loot.txt");
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(loot, "loot");
    const outcome = await restoreFromQuarantine(
      { trashPath: loot, restorePath: join(watched, "loot.txt") },
      ctx(watched),
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("escapes the trash root");
    expect(await readFile(loot, "utf8")).toBe("loot");
    expect(await Bun.file(join(watched, "loot.txt")).exists()).toBe(false);
  });

  test("an unresolvable trash root refuses the restore", async () => {
    const c = { ...ctx(watched), trashRoot: join(root, "no-such-trash") };
    const outcome = await restoreFromQuarantine(
      { trashPath: join(root, "no-such-trash", "q1", "a.txt"), restorePath: join(watched, "a.txt") },
      c,
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("no containment anchor");
  });

  test("a genuine quarantine entry still restores", async () => {
    const trashRoot = join(dataDir, ".trash");
    const id = crypto.randomUUID();
    await mkdir(join(trashRoot, id), { recursive: true });
    const trashed = join(trashRoot, id, "a.txt");
    await writeFile(trashed, "restored");
    const outcome = await restoreFromQuarantine(
      { trashPath: trashed, restorePath: join(watched, "a.txt") },
      ctx(watched),
    );
    expect(outcome.status).toBe("applied");
    expect(await readFile(join(watched, "a.txt"), "utf8")).toBe("restored");
  });
});

describe("journal replay: boot-time containment (no UI required to reach it)", () => {
  const entry = (src: string, dst: string | null, phase: string) =>
    [{ op: "move", src, dst, quarantineId: null, phase }] as never[];

  test("an out-of-anchor src is REFUSED and the file survives", async () => {
    const victim = join(root, "outside", "victim.txt");
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(victim, "victim");
    const journalPath = join(dataDir, "journal.json");
    // `copy-done` ⇒ the replay's job is to unlink the src. Unanchored,
    // that is an arbitrary delete at server boot.
    await _applierInternals.writeJournal(journalPath, entry(victim, join(watched, "victim.txt"), "copy-done"));
    const res = await replayJournal(journalPath, { roots: [watched], dataDirRoot: dataDir });
    expect(res).toEqual({ finished: 0, rolledBack: 0, refused: 1 });
    expect(await readFile(victim, "utf8")).toBe("victim");
    // Still cleared — a refused entry must not be retried next boot.
    expect(await _applierInternals.readJournal(journalPath)).toHaveLength(0);
  });

  test("an out-of-anchor dst is REFUSED (copy-pending never rm's it)", async () => {
    const victim = join(root, "outside", "victim.txt");
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(victim, "victim");
    const src = join(watched, "a.txt");
    await writeFile(src, "a");
    const journalPath = join(dataDir, "journal.json");
    await _applierInternals.writeJournal(journalPath, entry(src, victim, "copy-pending"));
    const res = await replayJournal(journalPath, { roots: [watched], dataDirRoot: dataDir });
    expect(res).toEqual({ finished: 0, rolledBack: 0, refused: 1 });
    expect(await readFile(victim, "utf8")).toBe("victim");
  });

  test("EMPTY anchors refuse everything (a journal we cannot anchor is not replayed)", async () => {
    const src = join(watched, "a.txt");
    await writeFile(src, "a");
    const journalPath = join(dataDir, "journal.json");
    await _applierInternals.writeJournal(journalPath, entry(src, join(watched, "sub", "a.txt"), "copy-done"));
    const res = await replayJournal(journalPath, { roots: [], dataDirRoot: dataDir });
    expect(res).toEqual({ finished: 0, rolledBack: 0, refused: 1 });
    expect(await readFile(src, "utf8")).toBe("a");
  });

  test("an in-anchor src inside .ezcorp/data is REFUSED", async () => {
    const dbFile = join(root, ".ezcorp", "data", "ez-corp-db");
    await mkdir(join(root, ".ezcorp", "data"), { recursive: true });
    await writeFile(dbFile, "PGDATA");
    const journalPath = join(dataDir, "journal.json");
    await _applierInternals.writeJournal(journalPath, entry(dbFile, join(root, "x.txt"), "copy-done"));
    // Anchor on the project root so only the protected-dir deny can refuse.
    const res = await replayJournal(journalPath, { roots: [root], dataDirRoot: dataDir });
    expect(res).toEqual({ finished: 0, rolledBack: 0, refused: 1 });
    expect(await readFile(dbFile, "utf8")).toBe("PGDATA");
  });

  test("an in-anchor copy-done still finishes the unlink", async () => {
    const src = join(watched, "a.txt");
    const dst = join(watched, "sub", "a.txt");
    await mkdir(join(watched, "sub"), { recursive: true });
    await writeFile(src, "data");
    await writeFile(dst, "data");
    const journalPath = join(dataDir, "journal.json");
    await _applierInternals.writeJournal(journalPath, entry(src, dst, "copy-done"));
    const res = await replayJournal(journalPath, { roots: [watched], dataDirRoot: dataDir });
    expect(res).toEqual({ finished: 1, rolledBack: 0, refused: 0 });
    expect(await _applierInternals.pathExists(src)).toBe(false);
    expect(await readFile(dst, "utf8")).toBe("data");
  });

  test("an in-anchor copy-pending still rolls the partial dst back", async () => {
    const src = join(watched, "a.txt");
    const dst = join(watched, "sub", "a.txt");
    await mkdir(join(watched, "sub"), { recursive: true });
    await writeFile(src, "data");
    await writeFile(dst, "partial");
    const journalPath = join(dataDir, "journal.json");
    await _applierInternals.writeJournal(journalPath, entry(src, dst, "copy-pending"));
    const res = await replayJournal(journalPath, { roots: [watched], dataDirRoot: dataDir });
    expect(res).toEqual({ finished: 0, rolledBack: 1, refused: 0 });
    expect(await readFile(src, "utf8")).toBe("data");
    expect(await _applierInternals.pathExists(dst)).toBe(false);
  });
});

describe("daemon: fail-closed on unset EZCORP_PROJECT_ROOT (host-side data dir)", () => {
  // The daemon is constructed with an explicit dataDir by the host wiring;
  // the host wiring (background-timers.ts) only constructs the daemon AFTER
  // resolving getProjectRoot(). This test documents the invariant that the
  // daemon never invents a data dir from a bare cwd: given a dataDir that
  // doesn't exist, a tick is a safe no-op (no config ⇒ no folders ⇒ nothing
  // moves), never a crash or a mass-action.
  test("a non-existent data dir ⇒ tick is a safe no-op", async () => {
    const ghostDir = join(root, "nonexistent-data");
    const d = new FileOrganizerDaemon({
      dataDir: ghostDir,
      engine: fakeEngine("allow"),
      extensionId: "ext-fo",
      getSettings: async () => ({ ...DEFAULT_SETTINGS, stabilityTicks: 1 }),
      skipLockfile: true,
    });
    const result = await d.tick();
    expect(result).toEqual({ generated: 0, applied: 0, pruned: 0 });
  });
});

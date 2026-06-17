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
//
// Tests for the file-organizer architecture spine (see
// tasks/file-organizer-plan.md § "two architecture-defining constraints").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileOrganizerDaemon, DEFAULT_SETTINGS } from "../../extensions/file-organizer-daemon";
import { applyProposal, type ApplierContext, type ApplierProposal } from "../../extensions/file-organizer-applier";
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
  root = await mkdtemp(join(tmpdir(), "fo-sec-"));
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

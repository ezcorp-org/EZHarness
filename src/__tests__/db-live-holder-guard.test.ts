/**
 * Unit tests for the PGlite datadir live-holder guard
 * (`src/db/live-holder-guard.ts`): sidecar pidfile read/claim/release and
 * the live-vs-stale decision that stops `ezcorp key mint` (or any second
 * EZCorp process) from opening a datadir a running server holds.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DbInUseError,
  assertNoLiveHolder,
  claimHolder,
  holderPidPath,
  isLiveHolder,
  readHolderPid,
  releaseHolder,
} from "../db/live-holder-guard";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ezcorp-holder-guard-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "db");
}

/** A pid that is guaranteed dead: spawn a no-op process and wait for exit. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

describe("holderPidPath", () => {
  test("is a SIBLING of the datadir, never inside it", () => {
    expect(holderPidPath("/data/ezcorp")).toBe("/data/ezcorp.ezcorp.pid");
  });
});

describe("readHolderPid", () => {
  test("null when the sidecar file is absent", () => {
    expect(readHolderPid(tempDbPath())).toBeNull();
  });

  test("null for garbage or non-positive contents", () => {
    const db = tempDbPath();
    writeFileSync(holderPidPath(db), "not-a-pid");
    expect(readHolderPid(db)).toBeNull();
    // PGlite's own postmaster.pid records -42; a copied-in negative pid
    // must never be treated as a holder.
    writeFileSync(holderPidPath(db), "-42");
    expect(readHolderPid(db)).toBeNull();
  });

  test("parses a recorded pid (tolerating whitespace)", () => {
    const db = tempDbPath();
    writeFileSync(holderPidPath(db), ` ${process.pid}\n`);
    expect(readHolderPid(db)).toBe(process.pid);
  });
});

describe("assertNoLiveHolder", () => {
  test("passes with no claim, our own claim, or a dead holder", async () => {
    const db = tempDbPath();
    expect(() => assertNoLiveHolder(db)).not.toThrow();

    writeFileSync(holderPidPath(db), String(process.pid));
    expect(() => assertNoLiveHolder(db)).not.toThrow();

    // Unclean shutdown (SIGKILL) leaves a stale claim — must self-heal.
    writeFileSync(holderPidPath(db), String(await deadPid()));
    expect(() => assertNoLiveHolder(db)).not.toThrow();
  });

  test("throws DbInUseError for a LIVE bun holder, with remediation", async () => {
    const db = tempDbPath();
    // A real, live bun process — exactly what a running EZCorp server is.
    const child = Bun.spawn(["bun", "-e", "await Bun.sleep(30_000)"]);
    cleanups.push(() => child.kill());
    // Right after spawn (pre-exec) /proc/<pid>/cmdline is briefly empty;
    // wait until the kernel exposes the real argv before asserting.
    for (let i = 0; i < 50; i++) {
      const cmdline = await Bun.file(`/proc/${child.pid}/cmdline`).text().catch(() => "");
      if (cmdline.includes("bun")) break;
      await Bun.sleep(100);
    }
    writeFileSync(holderPidPath(db), String(child.pid));
    let caught: unknown;
    try {
      assertNoLiveHolder(db);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DbInUseError);
    const err = caught as DbInUseError;
    expect(err.name).toBe("DbInUseError");
    expect(err.message).toContain(db);
    expect(err.message).toContain(`pid ${child.pid}`);
    expect(err.message).toContain(holderPidPath(db));
    expect(err.message).toContain("single-writer");
  });

  test("a recycled pid belonging to a NON-ezcorp process is treated as stale", async () => {
    const db = tempDbPath();
    // A live process whose cmdline is not bun/ezcorp — models pid recycling
    // after a container restart. Refusing here would crash-loop the server.
    const child = Bun.spawn(["sleep", "30"]);
    cleanups.push(() => child.kill());
    writeFileSync(holderPidPath(db), String(child.pid));
    expect(() => assertNoLiveHolder(db)).not.toThrow();
  });
});

describe("isLiveHolder", () => {
  test("dead pid is never a live holder", async () => {
    expect(isLiveHolder(await deadPid())).toBe(false);
  });

  test("alive pid with unreadable cmdline counts as live (conservative)", () => {
    // procRoot pointing at an empty dir makes the cmdline read throw for
    // ANY pid — the guard must then assume a real holder rather than risk
    // opening a datadir something else may hold.
    const emptyProc = tempDbPath(); // just a fresh temp path; no /<pid> inside
    expect(isLiveHolder(process.pid, emptyProc)).toBe(true);
  });
});

describe("claimHolder / releaseHolder", () => {
  test("claim records our pid; release removes only our own claim", () => {
    const db = tempDbPath();
    claimHolder(db);
    expect(readFileSync(holderPidPath(db), "utf8")).toBe(String(process.pid));

    releaseHolder(db);
    expect(readHolderPid(db)).toBeNull();
  });

  test("release leaves a foreign claim untouched", () => {
    const db = tempDbPath();
    writeFileSync(holderPidPath(db), "1");
    releaseHolder(db);
    expect(readHolderPid(db)).toBe(1);
  });

  test("release of a missing claim is a no-op", () => {
    expect(() => releaseHolder(tempDbPath())).not.toThrow();
  });

  test("claim degrades silently when the sidecar is unwritable", () => {
    // Nonexistent parent directory → writeFileSync throws → swallowed:
    // the guard must never take the DB down over a pidfile write.
    const db = join(tmpdir(), "ezcorp-holder-guard-missing", "nested", "db");
    expect(() => claimHolder(db)).not.toThrow();
  });

  test("release swallows an rm failure on a read-only parent", () => {
    const parent = mkdtempSync(join(tmpdir(), "ezcorp-holder-guard-ro-"));
    cleanups.push(() => {
      chmodSync(parent, 0o755);
      rmSync(parent, { recursive: true, force: true });
    });
    const db = join(parent, "db");
    mkdirSync(db);
    claimHolder(db);
    chmodSync(parent, 0o555);
    expect(() => releaseHolder(db)).not.toThrow();
    chmodSync(parent, 0o755);
    expect(readHolderPid(db)).toBe(process.pid);
  });
});

import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, readFile, unlink, mkdtemp } from "node:fs/promises";
import {
  acquireLockfile,
  releaseLockfile,
  isProcessAlive,
  readProcStartTime,
  selfToken,
  parseLock,
  isLiveSibling,
} from "../startup/process-lockfile";

// ── isProcessAlive ─────────────────────────────────────────────────
describe("isProcessAlive", () => {
  test("own PID is alive; zero/negative/NaN/huge are not", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(NaN)).toBe(false);
    // Above the typical Linux pid_max — effectively never live.
    expect(isProcessAlive(2 ** 31 - 1)).toBe(false);
  });
});

// ── readProcStartTime / selfToken ──────────────────────────────────
describe("readProcStartTime / selfToken", () => {
  test("returns a non-empty start-time for our own live PID (procfs host)", () => {
    // CI + the dev container are Linux with procfs; assert the happy path.
    const st = readProcStartTime(process.pid);
    expect(st).not.toBe("");
    expect(/^\d+$/.test(st)).toBe(true);
  });

  test("returns '' for a bogus / dead PID", () => {
    expect(readProcStartTime(0)).toBe("");
    expect(readProcStartTime(-5)).toBe("");
    expect(readProcStartTime(2 ** 31 - 1)).toBe("");
  });

  test("selfToken matches our own /proc start-time", () => {
    expect(selfToken()).toBe(readProcStartTime(process.pid));
  });
});

// ── parseLock ──────────────────────────────────────────────────────
describe("parseLock", () => {
  test("tokenized form '<pid> <token>'", () => {
    expect(parseLock("123 abc-def")).toEqual({ pid: 123, token: "abc-def" });
  });
  test("legacy bare-PID form '<pid>' yields empty token", () => {
    expect(parseLock("456")).toEqual({ pid: 456, token: "" });
  });
  test("whitespace + trailing newline tolerated", () => {
    expect(parseLock("  789   tok \n")).toEqual({ pid: 789, token: "tok" });
  });
  test("empty / non-numeric returns null", () => {
    expect(parseLock("")).toBeNull();
    expect(parseLock("   ")).toBeNull();
    expect(parseLock("not-a-pid")).toBeNull();
  });
});

// ── isLiveSibling (pure decision) ──────────────────────────────────
describe("isLiveSibling", () => {
  const aliveAll = () => true;
  const deadAll = () => false;

  test("dead stored PID ⇒ NOT a sibling (stale, reclaim)", () => {
    expect(
      isLiveSibling({ pid: 999, token: "t" }, 1, "self", deadAll, () => "t"),
    ).toBe(false);
  });

  test("self-PID (reused on restart) ⇒ NOT a sibling (reclaim) even with a different token", () => {
    // THE restart self-deadlock case: the new boot reuses the prior PID.
    expect(
      isLiveSibling({ pid: 42, token: "old-boot" }, 42, "new-boot", aliveAll, () => "new-boot"),
    ).toBe(false);
  });

  test("live foreign PID with a MATCHING token ⇒ genuine sibling (refuse)", () => {
    expect(
      isLiveSibling({ pid: 7, token: "match" }, 1, "self", aliveAll, () => "match"),
    ).toBe(true);
  });

  test("live foreign PID with a MISMATCHED token (PID reused) ⇒ NOT a sibling (reclaim)", () => {
    expect(
      isLiveSibling({ pid: 7, token: "stored-old" }, 1, "self", aliveAll, () => "live-new"),
    ).toBe(false);
  });

  test("legacy bare-PID (token '') + live foreign PID ⇒ NOT a sibling (reclaim)", () => {
    // A tokenless file is from old code / a prior boot; a genuine sibling
    // running this code always stamps a token. Reclaim to avoid the
    // cross-restart self-deadlock on a coincidentally-live reused PID.
    expect(
      isLiveSibling({ pid: 7, token: "" }, 1, "self", aliveAll, () => "anything"),
    ).toBe(false);
  });

  test("tokenized lock but live token unrecomputable ('') ⇒ NOT a sibling (reclaim)", () => {
    // Can't confirm the PID wasn't reused → reclaim rather than wedge.
    expect(
      isLiveSibling({ pid: 7, token: "stored" }, 1, "self", aliveAll, () => ""),
    ).toBe(false);
  });
});

// ── acquire / release against a real lockfile ──────────────────────
describe("acquireLockfile / releaseLockfile", () => {
  async function tmpLock(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ezcorp-lock-"));
    return join(dir, name);
  }

  test("a fresh (absent) lockfile is acquired and stamped '<pid> <token>'", async () => {
    const lock = await tmpLock("fresh.pid");
    expect(await acquireLockfile(lock)).toBe(true);
    const body = (await readFile(lock, "utf8")).trim();
    const parsed = parseLock(body);
    expect(parsed!.pid).toBe(process.pid);
    expect(parsed!.token).toBe(selfToken());
    await unlink(lock).catch(() => {});
  });

  test("RECLAIM: a stale lockfile holding OUR OWN pid with a different token is reclaimed (restart fix)", async () => {
    // Simulate a `.pid` left by a prior boot whose PID got reused as ours.
    const lock = await tmpLock("self-stale.pid");
    await writeFile(lock, `${process.pid} stale-prior-boot-token`);
    // Old behavior: refused ("sibling alive"). New behavior: reclaims.
    expect(await acquireLockfile(lock)).toBe(true);
    const parsed = parseLock((await readFile(lock, "utf8")).trim());
    expect(parsed!.pid).toBe(process.pid);
    expect(parsed!.token).toBe(selfToken()); // re-stamped with our live token
    await unlink(lock).catch(() => {});
  });

  test("RECLAIM: a stale lockfile holding a dead PID is reclaimed", async () => {
    const lock = await tmpLock("dead.pid");
    await writeFile(lock, `2147483646 some-old-token`);
    expect(await acquireLockfile(lock)).toBe(true);
    expect(parseLock((await readFile(lock, "utf8")).trim())!.pid).toBe(process.pid);
    await unlink(lock).catch(() => {});
  });

  test("RECLAIM: a garbage (non-numeric) lockfile is reclaimed", async () => {
    const lock = await tmpLock("garbage.pid");
    await writeFile(lock, "not-a-pid-at-all");
    expect(await acquireLockfile(lock)).toBe(true);
    await unlink(lock).catch(() => {});
  });

  test("RECLAIM: a foreign live PID whose token no longer matches (reused) is reclaimed", async () => {
    // PID 1 is always alive on Linux. Store its CURRENT start-time but mutate
    // it so the live recompute won't match → simulates PID reuse → reclaim.
    const lock = await tmpLock("reused.pid");
    const realToken = readProcStartTime(1);
    expect(realToken).not.toBe(""); // procfs present
    await writeFile(lock, `1 ${realToken}-MUTATED`);
    expect(await acquireLockfile(lock)).toBe(true);
    await unlink(lock).catch(() => {});
  });

  test("REFUSE: a genuine live sibling (foreign PID, matching token) blocks acquisition", async () => {
    // PID 1 is alive; stamp its REAL current start-time → the recompute
    // matches → genuine sibling → refuse. PID 1 is never our own pid.
    const lock = await tmpLock("sibling.pid");
    const realToken = readProcStartTime(1);
    expect(realToken).not.toBe("");
    await writeFile(lock, `1 ${realToken}`);
    expect(await acquireLockfile(lock)).toBe(false);
    // The live lock is left untouched.
    expect((await readFile(lock, "utf8")).trim()).toBe(`1 ${realToken}`);
    await unlink(lock).catch(() => {});
  });

  test("RECLAIM: a legacy bare-PID lockfile (no token) is reclaimed even when its PID is live", async () => {
    // The cross-restart/upgrade case: an old-format `.pid` left by a prior
    // boot whose bare PID is now a coincidentally-live process must NOT wedge
    // start — a real sibling on this code always stamps a token.
    const lock = await tmpLock("legacy.pid");
    await writeFile(lock, "1"); // bare PID 1, no token
    expect(await acquireLockfile(lock)).toBe(true);
    expect(parseLock((await readFile(lock, "utf8")).trim())!.pid).toBe(process.pid);
    await unlink(lock).catch(() => {});
  });

  test("releaseLockfile removes the file and is idempotent", async () => {
    const lock = await tmpLock("release.pid");
    await writeFile(lock, `${process.pid} ${selfToken()}`);
    await releaseLockfile(lock);
    expect(await Bun.file(lock).exists()).toBe(false);
    // No throw on an already-gone lock.
    await releaseLockfile(lock);
    expect(await Bun.file(lock).exists()).toBe(false);
  });

  test("acquire then release then re-acquire round-trips cleanly", async () => {
    const lock = await tmpLock("roundtrip.pid");
    expect(await acquireLockfile(lock)).toBe(true);
    await releaseLockfile(lock);
    expect(await Bun.file(lock).exists()).toBe(false);
    expect(await acquireLockfile(lock)).toBe(true);
    await unlink(lock).catch(() => {});
  });
});
